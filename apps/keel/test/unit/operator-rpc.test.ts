import { describe, expect, it } from "@effect/vitest";
import { type Actor, Agent, IdempotencyConflict } from "@keeltown/core/domain/identity";
import { OrgId, ProjectId, UserId } from "@keeltown/core/kernel";
import { type EnrolInput, Enrolments, Projects, RepoNotFound } from "@keeltown/core/ports";
import { Effect, Exit, Schema } from "effect";
import { derivedUlid, sha256Of } from "../../src/adapters/driven/do-rpc/answer.ts";
import { EnrolmentsRpc } from "../../src/adapters/driven/do-rpc/enrolments.ts";
import { ProjectsRpc } from "../../src/adapters/driven/do-rpc/projects.ts";
import {
  AgentSessionCodecs,
  type CreateProjectCommand,
  type EnrolCommand,
  encodeExit,
  ProjectCodecs,
} from "../../src/rpc/index.ts";

const user = (id: string): Actor & { readonly _tag: "User" } => ({
  _tag: "User",
  userId: Schema.decodeUnknownSync(UserId)(id),
});
const alice = user("usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const bob = user("usr_01JZ8PT2C4E6G8J0M2N4Q6S8V9");
const PROJECT = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V3");
const OTHER_PROJECT = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V4");

/** A fake Project DO per name: records each command and answers the Exit the test scripts. */
function projectObjects(answer?: (command: typeof CreateProjectCommand.Encoded) => unknown) {
  const sent: Array<{ name: string; command: typeof CreateProjectCommand.Encoded }> = [];
  const layer = ProjectsRpc((projectId) => ({
    createProject: async (command) => {
      sent.push({ name: projectId, command });
      return (
        answer?.(command) ??
        encodeExit(
          ProjectCodecs.createProject,
          Exit.succeed({ id: command.projectId, name: command.name, createdAt: 1_000 }),
        )
      );
    },
    settings: () => Promise.reject(new Error("settings is not scripted here")),
    putSettings: () => Promise.reject(new Error("putSettings is not scripted here")),
    liveAnchors: () => Promise.reject(new Error("liveAnchors is not scripted here")),
  }));
  return { sent, layer };
}

const create = (
  by: Actor,
  name: string,
  idempotencyKey: string,
  source = "fixture-forge-lite",
  projectId = PROJECT,
) => Projects.use((projects) => projects.create(by, { projectId, name, source, idempotencyKey }));

describe("Projects over Durable Object RPC", () => {
  it.effect(
    "[a11b.reach] reaches the Project DO the project's id names, recording the actor's id as its creator",
    () => {
      const { sent, layer } = projectObjects();
      return Effect.gen(function* () {
        const first = yield* create(alice, "forge", "key-0001");
        yield* create(bob, "forge", "key-0002", "fixture-forge-lite", OTHER_PROJECT);
        expect(first.id).toBe(PROJECT);
        expect(sent.map((s) => s.name)).toEqual([PROJECT, OTHER_PROJECT]);
        expect(sent.map((s) => s.command)).toMatchObject([
          { projectId: PROJECT, by: alice.userId, idempotencyKey: "key-0001" },
          { projectId: OTHER_PROJECT, by: bob.userId, idempotencyKey: "key-0002" },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[a11b.fingerprint] fingerprints the body, so a reused key with another body can be refused",
    () => {
      const { sent, layer } = projectObjects();
      return Effect.gen(function* () {
        yield* create(alice, "forge", "key-0001");
        yield* create(alice, "forge", "key-0001");
        yield* create(alice, "other", "key-0001");
        yield* create(alice, "forge", "key-0001", "another-source");
        const prints = sent.map((s) => s.command.fingerprint);
        expect(prints[0]).toBe(prints[1]);
        expect(new Set(prints).size).toBe(3);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "rebuilds a missing source as the port's RepoNotFound, and passes IdempotencyConflict on",
    () => {
      const repo = { namespace: "keel-core", name: "no-such-repo" };
      const missing = projectObjects(() =>
        encodeExit(ProjectCodecs.createProject, Exit.fail({ _tag: "RepoNotFound" as const, repo })),
      );
      const reused = projectObjects(() =>
        encodeExit(
          ProjectCodecs.createProject,
          Exit.fail(new IdempotencyConflict({ idempotencyKey: "key-0001" })),
        ),
      );
      return Effect.gen(function* () {
        const notFound = yield* Effect.flip(
          create(alice, "forge", "key-0001").pipe(Effect.provide(missing.layer)),
        );
        expect(notFound).toBeInstanceOf(RepoNotFound);
        expect(notFound).toMatchObject({ repo });
        const conflict = yield* Effect.flip(
          create(alice, "forge", "key-0001").pipe(Effect.provide(reused.layer)),
        );
        expect(conflict).toBeInstanceOf(IdempotencyConflict);
      });
    },
  );

  it("derives ULID bodies whose first character is 0–7, as a ULID's must be", async () => {
    for (let i = 0; i < 200; i += 1) {
      const body = await derivedUlid(`agt_${i}`, crypto.randomUUID());
      expect(body).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    }
  });
});

/** A fake AgentSession DO per name: records each enrol and answers the agent it would enrol. */
function agentObjects() {
  const sent: Array<{ name: string; command: typeof EnrolCommand.Encoded }> = [];
  const layer = EnrolmentsRpc((agentId) => ({
    enrol: async (command) => {
      sent.push({ name: agentId, command });
      return encodeExit(
        AgentSessionCodecs.enrol,
        Exit.succeed(
          Schema.decodeUnknownSync(Agent)({
            id: agentId,
            projectId: command.projectId,
            name: command.name,
            kind: command.kind,
            scopes: command.scopes,
            ...(command.org === undefined ? {} : { org: command.org }),
            ...(command.sponsor === undefined ? {} : { sponsor: command.sponsor }),
            state: "active",
            revocationEpoch: 0,
            createdAt: 1_000,
          }),
        ),
      );
    },
  }));
  return { sent, layer };
}

const ORG = Schema.decodeUnknownSync(OrgId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

/** The AgentSession DO an actor's enrolment under `key` reaches. */
const derived = (actor: string, key: string) =>
  Effect.promise(async () => `agt_${await derivedUlid(actor, key)}`);

const enrolling = (overrides: Partial<EnrolInput> = {}): EnrolInput => ({
  name: "worker",
  kind: "interactive",
  scopes: ["agent:work"],
  projectId: PROJECT,
  org: ORG,
  sponsor: alice.userId,
  idempotencyKey: "key-0001",
  ...overrides,
});

describe("Enrolments over Durable Object RPC", () => {
  it.effect(
    "[a11b.secret] sends only the secret's hash, and returns the secret that hash belongs to",
    () => {
      const { sent, layer } = agentObjects();
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        const first = yield* enrolments.enrol(alice, enrolling());
        const again = yield* enrolments.enrol(alice, enrolling());
        const [command] = sent;
        expect(command?.command.secretHash).toBe(
          yield* Effect.promise(() => sha256Of(first.clientSecret)),
        );
        expect(JSON.stringify(sent)).not.toContain(first.clientSecret);
        expect(sent[1]?.name).toBe(command?.name);
        expect(again.clientSecret).not.toBe(first.clientSecret);
        expect(command?.command).toMatchObject({ projectId: PROJECT, clientId: first.clientId });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[a11b.derive] reaches one AgentSession DO per actor and key, named by the actor's id and the key",
    () => {
      const { sent, layer } = agentObjects();
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        yield* enrolments.enrol(alice, enrolling());
        yield* enrolments.enrol(alice, enrolling({ idempotencyKey: "key-0002" }));
        yield* enrolments.enrol(bob, enrolling({ sponsor: bob.userId }));
        expect(sent.map((s) => s.name)).toEqual([
          yield* derived(alice.userId, "key-0001"),
          yield* derived(alice.userId, "key-0002"),
          yield* derived(bob.userId, "key-0001"),
        ]);
        expect(new Set(sent.map((s) => s.name)).size).toBe(3);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[tenancy.enrol-rpc] sends the project's org and the sponsoring user, fingerprinted",
    () => {
      const { sent, layer } = agentObjects();
      const another = Schema.decodeUnknownSync(OrgId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        const tenant = yield* enrolments.enrol(alice, enrolling());
        yield* enrolments.enrol(alice, enrolling({ org: another }));
        yield* enrolments.enrol(alice, enrolling({ sponsor: bob.userId }));
        expect(sent.map((s) => [s.command.org, s.command.sponsor])).toEqual([
          [ORG, alice.userId],
          [another, alice.userId],
          [ORG, bob.userId],
        ]);
        expect([tenant.agent.org, tenant.agent.sponsor]).toEqual([ORG, alice.userId]);
        // Another org or sponsor under the same key is another command, so the DO answers IdempotencyConflict.
        expect(new Set(sent.map((s) => s.command.fingerprint)).size).toBe(3);
      }).pipe(Effect.provide(layer));
    },
  );
});
