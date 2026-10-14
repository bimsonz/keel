// Connecting a project's deploy target to a Cloudflare account through its
// consent screen, as the begin and complete use-cases do it: the Connect held
// by the project's object under its owner, taken once, the code exchanged with
// its verifier, exactly one account, a token minted on it and sealed, and the
// target set with that token. Every port is in memory, Cloudflare's OAuth too.
import { describe, expect, it } from "@effect/vitest";
import {
  beginCloudflareConnect,
  completeCloudflareConnect,
  type CompleteCloudflareConnect,
  MINTED_SETTLE_RETRIES,
} from "@keeltown/core/application/delivery";
import {
  CONNECT_WINDOW_MS,
  DeployTargetName,
  DeployTargetUnreachable,
  type GrantedAccount,
} from "@keeltown/core/domain/delivery";
import { makeId } from "@keeltown/core/kernel";
import { CredentialStore, DeployTargets } from "@keeltown/core/ports";
import {
  type CloudflareOAuthScript,
  makeCloudflareOAuthMemory,
  makeCredentialStoreMemory,
  makeDeployTargetCheckMemory,
  makeDeployTargetsMemory,
} from "@keeltown/testing";
import { Effect, Exit, Fiber, Layer, Redacted, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

const ORG = makeId("org", "01M4P00000000000000000000A");
const PROJECT = makeId("prj", "01M4P00000000000000000000P");
const OWNER = makeId("usr", "01M4P00000000000000000000S");
const STRANGER = makeId("usr", "01M4P00000000000000000000T");
const ACME: GrantedAccount = { id: "0123456789abcdef0123456789abcdef", name: "Acme" };
const OTHER: GrantedAccount = { id: "fedcba9876543210fedcba9876543210", name: "Other" };
const production = Schema.decodeSync(DeployTargetName)("production");

/** One test's world: an established project and every port the two use-cases ask. */
function world(
  script: CloudflareOAuthScript = {},
  answer?: Parameters<typeof makeDeployTargetCheckMemory>[0],
) {
  const oauth = makeCloudflareOAuthMemory(script);
  const check = makeDeployTargetCheckMemory(answer);
  const targets = makeDeployTargetsMemory();
  targets.establish(PROJECT);
  const layer = Layer.mergeAll(
    oauth.layer,
    check.layer,
    targets.layer,
    makeCredentialStoreMemory().layer,
  );
  return { oauth, check, layer };
}

/** The owner's state from a consent URL the memory OAuth wrote: `state=<project>.<nonce>`. */
const nonceOf = (url: string) => new URL(url).searchParams.get("state")?.split(".")[1] ?? "";

const begin = (by = OWNER) =>
  beginCloudflareConnect({ projectId: PROJECT, target: production, by });

/** Coming back from consent: the memory OAuth's code for a verifier is `code-<verifier>`. */
const complete = (nonce: string, fields: Partial<CompleteCloudflareConnect> = {}) =>
  completeCloudflareConnect({
    projectId: PROJECT,
    namespaceId: ORG,
    handle: "acme",
    project: "worker-lite",
    by: OWNER,
    nonce,
    code: "code-verifier-1",
    requestId: crypto.randomUUID(),
    ...fields,
  });

/** The error a failed exit holds, as plain data, or `succeeded`. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit) ? "succeeded" : JSON.parse(JSON.stringify(exit.cause.reasons[0])).error;

describe("connecting a Cloudflare account", () => {
  it.effect(
    "[connect.complete] the code is exchanged with its verifier, a Workers token is minted on the one account and sealed, and the target is set with it",
    () => {
      const { oauth, check, layer } = world();
      return Effect.gen(function* () {
        const url = yield* begin();
        const held = yield* complete(nonceOf(url));
        expect(oauth.exchanged).toEqual([{ code: "code-verifier-1", verifier: "verifier-1" }]);
        expect(oauth.minted).toEqual([
          {
            access: "access-verifier-1",
            accountId: ACME.id,
            name: "Keel deploys: acme/worker-lite",
          },
        ]);
        expect(held.target).toMatchObject({
          name: "production",
          provider: "cloudflare",
          accountId: ACME.id,
        });
        expect(held.workersDev).toBe("memory.workers.dev");
        const store = yield* CredentialStore;
        const [credential, ...more] = yield* store.list(ORG);
        expect(more).toEqual([]);
        expect(credential).toMatchObject({
          id: held.target.credential,
          label: "Keel deploys: acme/worker-lite",
          provider: "cloudflare",
          createdBy: OWNER,
        });
        // What is sealed, and what the account was asked with, is the minted token: never the consent's.
        const sealed = Redacted.value(yield* store.reveal(ORG, held.target.credential));
        expect(sealed).toBe(`minted-${ACME.id}-1`);
        expect(check.asked).toEqual([{ accountId: ACME.id, secret: sealed }]);
        expect(yield* DeployTargets.use((targets) => targets.list(PROJECT))).toEqual([held]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[connect.once] a state finishes one Connect: the same callback again is refused and nothing more is exchanged",
    () => {
      const { oauth, layer } = world();
      return Effect.gen(function* () {
        const nonce = nonceOf(yield* begin());
        yield* complete(nonce);
        const again = yield* Effect.exit(complete(nonce));
        expect(failureOf(again)).toMatchObject({ _tag: "ConnectStateRefused", reason: "none" });
        expect(oauth.exchanged).toHaveLength(1);
        expect(oauth.minted).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[connect.owner] another person coming back with the owner's state finishes nothing, and Cloudflare is not asked",
    () => {
      const { oauth, layer } = world();
      return Effect.gen(function* () {
        const nonce = nonceOf(yield* begin());
        const stranger = yield* Effect.exit(complete(nonce, { by: STRANGER }));
        expect(failureOf(stranger)).toMatchObject({ _tag: "ConnectStateRefused", reason: "none" });
        expect(oauth.exchanged).toEqual([]);
        // The owner's own Connect is still there for them.
        yield* complete(nonce);
        expect(oauth.minted).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[connect.window] a Connect lapses ten minutes after it began, by the project's object's clock",
    () => {
      const { oauth, layer } = world();
      return Effect.gen(function* () {
        const first = nonceOf(yield* begin());
        yield* TestClock.adjust(CONNECT_WINDOW_MS - 1);
        yield* complete(first);
        const second = nonceOf(yield* begin());
        yield* TestClock.adjust(CONNECT_WINDOW_MS);
        const late = yield* Effect.exit(complete(second, { code: "code-verifier-2" }));
        expect(failureOf(late)).toMatchObject({ _tag: "ConnectStateRefused", reason: "expired" });
        expect(oauth.exchanged).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[connect.one-account] a consent that granted no account, or two, is refused before anything is minted or stored",
    () =>
      Effect.gen(function* () {
        for (const accounts of [[], [ACME, OTHER]]) {
          const { oauth, check, layer } = world({ accounts });
          const answer = yield* Effect.gen(function* () {
            const nonce = nonceOf(yield* begin());
            const exit = yield* Effect.exit(complete(nonce));
            return { exit, stored: yield* CredentialStore.use((store) => store.list(ORG)) };
          }).pipe(Effect.provide(layer));
          expect(failureOf(answer.exit)).toMatchObject({
            _tag: "ConnectAccountsRefused",
            granted: accounts.length,
          });
          expect(oauth.minted).toEqual([]);
          expect(answer.stored).toEqual([]);
          expect(check.asked).toEqual([]);
        }
      }),
  );

  it.effect(
    "[connect.unconfigured] with no OAuth client registered, nothing is held and begin says so",
    () => {
      const { layer } = world({ refuses: "unconfigured" });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(begin());
        expect(failureOf(exit)).toMatchObject({
          _tag: "CloudflareConnectFailed",
          step: "unconfigured",
        });
        const taken = yield* Effect.exit(
          DeployTargets.use((targets) =>
            targets.takeConnect({ projectId: PROJECT, by: OWNER, nonce: "n".repeat(43) }),
          ),
        );
        expect(failureOf(taken)).toMatchObject({ _tag: "ConnectStateRefused", reason: "none" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[connect.unreachable] an account with no workers.dev subdomain, asked again for a few seconds, sets no target, and the minted token stays stored for the next try",
    () => {
      let asked = 0;
      const { layer } = world({}, () => {
        asked += 1;
        return Result.fail(new DeployTargetUnreachable({ reason: "no-workers-dev", code: 10_007 }));
      });
      return Effect.gen(function* () {
        const running = yield* Effect.forkChild(complete(nonceOf(yield* begin())));
        yield* TestClock.adjust("30 seconds");
        const exit = yield* Fiber.await(running);
        expect(failureOf(exit)).toMatchObject({
          _tag: "DeployTargetUnreachable",
          reason: "no-workers-dev",
        });
        expect(asked).toBe(1 + MINTED_SETTLE_RETRIES);
        expect(yield* DeployTargets.use((targets) => targets.list(PROJECT))).toEqual([]);
        expect(yield* CredentialStore.use((store) => store.list(ORG))).toMatchObject([
          { label: "Keel deploys: acme/worker-lite" },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[connect.settle] a token Cloudflare has just made that does not answer at once is asked again, and the target is set when it does",
    () => {
      let asked = 0;
      const { layer } = world({}, () => {
        asked += 1;
        return asked < 3
          ? Result.fail(new DeployTargetUnreachable({ reason: "no-workers-dev", code: 10_007 }))
          : Result.succeed({ workersDev: "acme.workers.dev" });
      });
      return Effect.gen(function* () {
        const running = yield* Effect.forkChild(complete(nonceOf(yield* begin())));
        yield* TestClock.adjust("30 seconds");
        const held = yield* Fiber.join(running);
        expect(asked).toBe(3);
        expect(held.workersDev).toBe("acme.workers.dev");
        expect(yield* DeployTargets.use((targets) => targets.list(PROJECT))).toEqual([held]);
      }).pipe(Effect.provide(layer));
    },
  );
});
