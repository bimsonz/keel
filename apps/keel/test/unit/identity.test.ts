import { describe, expect, it } from "@effect/vitest";
import {
  exchangeToken,
  TOKEN_TTL_SECONDS,
  type TokenRequest,
  whoami,
} from "@keeltown/core/application/identity";
import { type Agent, INVITED_SCOPES } from "@keeltown/core/domain/identity";
import { AgentId, Instant, makeId } from "@keeltown/core/kernel";
import {
  hashSecret,
  makeAgentDirectoryMemory,
  makeClockMemory,
  makeNamespaceAgentsMemory,
  makeProjectAgentsMemory,
  makeSessionsMemory,
  makeTokenIssuerMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { Sessions } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const agent: Agent = {
  id: agentId,
  projectId: sampleProjectId,
  name: "unit-agent",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  state: "active",
  revocationEpoch: 2,
  createdAt: Instant(1_760_000_000_000),
};

const secretHash = await hashSecret("secret");

const org = (n: number) => makeId("org", `01JZ8PT2C4E6G8J0M2N4Q6S8V${n}`);
const project = (n: number) => makeId("prj", `01JZ8PT2C4E6G8J0M2N4Q6S8V${n}`);

/** The use-cases' ports, in memory, with the directory seeded by `override`. */
function layers(
  override: Partial<Agent> = {},
  invitations: {
    readonly namespaces?: ReturnType<typeof makeNamespaceAgentsMemory>;
    readonly projects?: ReturnType<typeof makeProjectAgentsMemory>;
  } = {},
) {
  const directory = makeAgentDirectoryMemory();
  directory.seed({ ...agent, ...override }, { clientId: "client", agentId, secretHash });
  const clock = makeClockMemory().layer;
  return Layer.mergeAll(
    (invitations.namespaces ?? makeNamespaceAgentsMemory()).layer,
    (invitations.projects ?? makeProjectAgentsMemory()).layer,
    directory.layer,
    makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
    makeSessionsMemory().layer.pipe(Layer.provide(directory.layer)),
    clock,
  );
}

describe("identity/whoami", () => {
  it.effect("answers the agent behind a principal at its current epoch, with no session yet", () =>
    Effect.gen(function* () {
      const identity = yield* whoami({
        agentId,
        projectId: sampleProjectId,
        scopes: ["agent:read"],
        revocationEpoch: 2,
      });
      expect(identity).toEqual({
        agent,
        session: null,
        invitations: { namespaces: 0, projects: 0 },
      });
    }).pipe(Effect.provide(layers())),
  );

  it.effect(
    "[whoami.invitations] counts the invitations that wait for the agent's word, an org's and a project's, and none it accepted or that ended",
    () => {
      const namespaces = makeNamespaceAgentsMemory();
      const projects = makeProjectAgentsMemory();
      const by = makeId("usr", "01JZ8PT2C4E6G8J0M2N4Q6S8V1");
      const at = Instant(1_760_000_000_000);
      return Effect.gen(function* () {
        const invited = { agentId, by, scopes: INVITED_SCOPES, at };
        for (const n of [2, 3, 4])
          yield* namespaces.service.apply({ _tag: "Invited", namespace: org(n), ...invited }, 1);
        yield* namespaces.service.apply({ _tag: "Joined", namespace: org(3), agentId, at }, 2);
        yield* namespaces.service.apply({ _tag: "Left", namespace: org(4), agentId }, 2);
        for (const n of [5, 6])
          yield* projects.service.apply(
            { _tag: "Invited", projectId: project(n), namespace: org(2), ...invited },
            1,
          );
        yield* projects.service.apply({ _tag: "Joined", projectId: project(6), agentId, at }, 2);
        const identity = yield* whoami({
          agentId,
          projectId: sampleProjectId,
          scopes: ["agent:read"],
          revocationEpoch: 2,
        });
        expect(identity.invitations).toEqual({ namespaces: 1, projects: 1 });
      }).pipe(Effect.provide(layers({}, { namespaces, projects })));
    },
  );

  it.effect("answers the agent's current session once it has opened one", () =>
    Effect.gen(function* () {
      const principal = {
        agentId,
        projectId: sampleProjectId,
        scopes: ["agent:work" as const],
        revocationEpoch: 2,
      };
      const opened = yield* (yield* Sessions).open(principal, { idempotencyKey: "session-1" });
      const identity = yield* whoami(principal);
      expect(identity).toEqual({
        agent,
        session: { id: opened.id },
        invitations: { namespaces: 0, projects: 0 },
      });
    }).pipe(Effect.provide(layers())),
  );

  it.effect("fails AgentNotKnown for an agent the directory lacks", () =>
    Effect.gen(function* () {
      const other = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
      const error = yield* Effect.flip(
        whoami({ agentId: other, projectId: sampleProjectId, scopes: [], revocationEpoch: 0 }),
      );
      expect(error._tag).toBe("AgentNotKnown");
    }).pipe(Effect.provide(layers())),
  );

  it.effect(
    "answers a suspended agent as it stands: the policy, not this read, refuses a paused agent",
    () =>
      Effect.gen(function* () {
        const identity = yield* whoami({
          agentId,
          projectId: sampleProjectId,
          scopes: ["agent:read"],
          revocationEpoch: 2,
        });
        expect(identity.agent.state).toBe("suspended");
      }).pipe(Effect.provide(layers({ state: "suspended" }))),
  );

  it.effect.each<{ override: Partial<Agent>; epoch: number; reason: string }>([
    { override: { state: "revoked" }, epoch: 2, reason: "revoked" },
    { override: {}, epoch: 1, reason: "stale-epoch" },
    { override: { state: "suspended" }, epoch: 1, reason: "stale-epoch" },
  ])("fails AgentNotAdmitted as $reason", ({ override, epoch, reason }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        whoami({ agentId, projectId: sampleProjectId, scopes: [], revocationEpoch: epoch }),
      );
      expect(error).toMatchObject({ _tag: "AgentNotAdmitted", reason });
    }).pipe(Effect.provide(layers(override))),
  );
});

describe("identity/exchangeToken", () => {
  it.effect("issues a token for every scope the agent holds, carrying its epoch", () =>
    Effect.gen(function* () {
      const granted = yield* exchangeToken({ clientId: "client", clientSecret: "secret" });
      expect(granted.scopes).toEqual(["agent:read", "agent:work"]);
      expect(granted.expiresAt).toBe(TOKEN_TTL_SECONDS * 1000);
    }).pipe(Effect.provide(layers())),
  );

  it.effect("narrows to the scopes asked for", () =>
    Effect.gen(function* () {
      expect(
        (yield* exchangeToken({
          clientId: "client",
          clientSecret: "secret",
          scopes: ["agent:read"],
        })).scopes,
      ).toEqual(["agent:read"]);
    }).pipe(Effect.provide(layers())),
  );

  it.effect.each<{ request: TokenRequest; override: Partial<Agent>; tag: string }>([
    {
      request: { clientId: "client", clientSecret: "wrong" },
      override: {},
      tag: "CredentialRejected",
    },
    {
      request: { clientId: "nobody", clientSecret: "secret" },
      override: {},
      tag: "CredentialRejected",
    },
    {
      request: { clientId: "client", clientSecret: "secret", scopes: ["operator"] },
      override: {},
      tag: "ScopeNotGranted",
    },
    {
      request: { clientId: "client", clientSecret: "secret" },
      override: { state: "suspended" },
      tag: "AgentNotAdmitted",
    },
  ])("refuses with $tag", ({ request, override, tag }) =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(exchangeToken(request)))._tag).toBe(tag);
    }).pipe(Effect.provide(layers(override))),
  );
});
