import { type Agent, type AgentToken, TokenRejected } from "@keeltown/core/domain/identity";
import { type AgentId, Instant, makeId, type ProjectId } from "@keeltown/core/kernel";
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
  /** The seq of the standing event each agent's row last took. */
  const standingSeqs = new Map<AgentId, number>();
  /** The seq of the sponsor link's event each agent's row last took. */
  const sponsorSeqs = new Map<AgentId, number>();
  /** The project each run chose, by `agentId` and `runId` joined by a newline. */
  const runProjects = new Map<string, ProjectId>();
  /** Once a link event has written an agent's sponsor, an upsert leaves it as the row holds it. */
  const seed = (agent: Agent, credential: StoredCredential): void => {
    const held = agents.get(agent.id);
    if (held === undefined || !sponsorSeqs.has(agent.id)) agents.set(agent.id, agent);
    else {
      const { sponsor: _sponsor, ...rest } = agent;
      agents.set(agent.id, held.sponsor === undefined ? rest : { ...rest, sponsor: held.sponsor });
    }
    credentials.set(credential.clientId, credential);
  };
  return {
    agents,
    credentials,
    runProjects,
    seed,
    layer: Layer.succeed(
      AgentDirectory,
      AgentDirectory.of({
        findAgent: (agentId) => Effect.sync(() => Option.fromNullishOr(agents.get(agentId))),
        findCredential: (clientId) =>
          Effect.sync(() => Option.fromNullishOr(credentials.get(clientId))),
        upsert: (agent, credential) => Effect.sync(() => seed(agent, credential)),
        upsertAccount: (agent) => Effect.sync(() => void agents.set(agent.id, agent)),
        standing: (agentId, standing, seq) =>
          Effect.sync(() => {
            const agent = agents.get(agentId);
            if (agent === undefined || (standingSeqs.get(agentId) ?? 0) >= seq) return;
            agents.set(agentId, {
              ...agent,
              state: standing.state,
              revocationEpoch: standing.revocationEpoch ?? agent.revocationEpoch,
            });
            standingSeqs.set(agentId, seq);
          }),
        sponsor: (agentId, sponsor, seq) =>
          Effect.sync(() => {
            const agent = agents.get(agentId);
            if (agent === undefined || (sponsorSeqs.get(agentId) ?? 0) >= seq) return;
            const { sponsor: _sponsor, ...alone } = agent;
            agents.set(agentId, sponsor === null ? alone : { ...alone, sponsor });
            sponsorSeqs.set(agentId, seq);
          }),
        sponsoredBy: (userId) =>
          Effect.sync(() =>
            [...agents.values()]
              .filter((agent) => agent.sponsor === userId)
              .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
          ),
        runProject: (agentId, runId) =>
          Effect.sync(() => Option.fromNullishOr(runProjects.get(`${agentId}\n${runId}`))),
        chooseProject: (agentId, runId, projectId) =>
          Effect.sync(() => void runProjects.set(`${agentId}\n${runId}`, projectId)),
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
  const issued = new Map<string, { readonly principal: AgentToken; readonly expiresAt: number }>();
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
