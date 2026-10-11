import { describe, expect, it } from "@effect/vitest";
import { Agent, IdempotencyConflict, type Principal } from "@keeltown/core/domain/identity";
import { AgentId, isId, ProjectId } from "@keeltown/core/kernel";
import { Enrolments, Projects, RepoNotFound } from "@keeltown/core/ports";
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

const operator = (id: string): Principal => ({
  agentId: Schema.decodeUnknownSync(AgentId)(id),
  projectId: Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V3"),
  scopes: ["operator"],
  revocationEpoch: 0,
});
const alice = operator("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const bob = operator("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V9");

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
  }));
  return { sent, layer };
}

const create = (
  by: Principal,
  name: string,
  idempotencyKey: string,
  source = "fixture-forge-lite",
) => Projects.use((projects) => projects.create(by, { name, source, idempotencyKey }));

describe("Projects over Durable Object RPC", () => {
  it.effect(
    "[a11b.derive] reaches one Project DO per operator and key, named by a valid project id",
    () => {
      const { sent, layer } = projectObjects();
      return Effect.gen(function* () {
        const first = yield* create(alice, "forge", "key-0001");
        yield* create(alice, "forge", "key-0001");
        yield* create(alice, "forge", "key-0002");
        yield* create(bob, "forge", "key-0001");
        const names = sent.map((s) => s.name);
        expect(names[0]).toBe(names[1]);
        expect(new Set(names).size).toBe(3);
        expect(isId("prj", first.id)).toBe(true);
        expect(sent[0]?.command).toMatchObject({ projectId: names[0], by: alice.agentId });
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

describe("Enrolments over Durable Object RPC", () => {
  it.effect(
    "[a11b.secret] sends only the secret's hash, and returns the secret that hash belongs to",
    () => {
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
                state: "active",
                revocationEpoch: 0,
                createdAt: 1_000,
              }),
            ),
          );
        },
      }));
      const input = {
        name: "worker",
        kind: "interactive" as const,
        scopes: ["agent:work" as const],
        idempotencyKey: "key-0001",
      };
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        const first = yield* enrolments.enrol(alice, input);
        const again = yield* enrolments.enrol(alice, input);
        const [command] = sent;
        expect(command?.command.secretHash).toBe(
          yield* Effect.promise(() => sha256Of(first.clientSecret)),
        );
        expect(JSON.stringify(sent)).not.toContain(first.clientSecret);
        expect(sent[1]?.name).toBe(command?.name);
        expect(again.clientSecret).not.toBe(first.clientSecret);
        expect(command?.command).toMatchObject({
          projectId: alice.projectId,
          clientId: first.clientId,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[a11s.enrol] sends the sponsor, fingerprinted, and no sponsor key when none is named",
    () => {
      const sent: Array<typeof EnrolCommand.Encoded> = [];
      const layer = EnrolmentsRpc((agentId) => ({
        enrol: async (command) => {
          sent.push(command);
          return encodeExit(
            AgentSessionCodecs.enrol,
            Exit.succeed(
              Schema.decodeUnknownSync(Agent)({
                id: agentId,
                projectId: command.projectId,
                name: command.name,
                kind: command.kind,
                scopes: command.scopes,
                ...(command.onBehalfOf === undefined ? {} : { onBehalfOf: command.onBehalfOf }),
                state: "active",
                revocationEpoch: 0,
                createdAt: 1_000,
              }),
            ),
          );
        },
      }));
      const input = {
        name: "worker",
        kind: "interactive" as const,
        scopes: ["agent:work" as const],
        idempotencyKey: "key-0002",
      };
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        const sponsored = yield* enrolments.enrol(alice, {
          ...input,
          onBehalfOf: "github:bimsonz",
        });
        yield* enrolments.enrol(alice, input);
        const [withSponsor, without] = sent;
        expect(withSponsor?.onBehalfOf).toBe("github:bimsonz");
        expect(sponsored.agent.onBehalfOf).toBe("github:bimsonz");
        expect(without !== undefined && "onBehalfOf" in without).toBe(false);
        // Another sponsor under the same key is another command, so the DO answers IdempotencyConflict.
        expect(withSponsor?.fingerprint).not.toBe(without?.fingerprint);
      }).pipe(Effect.provide(layer));
    },
  );
});
