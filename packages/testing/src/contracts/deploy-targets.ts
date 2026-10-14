import { describe, expect, it } from "@effect/vitest";
import { type DeployTarget, DeployTargetName } from "@keeltown/core/domain/delivery";
import { CredentialId, ProjectId, UserId } from "@keeltown/core/kernel";
import {
  DeployTargets,
  type HoldProjectConnect,
  type SetProjectDeployTarget,
} from "@keeltown/core/ports";
import { Effect, Exit, type Layer, Schema } from "effect";

/** What the `DeployTargets` suite needs beside the port: a way to create a project, as createProject does. */
export interface DeployTargetsHarness {
  readonly layer: Layer.Layer<DeployTargets>;
  readonly establish: (projectId: ProjectId) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

/** A project no case has used: a real adapter's objects outlive one case. */
const freshProject = () => Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
const owner = Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);
const credential = Schema.decodeUnknownSync(CredentialId)(`crd_${ulid()}`);
const name = Schema.decodeUnknownSync(DeployTargetName);

const target = (named: string, accountId = "0123456789abcdef0123456789abcdef"): DeployTarget => ({
  name: name(named),
  provider: "cloudflare",
  accountId,
  credential,
});

const setting = (
  projectId: ProjectId,
  set: DeployTarget,
  fields: Partial<SetProjectDeployTarget> = {},
): SetProjectDeployTarget => ({
  projectId,
  target: set,
  by: owner,
  credentialInOrg: true,
  workersDev: "acme.workers.dev",
  requestId: crypto.randomUUID(),
  ...fields,
});

const other = Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);

/** A nonce as a state carries one: 43 base64url characters, told apart by `tag`. */
const nonce = (tag: string) => tag.padEnd(43, "x");

/** The owner beginning a Connect of the target `production` with the nonce `tag` names. */
const connecting = (projectId: ProjectId, tag: string): HoldProjectConnect => ({
  projectId,
  by: owner,
  target: name("production"),
  nonce: nonce(tag),
  verifier: `verifier-${tag}`,
});

/** The failure's tag and reason, or `succeeded`. */
const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit) ? "succeeded" : JSON.parse(JSON.stringify(exit.cause.reasons[0]));

export function describeDeployTargetsContract(adapter: string, make: () => DeployTargetsHarness) {
  describe(`DeployTargets contract: ${adapter}`, () => {
    it.live(
      "[deploytargets.contract.set] sets a target with what its account answered beside it, lists the project's targets in name order, and takes the same target again as it is",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const targets = yield* DeployTargets;
          const projectId = freshProject();
          yield* harness.establish(projectId);
          expect(yield* targets.list(projectId)).toEqual([]);
          const preview = yield* targets.set(setting(projectId, target("preview")));
          expect(preview).toEqual({ target: target("preview"), workersDev: "acme.workers.dev" });
          yield* targets.set(setting(projectId, target("live"), { workersDev: undefined }));
          yield* targets.set(setting(projectId, target("preview")));
          expect(yield* targets.list(projectId)).toEqual([
            { target: target("live") },
            { target: target("preview"), workersDev: "acme.workers.dev" },
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[deploytargets.contract.refused] refuses a credential of another namespace, and a clear of a name not set, committing nothing",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const targets = yield* DeployTargets;
          const projectId = freshProject();
          yield* harness.establish(projectId);
          const foreign = yield* Effect.exit(
            targets.set(setting(projectId, target("preview"), { credentialInOrg: false })),
          );
          expect(failure(foreign)).toMatchObject({
            error: { _tag: "DeployTargetRefused", reason: "credential-not-in-org" },
          });
          const unset = yield* Effect.exit(
            targets.clear({
              projectId,
              name: name("preview"),
              by: owner,
              requestId: crypto.randomUUID(),
            }),
          );
          expect(failure(unset)).toMatchObject({
            error: { _tag: "DeployTargetRefused", reason: "not-set" },
          });
          expect(yield* targets.list(projectId)).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("[deploytargets.contract.clear] clears a target, and only that one", () => {
      const harness = make();
      return Effect.gen(function* () {
        const targets = yield* DeployTargets;
        const projectId = freshProject();
        yield* harness.establish(projectId);
        yield* targets.set(setting(projectId, target("preview")));
        yield* targets.set(setting(projectId, target("live")));
        yield* targets.clear({
          projectId,
          name: name("preview"),
          by: owner,
          requestId: crypto.randomUUID(),
        });
        expect(yield* targets.list(projectId)).toEqual([
          { target: target("live"), workersDev: "acme.workers.dev" },
        ]);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("[deploytargets.contract.missing] a project never created is ProjectNotFound", () => {
      const harness = make();
      return Effect.gen(function* () {
        const targets = yield* DeployTargets;
        const projectId = freshProject();
        expect(failure(yield* Effect.exit(targets.list(projectId)))).toMatchObject({
          error: { _tag: "ProjectNotFound", projectId },
        });
        expect(
          failure(yield* Effect.exit(targets.set(setting(projectId, target("preview"))))),
        ).toMatchObject({ error: { _tag: "ProjectNotFound", projectId } });
        expect(
          failure(yield* Effect.exit(targets.holdConnect(connecting(projectId, "n1")))),
        ).toMatchObject({ error: { _tag: "ProjectNotFound", projectId } });
        expect(
          failure(
            yield* Effect.exit(targets.takeConnect({ projectId, by: owner, nonce: nonce("n1") })),
          ),
        ).toMatchObject({ error: { _tag: "ProjectNotFound", projectId } });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[deploytargets.contract.connect-once] a held Connect is taken once, with its target and verifier, by its own nonce",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const targets = yield* DeployTargets;
          const projectId = freshProject();
          yield* harness.establish(projectId);
          yield* targets.holdConnect(connecting(projectId, "n1"));
          const taken = yield* targets.takeConnect({ projectId, by: owner, nonce: nonce("n1") });
          expect(taken).toMatchObject({
            target: name("production"),
            nonce: nonce("n1"),
            verifier: "verifier-n1",
          });
          const again = yield* Effect.exit(
            targets.takeConnect({ projectId, by: owner, nonce: nonce("n1") }),
          );
          expect(failure(again)).toMatchObject({
            error: { _tag: "ConnectStateRefused", reason: "none" },
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[deploytargets.contract.connect-owner] a Connect is its owner's alone, is gone after a wrong nonce, and is replaced by the owner's next",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const targets = yield* DeployTargets;
          const projectId = freshProject();
          yield* harness.establish(projectId);
          yield* targets.holdConnect(connecting(projectId, "n1"));
          const stranger = yield* Effect.exit(
            targets.takeConnect({ projectId, by: other, nonce: nonce("n1") }),
          );
          expect(failure(stranger)).toMatchObject({
            error: { _tag: "ConnectStateRefused", reason: "none" },
          });
          const wrong = yield* Effect.exit(
            targets.takeConnect({ projectId, by: owner, nonce: nonce("n2") }),
          );
          expect(failure(wrong)).toMatchObject({
            error: { _tag: "ConnectStateRefused", reason: "mismatch" },
          });
          const after = yield* Effect.exit(
            targets.takeConnect({ projectId, by: owner, nonce: nonce("n1") }),
          );
          expect(failure(after)).toMatchObject({
            error: { _tag: "ConnectStateRefused", reason: "none" },
          });
          yield* targets.holdConnect(connecting(projectId, "n3"));
          yield* targets.holdConnect(connecting(projectId, "n4"));
          const replaced = yield* Effect.exit(
            targets.takeConnect({ projectId, by: owner, nonce: nonce("n3") }),
          );
          expect(failure(replaced)).toMatchObject({
            error: { _tag: "ConnectStateRefused", reason: "mismatch" },
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
