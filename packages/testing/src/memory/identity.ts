import { type Agent, type Principal, TokenRejected } from "@keeltown/core/domain/identity";
import { type AgentId, Instant, makeId } from "@keeltown/core/kernel";
import {
  AgentDirectory,
  Clock,
  Ids,
  type StoredCredential,
  TokenIssuer,
} from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option } from "effect";

/** Time from Effect's own Clock, so `TestClock` drives it in tests. Production uses the same reading. */
export function makeClockMemory() {
  return {
    layer: Layer.succeed(
      Clock,
      Clock.of({ now: Effect.map(EffectClock.currentTimeMillis, (ms) => Instant(ms)) }),
    ),
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encode(n: number): string {
  let out = "";
  let rest = n;
  for (let i = 0; i < 26; i += 1) {
    out = (CROCKFORD[rest % 32] ?? "0") + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** Sequential, prefix-correct ids: `chg_00000000000000000000000001`, then `…02`. Deterministic across runs. */
export function makeIdsMemory() {
  let counter = 0;
  return {
    layer: Layer.succeed(
      Ids,
      Ids.of({
        next: (prefix) =>
          Effect.sync(() => {
            counter += 1;
            return makeId(prefix, encode(counter));
          }),
      }),
    ),
  };
}

/** `sha256:` and the hex digest of a secret, as credentials store it. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Compares two strings in time independent of where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Agents and credentials in maps. `seed` writes the projection directly, as enrolment's projector would. */
export function makeAgentDirectoryMemory() {
  const agents = new Map<AgentId, Agent>();
  const credentials = new Map<string, StoredCredential>();
  const seed = (agent: Agent, credential: StoredCredential): void => {
    agents.set(agent.id, agent);
    credentials.set(credential.clientId, credential);
  };
  return {
    agents,
    credentials,
    seed,
    layer: Layer.succeed(
      AgentDirectory,
      AgentDirectory.of({
        findAgent: (agentId) => Effect.sync(() => Option.fromNullishOr(agents.get(agentId))),
        findCredential: (clientId) =>
          Effect.sync(() => Option.fromNullishOr(credentials.get(clientId))),
        upsert: (agent, credential) => Effect.sync(() => seed(agent, credential)),
        verifyCredential: (clientId, secret) =>
          Effect.promise(async () => {
            const credential = credentials.get(clientId);
            if (credential === undefined) return Option.none();
            return constantTimeEqual(await hashSecret(secret), credential.secretHash)
              ? Option.some(credential.agentId)
              : Option.none();
          }),
      }),
    ),
  };
}

/**
 * Opaque random tokens mapped to their principal and expiry. Verification
 * reads the Clock port, so a test can expire a token by moving TestClock.
 */
export function makeTokenIssuerMemory() {
  const issued = new Map<string, { readonly principal: Principal; readonly expiresAt: number }>();
  return {
    issued,
    layer: Layer.effect(
      TokenIssuer,
      Effect.gen(function* () {
        const clock = yield* Clock;
        return TokenIssuer.of({
          issue: (principal, ttlSeconds) =>
            Effect.gen(function* () {
              const now = yield* clock.now;
              const token = `memtok_${crypto.randomUUID()}`;
              const expiresAt = Instant(now + ttlSeconds * 1000);
              issued.set(token, { principal, expiresAt });
              return { token, expiresAt };
            }),
          verify: (token) =>
            Effect.gen(function* () {
              const entry = issued.get(token);
              if (entry === undefined) return yield* new TokenRejected({ reason: "signature" });
              const now = yield* clock.now;
              if (now >= entry.expiresAt) return yield* new TokenRejected({ reason: "expired" });
              return entry.principal;
            }),
        });
      }),
    ),
  };
}
