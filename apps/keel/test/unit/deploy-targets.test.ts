// A project's deploy targets as the putDeployTarget use-case sets them: the
// credential's namespace read first, the account asked only for a credential
// of the project's own namespace, and the Project DO's own commit deciding
// over the targets it holds. Every port is in memory; the DeployTargets port
// runs the DO's use-cases over an in-memory store per project.
import {
  listDeployTargets,
  putDeployTarget,
  removeDeployTarget,
} from "@keeltown/core/application/delivery";
import {
  CredentialLabel,
  type DeployTarget,
  DeployTargetName,
  DeployTargetUnreachable,
  MAX_DEPLOY_TARGETS,
} from "@keeltown/core/domain/delivery";
import {
  type CredentialId,
  makeId,
  type NamespaceId,
  type ProjectId,
  type UserId,
} from "@keeltown/core/kernel";
import { CredentialStore, type DeployTargetCheck, type DeployTargets } from "@keeltown/core/ports";
import {
  makeCredentialStoreMemory,
  makeDeployTargetCheckMemory,
  makeDeployTargetsMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Redacted, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

const ORG = makeId("org", "01M4P00000000000000000000A");
const OTHER = makeId("org", "01M4P00000000000000000000B");
const PROJECT = makeId("prj", "01M4P00000000000000000000P");
const OWNER = makeId("usr", "01M4P00000000000000000000S");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SECRET = "a-cloudflare-token";
const name = Schema.decodeSync(DeployTargetName);
const label = Schema.decodeSync(CredentialLabel);

/** One test's world: an established project, a credential store, an account check and the targets' port. */
function world(answer?: Parameters<typeof makeDeployTargetCheckMemory>[0]) {
  const credentials = makeCredentialStoreMemory();
  const revealed: CredentialId[] = [];
  const counted = Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const inner = yield* CredentialStore;
      return CredentialStore.of({
        ...inner,
        reveal: (namespaceId, id) => {
          revealed.push(id);
          return inner.reveal(namespaceId, id);
        },
      });
    }),
  ).pipe(Layer.provide(credentials.layer));
  const check = makeDeployTargetCheckMemory(answer);
  const targets = makeDeployTargetsMemory();
  targets.establish(PROJECT);
  const layer = Layer.mergeAll(counted, check.layer, targets.layer);
  const exit = <A, E>(
    program: Effect.Effect<A, E, CredentialStore | DeployTargetCheck | DeployTargets>,
  ) => Effect.runPromiseExit(program.pipe(Effect.provide(layer)));
  const store = (namespace: NamespaceId) =>
    exit(
      CredentialStore.use((held) =>
        held.put(namespace, {
          label: label("ci"),
          provider: "cloudflare",
          secret: Redacted.make(SECRET),
          by: OWNER,
        }),
      ),
    ).then((stored) => {
      if (Exit.isFailure(stored)) throw new Error("the credential was not stored");
      return stored.value.id;
    });
  const put = (target: DeployTarget, requestId = crypto.randomUUID()) =>
    exit(putDeployTarget({ projectId: PROJECT, namespaceId: ORG, target, by: OWNER, requestId }));
  const listed = () =>
    exit(listDeployTargets(PROJECT)).then((read) =>
      Exit.isSuccess(read) ? read.value.map((held) => held.target.name) : read,
    );
  return { revealed, check, targets, exit, store, put, listed };
}

const target = (credential: CredentialId, named = "preview"): DeployTarget => ({
  name: name(named),
  provider: "cloudflare",
  accountId: ACCOUNT,
  credential,
});

/** The failure's tag and reason, or the success. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit) ? "succeeded" : JSON.parse(JSON.stringify(exit.cause.reasons[0]));

describe("putDeployTarget", () => {
  it("[target.use-case-set] a credential of the project's own namespace that reaches its account sets the target, with the account's workers.dev subdomain beside it", async () => {
    const w = world();
    const credential = await w.store(ORG);
    const set = await w.put(target(credential), "req-set");
    expect(Exit.isSuccess(set) ? set.value : set).toEqual({
      target: target(credential),
      workersDev: "memory.workers.dev",
    });
    expect(w.check.asked).toEqual([{ accountId: ACCOUNT, secret: SECRET }]);
    expect(await w.listed()).toEqual(["preview"]);
    const committed = w.targets
      .outbox(PROJECT)
      .committed({ kind: "project", id: PROJECT }, "deploy-target:req-set");
    expect(committed?.events.map((event) => event.payload)).toEqual([
      {
        _tag: "DeployTargetSet",
        projectId: PROJECT,
        target: { name: "preview", provider: "cloudflare", accountId: ACCOUNT, credential },
        by: OWNER,
      },
    ]);
  });

  it("[target.use-case-credential-in-org] a credential of another namespace is refused before its secret is opened or any account is asked", async () => {
    const w = world();
    const theirs = await w.store(OTHER);
    const refused = await w.put(target(theirs));
    expect(failureOf(refused)).toMatchObject({
      error: { _tag: "DeployTargetRefused", reason: "credential-not-in-org" },
    });
    expect(w.revealed).toEqual([]);
    expect(w.check.asked).toEqual([]);
    expect(await w.listed()).toEqual([]);
  });

  it("[target.use-case-unreachable] an account the credential does not reach commits nothing", async () => {
    const w = world(() =>
      Result.fail(new DeployTargetUnreachable({ reason: "token-invalid", code: 9109 })),
    );
    const credential = await w.store(ORG);
    const refused = await w.put(target(credential));
    expect(failureOf(refused)).toMatchObject({
      error: { _tag: "DeployTargetUnreachable", reason: "token-invalid", code: 9109 },
    });
    expect(await w.listed()).toEqual([]);
  });

  it("[target.use-case-cap] a project at its cap refuses a new name, and still takes one already there", async () => {
    const w = world();
    const credential = await w.store(ORG);
    for (let i = 0; i < MAX_DEPLOY_TARGETS; i += 1)
      expect(Exit.isSuccess(await w.put(target(credential, `t${i}`)))).toBe(true);
    expect(failureOf(await w.put(target(credential, "one-more")))).toMatchObject({
      error: { _tag: "DeployTargetRefused", reason: "too-many-targets" },
    });
    expect(Exit.isSuccess(await w.put(target(credential, "t0")))).toBe(true);
  });

  it("[target.use-case-replay] the same request again answers as it did, and the same request id with another target is IdempotencyConflict", async () => {
    const w = world();
    const credential = await w.store(ORG);
    const first = await w.put(target(credential), "req-1");
    expect(Exit.isSuccess(first)).toBe(true);
    expect(await w.put(target(credential), "req-1")).toEqual(first);
    expect(failureOf(await w.put(target(credential, "other"), "req-1"))).toMatchObject({
      error: { _tag: "IdempotencyConflict" },
    });
  });

  it("[target.use-case-project] a project its object never created is ProjectNotFound", async () => {
    const w = world();
    const credential = await w.store(ORG);
    const elsewhere: ProjectId = makeId("prj", "01M4P00000000000000000000Q");
    const missing = await w.exit(
      putDeployTarget({
        projectId: elsewhere,
        namespaceId: ORG,
        target: target(credential),
        by: OWNER,
        requestId: "req-2",
      }),
    );
    expect(failureOf(missing)).toMatchObject({ error: { _tag: "ProjectNotFound" } });
  });

  it("[target.use-case-clear] clearing a target takes it out of the list, and clearing one not set is refused not-set", async () => {
    const w = world();
    const credential = await w.store(ORG);
    await w.put(target(credential));
    const by: UserId = OWNER;
    const clear = () =>
      w.exit(
        removeDeployTarget({
          projectId: PROJECT,
          name: name("preview"),
          by,
          requestId: crypto.randomUUID(),
        }),
      );
    expect(Exit.isSuccess(await clear())).toBe(true);
    expect(await w.listed()).toEqual([]);
    expect(failureOf(await clear())).toMatchObject({
      error: { _tag: "DeployTargetRefused", reason: "not-set" },
    });
  });
});
