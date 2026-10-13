import { describe, expect, it } from "@effect/vitest";
import { type Credential, principalOf, type SignedIn } from "@keeltown/core/application/identity";
import type { Agent } from "@keeltown/core/domain/identity";
import { Instant, makeId } from "@keeltown/core/kernel";
import { TokenIssuer } from "@keeltown/core/ports";
import {
  hashSecret,
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeClockMemory,
  makeMembershipsMemory,
  makeTokenIssuerMemory,
  makeUsersMemory,
  sampleOrgId,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";
import {
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

/** A gate whose sessions are two fixed ones, recording each credential it asks to have admitted. */
function recordingGate() {
  const seen: Credential[] = [];
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
    admit: (credential) => {
      seen.push(credential);
      return Promise.resolve({ admitted: { principal: { _tag: "Anonymous" } } });
    },
  };
  const pass = async (init: RequestInit) => {
    const gated = await gate(new Request(`${ORIGIN}/v1/agents/sponsored`, init), "req-1", deps);
    return gated instanceof Response ? gated.status : "admitted";
  };
  return { seen, pass };
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
    clock,
  );
}

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
});
