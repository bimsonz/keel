import { describe, expect, it } from "@effect/vitest";
import {
  type Credential,
  type PresentedToken,
  principalOf,
  type SignedIn,
} from "@keeltown/core/application/identity";
import type { Agent, AgentClaims } from "@keeltown/core/domain/identity";
import { Instant, makeId } from "@keeltown/core/kernel";
import { TokenIssuer } from "@keeltown/core/ports";
import {
  hashSecret,
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeClockMemory,
  makeMembershipsMemory,
  makeProjectNamespacesMemory,
  makeTokenIssuerMemory,
  makeUsersMemory,
  sampleOrgId,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";
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
    clock,
  );
}

const KEYED = makeId("agt", ulidOf(54));
const OWN = makeId("prj", ulidOf(55));
const ELSEWHERE = makeId("prj", ulidOf(56));
const NOWHERE = makeId("prj", ulidOf(57));

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

/** The ports with the keyed agent as `override` has it, one project in its own namespace and one in an org. */
function keyedLayers(override: Partial<Agent> = {}) {
  const directory = makeAgentDirectoryMemory();
  directory.agents.set(KEYED, { ...keyed, ...override });
  const places = makeProjectNamespacesMemory();
  places.places.set(OWN, { projectId: OWN, namespace: KEYED, name: "mine" });
  places.places.set(ELSEWHERE, { projectId: ELSEWHERE, namespace: sampleOrgId, name: "theirs" });
  const rows = makeBetterAuthMemory();
  const clock = makeClockMemory().layer;
  return Layer.mergeAll(
    directory.layer,
    makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
    makeUsersMemory(rows).layer,
    makeMembershipsMemory(rows).layer,
    places.layer,
    clock,
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
          org: sampleOrgId,
          paused: false,
          standing: { _tag: "None" },
        });
      }).pipe(Effect.provide(layers({ sponsor: undefined }))),
  );

  it.effect(
    "[gate.sponsorless] an agent somebody stands behind stands as that person does in its org, and one in no org is refused by name",
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
    "[gate.claims] an agent that signed itself up governs its own namespace: with a token that names no project, and with one for a project of its own",
    () =>
      Effect.gen(function* () {
        const account = yield* principalOf(claims());
        expect(account).toEqual({
          principal: {
            _tag: "Agent",
            agentId: KEYED,
            org: KEYED,
            scopes: ["agent:work", "agent:read"],
            paused: false,
            standing: { _tag: "Governs" },
          },
          token: { agentId: KEYED, scopes: ["agent:work", "agent:read"], revocationEpoch: 1 },
        });
        const own = yield* principalOf(claims({ projectId: OWN }));
        expect(own.principal).toMatchObject({
          org: KEYED,
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
          org: sampleOrgId,
          projectId: ELSEWHERE,
          standing: { _tag: "None" },
        });
        const nowhere = yield* principalOf(claims({ projectId: NOWHERE }));
        expect(nowhere.principal).toMatchObject({
          org: KEYED,
          projectId: NOWHERE,
          standing: { _tag: "None" },
        });
      }).pipe(Effect.provide(keyedLayers())),
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
