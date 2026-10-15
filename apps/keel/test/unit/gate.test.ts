import { describe, expect, it } from "@effect/vitest";
import {
  type Credential,
  type PresentedToken,
  principalOf,
  type SignedIn,
} from "@keeltown/core/application/identity";
import { type Agent, type AgentClaims, runIdOf } from "@keeltown/core/domain/identity";
import { Instant, makeId, type ProjectId, RunLabel, type RunRef } from "@keeltown/core/kernel";
import { NamespaceAgents, ProjectAgents, TokenIssuer } from "@keeltown/core/ports";
import {
  hashSecret,
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeClockMemory,
  makeMembershipsMemory,
  makeNamespaceAgentsMemory,
  makeProjectAgentsMemory,
  makeProjectNamespacesMemory,
  makeTokenIssuerMemory,
  makeUsersMemory,
  sampleOrgId,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import {
  type Door,
  gate,
  type GateDeps,
  SESSION_COOKIE,
  type SessionUser,
} from "../../src/adapters/driving/http/gate.ts";

/**
 * What the request gate hands on: a session with how and when it was signed
 * in, and an agent as it stands, paused or not.
 */

const ANN = makeId("usr", ulidOf(51));
const BOB = makeId("usr", ulidOf(52));
const BOT = makeId("agt", ulidOf(53));
const BY_PASSKEY: SignedIn = { by: "passkey", at: 1_760_000_000_000 };
const BY_CODE: SignedIn = { by: "email-otp", at: 1_760_000_600_000 };
const ORIGIN = "https://keel.test";
const JWT = "aaa.bbb.ccc";
/** A token of the secret exchange whose agent the core gate refuses as revoked. */
const REVOKED = "revoked.bbb.ccc";
/** A token the core gate refuses as stale: its run chose a project, and it names none. */
const STALE = "stale.bbb.ccc";
const headed = (header: object) => `${btoa(JSON.stringify(header)).replaceAll("=", "")}.bbb.ccc`;
/** An agent's own token, by what its header says it is; and one the identity adapter refuses. */
const ACCESS_TOKEN = headed({ alg: "EdDSA", typ: "at+jwt" });
const BAD_ACCESS_TOKEN = headed({ alg: "EdDSA", typ: "at+jwt", kid: "other" });

/** A gate whose sessions are two fixed ones, recording each credential it asks to have admitted. */
function recordingGate() {
  const seen: Credential[] = [];
  const presentedAt: (PresentedToken & { readonly door: Door })[] = [];
  const sessions: Readonly<Record<string, SessionUser>> = {
    "Bearer sess-ann": { userId: ANN, signedIn: BY_PASSKEY },
    [`${SESSION_COOKIE}=sess-bob`]: { userId: BOB, signedIn: BY_CODE },
  };
  const deps: GateDeps = {
    origin: ORIGIN,
    sessionUser: (headers) =>
      Promise.resolve(
        sessions[headers.get("authorization") ?? ""] ??
          sessions[headers.get("cookie") ?? ""] ??
          null,
      ),
    agentToken: (presented, door) => {
      presentedAt.push({ ...presented, door });
      return Promise.resolve(
        presented.token === ACCESS_TOKEN
          ? { agentId: BOT, scopes: ["agent:read"], revocationEpoch: 2, bound: true }
          : { refused: "invalid_dpop_proof", detail: "no proof" },
      );
    },
    challenge: (door, refusal) => `challenge for ${door}${refusal ? `: ${refusal.refused}` : ""}`,
    admit: (credential) => {
      seen.push(credential);
      return Promise.resolve(
        credential._tag === "Token" && credential.token === REVOKED
          ? { refused: "revoked" }
          : credential._tag === "Token" && credential.token === STALE
            ? {
                refused: "stale-project",
                run: "my-run",
                projectId: "prj_1B1YM1A788YVAYHTR6G6KW69TD",
              }
            : { admitted: { principal: { _tag: "Anonymous" } } },
      );
    },
  };
  const pass = async (init: RequestInit) => {
    const gated = await gate(new Request(`${ORIGIN}/v1/agents/sponsored`, init), "req-1", deps);
    return gated instanceof Response ? gated.status : "admitted";
  };
  /** The gate's own answer to a request at `url`, by the door it came in by. */
  const answer = (url: string, init: RequestInit, door?: Door) =>
    gate(new Request(url, init), "req-1", deps, {
      cookies: door !== "mcp",
      ...(door ? { door } : {}),
    });
  return { seen, presentedAt, pass, answer };
}

const agent: Agent = {
  id: BOT,
  projectId: sampleProjectId,
  name: "gated-agent",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  org: sampleOrgId,
  sponsor: ANN,
  state: "active",
  revocationEpoch: 2,
  createdAt: Instant(1_760_000_000_000),
};

const secretHash = await hashSecret("secret");

/** `principalOf`'s ports in memory: Ann with a handle, a member of the agent's org, and the agent as `override` has it. */
function layers(override: Partial<Agent> = {}) {
  const directory = makeAgentDirectoryMemory();
  directory.seed({ ...agent, ...override }, { clientId: "client", agentId: BOT, secretHash });
  const rows = makeBetterAuthMemory({
    users: [{ id: ANN, username: "ann" }],
    orgs: [{ id: sampleOrgId, slug: "sample" }],
    members: [{ organizationId: sampleOrgId, userId: ANN, role: "member" }],
  });
  const clock = makeClockMemory().layer;
  return Layer.mergeAll(
    directory.layer,
    makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
    makeUsersMemory(rows).layer,
    makeMembershipsMemory(rows).layer,
    makeProjectNamespacesMemory().layer,
    makeNamespaceAgentsMemory().layer,
    makeProjectAgentsMemory().layer,
    clock,
  );
}

const KEYED = makeId("agt", ulidOf(54));
const OWN = makeId("prj", ulidOf(55));
const ELSEWHERE = makeId("prj", ulidOf(56));
const NOWHERE = makeId("prj", ulidOf(57));
/** Two projects of Ann's own namespace, whose id is hers. */
const HERS = makeId("prj", ulidOf(58));
const HERS_TOO = makeId("prj", ulidOf(59));

/** An agent that signed itself up: a handle and no project, kind, org or sponsor. */
const keyed: Agent = {
  id: KEYED,
  handle: "agent-keyed",
  name: "agent-keyed",
  scopes: ["agent:work", "agent:read"],
  state: "active",
  revocationEpoch: 1,
  createdAt: Instant(1_760_000_000_000),
};

/** The keyed agent's verified claims, as the doorway hands them on. */
const claims = (over: Partial<AgentClaims> = {}): Credential => ({
  _tag: "Claims",
  claims: { agentId: KEYED, scopes: ["agent:work", "agent:read"], revocationEpoch: 1, ...over },
});

/**
 * The ports with the keyed agent as `override` has it, one project in its own
 * namespace, one in an org Ann is a member of, and two in Ann's own
 * namespace. `invitations` are the rows of the org's agents and `toProjects`
 * the rows of the agents invited to one project; `reads` and `projectReads`
 * count each read of them.
 */
function keyedLayers(
  override: Partial<Agent> = {},
  invitations: ReturnType<typeof makeNamespaceAgentsMemory> = makeNamespaceAgentsMemory(),
  reads: { count: number } = { count: 0 },
  toProjects: ReturnType<typeof makeProjectAgentsMemory> = makeProjectAgentsMemory(),
  projectReads: { count: number } = { count: 0 },
  chosen: readonly (readonly [RunRef, ProjectId])[] = [],
) {
  const directory = makeAgentDirectoryMemory();
  directory.agents.set(KEYED, { ...keyed, ...override });
  for (const [run, projectId] of chosen)
    directory.runProjects.set(`${KEYED}\n${run.id}`, projectId);
  const places = makeProjectNamespacesMemory();
  places.places.set(OWN, { projectId: OWN, namespace: KEYED, name: "mine" });
  places.places.set(ELSEWHERE, { projectId: ELSEWHERE, namespace: sampleOrgId, name: "theirs" });
  places.places.set(HERS, { projectId: HERS, namespace: ANN, name: "hers" });
  places.places.set(HERS_TOO, { projectId: HERS_TOO, namespace: ANN, name: "hers-too" });
  const rows = makeBetterAuthMemory({
    users: [{ id: ANN, username: "ann" }],
    orgs: [{ id: sampleOrgId, slug: "sample" }],
    members: [{ organizationId: sampleOrgId, userId: ANN, role: "member" }],
  });
  const clock = makeClockMemory().layer;
  return Layer.mergeAll(
    directory.layer,
    makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
    makeUsersMemory(rows).layer,
    makeMembershipsMemory(rows).layer,
    places.layer,
    Layer.succeed(
      NamespaceAgents,
      NamespaceAgents.of({
        ...invitations.service,
        standing: (agentId, namespace) =>
          Effect.suspend(() => {
            reads.count += 1;
            return invitations.service.standing(agentId, namespace);
          }),
      }),
    ),
    Layer.succeed(
      ProjectAgents,
      ProjectAgents.of({
        ...toProjects.service,
        standing: (agentId, projectId) =>
          Effect.suspend(() => {
            projectReads.count += 1;
            return toProjects.service.standing(agentId, projectId);
          }),
      }),
    ),
    clock,
  );
}

/** The rows of one project of Ann's with the keyed agent invited to it by `by`, and accepted or ended as asked. */
function invitedTo(
  projectId: typeof HERS,
  by: typeof ANN,
  scopes: readonly ("agent:read" | "agent:work")[],
  then: readonly ("Joined" | "Left")[],
) {
  const toProjects = makeProjectAgentsMemory();
  const at = { projectId, agentId: KEYED };
  const moves = [
    { _tag: "Invited" as const, ...at, namespace: ANN, by, scopes, at: Instant(1_760_000_000_000) },
    ...then.map((tag) =>
      tag === "Joined"
        ? { _tag: tag, ...at, at: Instant(1_760_000_000_001) }
        : { _tag: tag, ...at },
    ),
  ];
  return Effect.forEach(moves, (move, index) => toProjects.service.apply(move, index + 1)).pipe(
    Effect.as(toProjects),
  );
}

/** The org's rows with the keyed agent invited by `by`, and accepted or ended as asked. */
function invitedBy(
  by: typeof ANN,
  scopes: readonly ("agent:read" | "agent:work")[],
  then: readonly ("Joined" | "Left")[],
) {
  const invitations = makeNamespaceAgentsMemory();
  const at = { namespace: sampleOrgId, agentId: KEYED };
  const moves = [
    { _tag: "Invited" as const, ...at, by, scopes, at: Instant(1_760_000_000_000) },
    ...then.map((tag) =>
      tag === "Joined"
        ? { _tag: tag, ...at, at: Instant(1_760_000_000_001) }
        : { _tag: tag, ...at },
    ),
  ];
  return Effect.forEach(moves, (move, index) => invitations.service.apply(move, index + 1)).pipe(
    Effect.as(invitations),
  );
}

/** What the gate makes of a keyed agent's claims: admitted, admitted as paused, or why not. */
const reason = (credential: Credential) =>
  principalOf(credential).pipe(
    Effect.match({
      onSuccess: (admitted) =>
        admitted.principal._tag === "Agent" && admitted.principal.paused ? "paused" : "admitted",
      onFailure: (error) => (error._tag === "AgentNotAdmitted" ? error.reason : error._tag),
    }),
  );

/** A token of the agent's, minted at `epoch`, as a credential. */
const tokenAt = (epoch: number) =>
  TokenIssuer.use((issuer) =>
    issuer.issue(
      {
        agentId: BOT,
        projectId: sampleProjectId,
        scopes: ["agent:read", "agent:work"],
        revocationEpoch: epoch,
        org: sampleOrgId,
      },
      60,
    ),
  ).pipe(Effect.map((issued): Credential => ({ _tag: "Token", token: issued.token })));

/** What the gate makes of the agent's token minted at `epoch`: admitted, or why not. */
const reasonAt = (epoch: number) =>
  tokenAt(epoch).pipe(
    Effect.flatMap(principalOf),
    Effect.match({
      onSuccess: () => "admitted",
      onFailure: (error) => (error._tag === "AgentNotAdmitted" ? error.reason : error._tag),
    }),
  );

describe("the request gate", () => {
  it("[gate.signed-in] a session is admitted with how and when it was signed in, by its bearer and by its cookie; a token and nothing carry none", async () => {
    const g = recordingGate();
    expect(await g.pass({ headers: { authorization: "Bearer sess-ann" } })).toBe("admitted");
    expect(await g.pass({ headers: { cookie: `${SESSION_COOKIE}=sess-bob` } })).toBe("admitted");
    expect(
      await g.pass({
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=sess-bob`, origin: ORIGIN },
      }),
    ).toBe("admitted");
    expect(await g.pass({ headers: { authorization: `Bearer ${JWT}` } })).toBe("admitted");
    expect(await g.pass({})).toBe("admitted");
    expect(g.seen).toEqual([
      { _tag: "Session", userId: ANN, signedIn: BY_PASSKEY },
      { _tag: "Session", userId: BOB, signedIn: BY_CODE },
      { _tag: "Session", userId: BOB, signedIn: BY_CODE },
      { _tag: "Token", token: JWT },
      { _tag: "None" },
    ]);
    // A bearer that is no session is refused, never read as anonymous.
    expect(await g.pass({ headers: { authorization: "Bearer sess-nobody" } })).toBe(401);
    expect(g.seen).toHaveLength(5);
  });

  it.effect(
    "[gate.signed-in] the user a session names is admitted with that session's sign-in, as it was given",
    () =>
      Effect.gen(function* () {
        const admitted = yield* principalOf({ _tag: "Session", userId: ANN, signedIn: BY_PASSKEY });
        expect(admitted.principal).toMatchObject({ _tag: "User", userId: ANN, handle: "ann" });
        expect(admitted.signedIn).toEqual(BY_PASSKEY);
        const coded = yield* principalOf({ _tag: "Session", userId: ANN, signedIn: BY_CODE });
        expect(coded.signedIn).toEqual(BY_CODE);
        expect(yield* principalOf({ _tag: "None" })).toEqual({ principal: { _tag: "Anonymous" } });
      }).pipe(Effect.provide(layers())),
  );

  it.effect(
    "[gate.paused-admitted] a suspended agent is admitted as paused, for the policy to answer",
    () =>
      Effect.gen(function* () {
        const admitted = yield* principalOf(yield* tokenAt(2));
        expect(admitted.principal).toMatchObject({ _tag: "Agent", agentId: BOT, paused: true });
        expect(admitted.signedIn).toBeUndefined();
      }).pipe(Effect.provide(layers({ state: "suspended" }))),
  );

  it.effect("[gate.paused-admitted] an active agent is admitted, and not as paused", () =>
    Effect.gen(function* () {
      const admitted = yield* principalOf(yield* tokenAt(2));
      expect(admitted.principal).toMatchObject({ _tag: "Agent", agentId: BOT, paused: false });
    }).pipe(Effect.provide(layers())),
  );

  it.effect(
    "[gate.paused-admitted] a token of an earlier epoch is refused, a suspended agent's too",
    () =>
      Effect.gen(function* () {
        expect(yield* reasonAt(1)).toBe("stale-epoch");
        expect(yield* reasonAt(2)).toBe("admitted");
      }).pipe(Effect.provide(layers({ state: "suspended" }))),
  );

  it.effect(
    "[gate.sponsorless] an agent in an org with nobody behind it is admitted with no standing there, so it can still ask for a sponsor",
    () =>
      Effect.gen(function* () {
        const admitted = yield* principalOf(yield* tokenAt(2));
        expect(admitted.principal).toMatchObject({
          _tag: "Agent",
          agentId: BOT,
          namespace: sampleOrgId,
          paused: false,
          standing: { _tag: "None" },
        });
      }).pipe(Effect.provide(layers({ sponsor: undefined }))),
  );

  it.effect(
    "[gate.sponsorless] an agent somebody sponsors stands as that person does in its org, and one in no org is refused by name",
    () =>
      Effect.gen(function* () {
        const admitted = yield* principalOf(yield* tokenAt(2));
        expect(admitted.principal).toMatchObject({
          standing: { _tag: "Invited", by: { userId: ANN, role: "member", suspended: false } },
        });
      }).pipe(Effect.provide(layers())),
  );

  it.effect("[gate.sponsorless] an agent in no org is refused by name, sponsored or not", () =>
    Effect.gen(function* () {
      const placeless = TokenIssuer.use((issuer) =>
        issuer.issue(
          { agentId: BOT, projectId: sampleProjectId, scopes: ["agent:read"], revocationEpoch: 2 },
          60,
        ),
      ).pipe(
        Effect.flatMap((issued) => principalOf({ _tag: "Token", token: issued.token })),
        Effect.flip,
      );
      expect(yield* placeless).toMatchObject({ _tag: "AgentUnplaced", agentId: BOT });
    }).pipe(Effect.provide(layers({ org: undefined }))),
  );

  it.effect("[gate.paused-admitted] a revoked agent's token is refused as revoked", () =>
    Effect.gen(function* () {
      const refused = yield* tokenAt(3).pipe(Effect.flatMap(principalOf), Effect.flip);
      expect(refused).toMatchObject({ _tag: "AgentNotAdmitted", reason: "revoked" });
    }).pipe(Effect.provide(layers({ state: "revoked", revocationEpoch: 3 }))),
  );
  it("[gate.agent-token] an agent's own token is checked for the door it came in by, under the scheme it was presented with, with its proof, the method and Keel's own address", async () => {
    const g = recordingGate();
    const sent = {
      method: "POST",
      headers: { authorization: `DPoP ${ACCESS_TOKEN}`, dpop: "a.proof.jwt", host: "evil.example" },
    };
    const api = await g.answer(`https://evil.example/v1/changes?x=1`, sent);
    expect(api instanceof Response ? api.status : api.admitted).toEqual({
      principal: { _tag: "Anonymous" },
    });
    await g.answer(
      `${ORIGIN}/mcp`,
      { ...sent, headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
      "mcp",
    );
    expect(g.presentedAt).toEqual([
      {
        token: ACCESS_TOKEN,
        scheme: "DPoP",
        proof: "a.proof.jwt",
        method: "POST",
        url: `${ORIGIN}/v1/changes`,
        door: "api",
      },
      {
        token: ACCESS_TOKEN,
        scheme: "Bearer",
        proof: undefined,
        method: "POST",
        url: `${ORIGIN}/mcp`,
        door: "mcp",
      },
    ]);
    // The core gate is handed the claims the check answered, never the token.
    expect(g.seen).toEqual([
      {
        _tag: "Claims",
        claims: { agentId: BOT, scopes: ["agent:read"], revocationEpoch: 2, bound: true },
      },
      {
        _tag: "Claims",
        claims: { agentId: BOT, scopes: ["agent:read"], revocationEpoch: 2, bound: true },
      },
    ]);
    // A token of the secret exchange and a session are bearers: neither is taken under the DPoP scheme.
    expect(await g.pass({ headers: { authorization: `DPoP ${JWT}` } })).toBe(401);
    expect(await g.pass({ headers: { authorization: "DPoP sess-ann" } })).toBe(401);
    expect(g.seen).toHaveLength(2);
  });

  it("[gate.challenge] every 401 names the door's metadata in WWW-Authenticate, and a refused proof says so", async () => {
    const g = recordingGate();
    const challenge = async (url: string, authorization: string, door?: Door) => {
      const answered = await g.answer(url, { headers: { authorization } }, door);
      return answered instanceof Response
        ? [answered.status, answered.headers.get("www-authenticate")]
        : "admitted";
    };
    const api = `${ORIGIN}/v1/agents/me`;
    expect(await challenge(api, "Basic abc")).toEqual([401, "challenge for api"]);
    expect(await challenge(api, "Bearer sess-nobody")).toEqual([401, "challenge for api"]);
    expect(await challenge(api, `Bearer ${REVOKED}`)).toEqual([401, "challenge for api"]);
    // A stale token is a 401 like any other, so a client that renews on a 401 asks again: at both doors.
    expect(await challenge(api, `Bearer ${STALE}`)).toEqual([401, "challenge for api"]);
    expect(await challenge(`${ORIGIN}/mcp`, `Bearer ${STALE}`, "mcp")).toEqual([
      401,
      "challenge for mcp",
    ]);
    expect(await challenge(api, `DPoP ${BAD_ACCESS_TOKEN}`)).toEqual([
      401,
      "challenge for api: invalid_dpop_proof",
    ]);
    expect(await challenge(`${ORIGIN}/mcp`, `DPoP ${BAD_ACCESS_TOKEN}`, "mcp")).toEqual([
      401,
      "challenge for mcp: invalid_dpop_proof",
    ]);
    expect(await challenge(`${ORIGIN}/mcp`, "Bearer sess-nobody", "mcp")).toEqual([
      401,
      "challenge for mcp",
    ]);
    // A refused token is never handed to the core gate.
    expect(g.seen.filter((credential) => credential._tag === "Claims")).toEqual([]);
  });

  it.effect(
    "[gate.stale-project] a token that names a run and no project is refused as stale once that run chose a project; one naming a project, another run's and one with no run are admitted",
    () =>
      Effect.gen(function* () {
        const label = Schema.decodeSync(RunLabel)("my-run");
        const run: RunRef = { id: runIdOf(KEYED, { label }), label };
        const other: RunRef = {
          id: runIdOf(KEYED, { label: Schema.decodeSync(RunLabel)("other") }),
        };
        const unchosen = keyedLayers();
        expect(yield* reason(claims({ run })).pipe(Effect.provide(unchosen))).toBe("admitted");
        const chose = keyedLayers({}, undefined, undefined, undefined, undefined, [[run, OWN]]);
        const refused = yield* principalOf(claims({ run })).pipe(
          Effect.flip,
          Effect.provide(chose),
        );
        expect(refused).toMatchObject({
          _tag: "TokenProjectStale",
          agentId: KEYED,
          run,
          projectId: OWN,
        });
        // A named project wins over the run's choice; another run, and a token of no run, chose nothing.
        const named = yield* principalOf(claims({ run, projectId: ELSEWHERE })).pipe(
          Effect.provide(chose),
        );
        expect(named.principal).toMatchObject({ projectId: ELSEWHERE });
        expect(yield* reason(claims({ run: other })).pipe(Effect.provide(chose))).toBe("admitted");
        expect(yield* reason(claims()).pipe(Effect.provide(chose))).toBe("admitted");
      }),
  );

  it("[gate.stale-project] a stale token is answered 401 invalid_token naming its run and project, with the way back", async () => {
    const answered = await recordingGate().answer(
      `${ORIGIN}/mcp`,
      {
        headers: { authorization: `Bearer ${STALE}` },
      },
      "mcp",
    );
    if (!(answered instanceof Response)) throw new Error("admitted");
    expect(answered.status).toBe(401);
    expect(await answered.json()).toMatchObject({
      code: "auth.invalid_token",
      detail: expect.stringContaining("Run my-run works in prj_1B1YM1A788YVAYHTR6G6KW69TD"),
      nextActions: [{ kind: "escalate" }],
    });
  });

  it.effect(
    "[gate.claims] an agent that signed itself up governs its own namespace: with a token that names no project, and with one for a project of its own",
    () =>
      Effect.gen(function* () {
        const account = yield* principalOf(claims());
        expect(account).toEqual({
          principal: {
            _tag: "Agent",
            agentId: KEYED,
            namespace: KEYED,
            scopes: ["agent:work", "agent:read"],
            paused: false,
            standing: { _tag: "Governs" },
          },
          token: { agentId: KEYED, scopes: ["agent:work", "agent:read"], revocationEpoch: 1 },
        });
        const own = yield* principalOf(claims({ projectId: OWN }));
        expect(own.principal).toMatchObject({
          namespace: KEYED,
          projectId: OWN,
          standing: { _tag: "Governs" },
        });
      }).pipe(Effect.provide(keyedLayers())),
  );

  it.effect(
    "[gate.claims] in another's namespace it has no standing, and a token for a project that has no place reads the same, so a token never tells whether a project exists",
    () =>
      Effect.gen(function* () {
        const elsewhere = yield* principalOf(claims({ projectId: ELSEWHERE }));
        expect(elsewhere.principal).toMatchObject({
          namespace: sampleOrgId,
          projectId: ELSEWHERE,
          standing: { _tag: "None" },
        });
        const nowhere = yield* principalOf(claims({ projectId: NOWHERE }));
        expect(nowhere.principal).toMatchObject({
          namespace: KEYED,
          projectId: NOWHERE,
          standing: { _tag: "None" },
        });
      }).pipe(Effect.provide(keyedLayers())),
  );

  it.effect(
    "[gate.invited] in an org a member invited it into and it accepted, it stands Invited by that member's standing now, with its token's scopes cut to the invitation's",
    () =>
      Effect.gen(function* () {
        const both = yield* invitedBy(ANN, ["agent:read", "agent:work"], ["Joined"]);
        const working = yield* principalOf(claims({ projectId: ELSEWHERE })).pipe(
          Effect.provide(keyedLayers({}, both)),
        );
        expect(working.principal).toMatchObject({
          namespace: sampleOrgId,
          projectId: ELSEWHERE,
          scopes: ["agent:work", "agent:read"],
          standing: { _tag: "Invited", by: { userId: ANN, role: "member", suspended: false } },
        });
        // The token itself is handed on as it was presented.
        expect(working.token?.scopes).toEqual(["agent:work", "agent:read"]);

        const readOnly = yield* invitedBy(ANN, ["agent:read"], ["Joined"]);
        const reading = yield* principalOf(claims({ projectId: ELSEWHERE })).pipe(
          Effect.provide(keyedLayers({}, readOnly)),
        );
        expect(reading.principal).toMatchObject({
          scopes: ["agent:read"],
          standing: { _tag: "Invited", by: { userId: ANN } },
        });
        // A token that asked for less holds no more for the invitation giving more.
        const narrow = yield* principalOf(
          claims({ projectId: ELSEWHERE, scopes: ["agent:read"] }),
        ).pipe(Effect.provide(keyedLayers({}, both)));
        expect(narrow.principal).toMatchObject({ scopes: ["agent:read"] });

        // Invited by someone who is no member of the org: the policy reads a standing with no role.
        const stranger = yield* invitedBy(BOB, ["agent:read", "agent:work"], ["Joined"]);
        const orphaned = yield* principalOf(claims({ projectId: ELSEWHERE })).pipe(
          Effect.provide(keyedLayers({}, stranger)),
        );
        expect(orphaned.principal).toMatchObject({
          standing: { _tag: "Invited", by: { userId: BOB, suspended: false } },
        });
        if (orphaned.principal._tag !== "Agent" || orphaned.principal.standing._tag !== "Invited")
          throw new Error("the agent was not admitted as invited");
        expect(orphaned.principal.standing.by.role).toBeUndefined();
      }),
  );

  it.effect(
    "[gate.invited] an invitation not yet accepted and one that ended give no standing and cut nothing; its own namespace is governed without a read of the org's rows",
    () =>
      Effect.gen(function* () {
        const pending = yield* invitedBy(ANN, ["agent:read"], []);
        const waiting = yield* principalOf(claims({ projectId: ELSEWHERE })).pipe(
          Effect.provide(keyedLayers({}, pending)),
        );
        expect(waiting.principal).toMatchObject({
          namespace: sampleOrgId,
          scopes: ["agent:work", "agent:read"],
        });
        // Invited and not yet joined: it never stood there, so it did not leave.
        expect(waiting.principal._tag === "Agent" && waiting.principal.standing).toEqual({
          _tag: "None",
        });

        const ended = yield* invitedBy(ANN, ["agent:read", "agent:work"], ["Joined", "Left"]);
        const gone = yield* principalOf(claims({ projectId: ELSEWHERE })).pipe(
          Effect.provide(keyedLayers({}, ended)),
        );
        // Its invitation ended: it stood there once, and is told it left.
        expect(gone.principal).toMatchObject({ standing: { _tag: "None", left: true } });

        // Where it governs, and where the project has no place, the rows are never read.
        const both = yield* invitedBy(ANN, ["agent:read", "agent:work"], ["Joined"]);
        const [reads, projectReads] = [{ count: 0 }, { count: 0 }];
        const layer = keyedLayers({}, both, reads, undefined, projectReads);
        const own = yield* principalOf(claims({ projectId: OWN })).pipe(Effect.provide(layer));
        const account = yield* principalOf(claims()).pipe(Effect.provide(layer));
        const nowhere = yield* principalOf(claims({ projectId: NOWHERE })).pipe(
          Effect.provide(layer),
        );
        expect(own.principal).toMatchObject({ standing: { _tag: "Governs" } });
        expect(account.principal).toMatchObject({ standing: { _tag: "Governs" } });
        expect(nowhere.principal._tag === "Agent" && nowhere.principal.standing).toEqual({
          _tag: "None",
        });
        // Neither table: not the org's rows, and not a project's.
        expect([reads.count, projectReads.count]).toEqual([0, 0]);
        yield* principalOf(claims({ projectId: ELSEWHERE })).pipe(Effect.provide(layer));
        expect([reads.count, projectReads.count]).toEqual([1, 0]);
      }),
  );

  it.effect(
    "[gate.project-invited] invited to one project of a person's own namespace and accepted, it stands Invited by that person, the namespace's owner, on that project, with its token's scopes cut; on another project of theirs it has no standing",
    () =>
      Effect.gen(function* () {
        const both = yield* invitedTo(HERS, ANN, ["agent:read", "agent:work"], ["Joined"]);
        const given = (rows: typeof both) => keyedLayers({}, undefined, undefined, rows);
        const working = yield* principalOf(claims({ projectId: HERS })).pipe(
          Effect.provide(given(both)),
        );
        expect(working.principal).toMatchObject({
          namespace: ANN,
          projectId: HERS,
          scopes: ["agent:work", "agent:read"],
          standing: {
            _tag: "Invited",
            by: { userId: ANN, role: "owner", suspended: false },
            projectOnly: true,
          },
        });

        const readOnly = yield* invitedTo(HERS, ANN, ["agent:read"], ["Joined"]);
        const reading = yield* principalOf(claims({ projectId: HERS })).pipe(
          Effect.provide(given(readOnly)),
        );
        expect(reading.principal).toMatchObject({
          scopes: ["agent:read"],
          standing: { _tag: "Invited", by: { userId: ANN } },
        });

        // Her other project: the invitation says nothing of it, and cuts nothing.
        const beside = yield* principalOf(claims({ projectId: HERS_TOO })).pipe(
          Effect.provide(given(readOnly)),
        );
        expect(beside.principal).toMatchObject({
          namespace: ANN,
          projectId: HERS_TOO,
          scopes: ["agent:work", "agent:read"],
          standing: { _tag: "None" },
        });

        // Invited by someone who does not own the namespace: a standing with no role, which the policy reads as none.
        const stranger = yield* invitedTo(HERS, BOB, ["agent:read", "agent:work"], ["Joined"]);
        const orphaned = yield* principalOf(claims({ projectId: HERS })).pipe(
          Effect.provide(given(stranger)),
        );
        if (orphaned.principal._tag !== "Agent" || orphaned.principal.standing._tag !== "Invited")
          throw new Error("the agent was not admitted as invited");
        expect(orphaned.principal.standing.by).toMatchObject({ userId: BOB, suspended: false });
        expect(orphaned.principal.standing.by.role).toBeUndefined();
      }),
  );

  it.effect(
    "[gate.project-invited] an invitation to a project not yet accepted and one that ended give no standing; a person's namespace reads the project's rows once and never the org's, and an org the other way",
    () =>
      Effect.gen(function* () {
        const pending = yield* invitedTo(HERS, ANN, ["agent:read"], []);
        const waiting = yield* principalOf(claims({ projectId: HERS })).pipe(
          Effect.provide(keyedLayers({}, undefined, undefined, pending)),
        );
        expect(waiting.principal).toMatchObject({
          scopes: ["agent:work", "agent:read"],
          standing: { _tag: "None" },
        });
        const ended = yield* invitedTo(HERS, ANN, ["agent:read", "agent:work"], ["Joined", "Left"]);
        const gone = yield* principalOf(claims({ projectId: HERS })).pipe(
          Effect.provide(keyedLayers({}, undefined, undefined, ended)),
        );
        expect(gone.principal).toMatchObject({ standing: { _tag: "None" } });

        // An org's rows give nothing in a person's namespace, and a project's nothing in an org.
        const inOrg = yield* invitedBy(ANN, ["agent:read", "agent:work"], ["Joined"]);
        const toHers = yield* invitedTo(HERS, ANN, ["agent:read", "agent:work"], ["Joined"]);
        const [reads, projectReads] = [{ count: 0 }, { count: 0 }];
        const layer = keyedLayers({}, inOrg, reads, toHers, projectReads);
        const hers = yield* principalOf(claims({ projectId: HERS })).pipe(Effect.provide(layer));
        expect(hers.principal).toMatchObject({ standing: { _tag: "Invited" } });
        expect([reads.count, projectReads.count]).toEqual([0, 1]);
        const theirs = yield* principalOf(claims({ projectId: ELSEWHERE })).pipe(
          Effect.provide(layer),
        );
        expect(theirs.principal).toMatchObject({ standing: { _tag: "Invited" } });
        // An org takes an agent whole: its standing there is not to one project.
        if (theirs.principal._tag !== "Agent" || theirs.principal.standing._tag !== "Invited")
          throw new Error("the agent was not admitted as invited");
        expect(theirs.principal.standing).not.toHaveProperty("projectOnly");
        expect([reads.count, projectReads.count]).toEqual([1, 1]);
        // Its own namespace, no project and a project with no place read neither.
        yield* principalOf(claims({ projectId: OWN })).pipe(Effect.provide(layer));
        yield* principalOf(claims()).pipe(Effect.provide(layer));
        yield* principalOf(claims({ projectId: NOWHERE })).pipe(Effect.provide(layer));
        expect([reads.count, projectReads.count]).toEqual([1, 1]);
      }),
  );

  it.effect(
    "[gate.claims] a paused agent is admitted as paused; a revoked one, a stale epoch and an unknown agent are refused",
    () =>
      Effect.gen(function* () {
        expect(yield* reason(claims())).toBe("admitted");
        expect(yield* reason(claims({ revocationEpoch: 0 }))).toBe("stale-epoch");
        expect(yield* reason(claims({ agentId: BOT }))).toBe("AgentNotKnown");
        expect(
          yield* reason(claims()).pipe(Effect.provide(keyedLayers({ state: "suspended" }))),
        ).toBe("paused");
        expect(
          yield* reason(claims()).pipe(Effect.provide(keyedLayers({ state: "revoked" }))),
        ).toBe("revoked");
      }).pipe(Effect.provide(keyedLayers())),
  );
});
