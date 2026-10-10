import { describe, expect, it } from "@effect/vitest";
import type { Agent } from "@keeltown/core/domain/identity";
import { AgentId, idPattern, ID_PREFIXES, type IdPrefix, Instant, ProjectId } from "@keeltown/core/kernel";
import { AgentDirectory, Clock, EntityStore, Ids, TokenIssuer } from "@keeltown/core/ports";
import { Effect, type Layer, Option, Schema } from "effect";
import { hashSecret } from "../memory/identity.ts";
import { TestClock } from "effect/testing";

/**
 * Port contract suites. Every adapter of a port, in memory or real, must pass
 * its port's suite: the in-memory adapter on Node, the real one in the workers
 * pool or live. A suite takes a factory, so each test gets a fresh adapter.
 *
 * Ports whose behaviour is not yet specified carry one `todo` per method; the
 * owning lane turns each into a real case when it builds the adapter.
 */
export type LayerFactory<S> = () => Layer.Layer<S>;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A fresh agent id per test. A real adapter's storage may outlive one test
 * (D1 persists across a file's tests), so no case may assume an empty store.
 */
function freshAgentId(): AgentId {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return Schema.decodeUnknownSync(AgentId)(`agt_${[...bytes].map((b) => CROCKFORD[b % 32] ?? "0").join("")}`);
}

const agentId = freshAgentId();

export function describeClockContract(adapter: string, make: LayerFactory<Clock>) {
  describe(`Clock contract: ${adapter}`, () => {
    it.effect("never goes backwards", () =>
      Effect.gen(function* () {
        const clock = yield* Clock;
        const first = yield* clock.now;
        yield* TestClock.adjust(5);
        const second = yield* clock.now;
        expect(second).toBeGreaterThanOrEqual(first);
      }).pipe(Effect.provide(make())),
    );
  });
}

export function describeIdsContract(adapter: string, make: LayerFactory<Ids>) {
  describe(`Ids contract: ${adapter}`, () => {
    it.effect("mints an id matching its prefix, for every prefix", () =>
      Effect.gen(function* () {
        const ids = yield* Ids;
        for (const prefix of Object.values(ID_PREFIXES) as IdPrefix[]) {
          const id = yield* ids.next(prefix);
          expect(id).toMatch(idPattern(prefix));
        }
      }).pipe(Effect.provide(make())),
    );
    it.effect("never repeats an id", () =>
      Effect.gen(function* () {
        const ids = yield* Ids;
        const minted = yield* Effect.forEach(Array.from({ length: 200 }), () => ids.next("chg"));
        expect(new Set(minted).size).toBe(minted.length);
      }).pipe(Effect.provide(make())),
    );
  });
}

/** The project every contract fixture is enrolled in. */
export const sampleProjectId = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

export const sampleAgent: Agent = {
  id: agentId,
  projectId: sampleProjectId,
  name: "contract-agent",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  state: "active",
  revocationEpoch: 0,
  createdAt: Instant(1_760_000_000_000),
};

export function describeAgentDirectoryContract(adapter: string, make: LayerFactory<AgentDirectory>) {
  describe(`AgentDirectory contract: ${adapter}`, () => {
    it.effect("verifies a credential by its secret, and only by its secret", () =>
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const id = freshAgentId();
        const clientId = `client-${id}`;
        const secretHash = yield* Effect.promise(() => hashSecret("s3cret-value"));
        yield* directory.upsert({ ...sampleAgent, id }, { clientId, agentId: id, secretHash });
        expect(yield* directory.verifyCredential(clientId, "s3cret-value")).toEqual(Option.some(id));
        expect(Option.isNone(yield* directory.verifyCredential(clientId, "s3cret-valuE"))).toBe(true);
        expect(Option.isNone(yield* directory.verifyCredential(`never-${id}`, "s3cret-value"))).toBe(true);
      }).pipe(Effect.provide(make())),
    );
    it.effect("finds nothing it was not given", () =>
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const id = freshAgentId();
        expect(Option.isNone(yield* directory.findAgent(id))).toBe(true);
        expect(Option.isNone(yield* directory.findCredential(`never-${id}`))).toBe(true);
      }).pipe(Effect.provide(make())),
    );
    it.effect("returns an upserted agent and credential exactly", () =>
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const id = freshAgentId();
        const agent = { ...sampleAgent, id };
        const credential = { clientId: `client-${id}`, agentId: id, secretHash: `sha256:${"a".repeat(64)}` };
        yield* directory.upsert(agent, credential);
        expect(yield* directory.findAgent(id)).toEqual(Option.some(agent));
        expect(yield* directory.findCredential(credential.clientId)).toEqual(Option.some(credential));
      }).pipe(Effect.provide(make())),
    );
    it.effect("replaces an agent on a second upsert, so a revocation epoch bump is visible", () =>
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const id = freshAgentId();
        const credential = { clientId: `client-${id}`, agentId: id, secretHash: `sha256:${"a".repeat(64)}` };
        yield* directory.upsert({ ...sampleAgent, id }, credential);
        yield* directory.upsert({ ...sampleAgent, id, revocationEpoch: 1, state: "revoked" }, credential);
        const found = yield* directory.findAgent(id);
        expect(Option.map(found, (a) => [a.revocationEpoch, a.state])).toEqual(Option.some([1, "revoked"]));
      }).pipe(Effect.provide(make())),
    );
  });
}

export function describeTokenIssuerContract(adapter: string, make: LayerFactory<TokenIssuer>) {
  const principal = { agentId, projectId: sampleProjectId, scopes: ["agent:read"] as const, revocationEpoch: 3 };
  describe(`TokenIssuer contract: ${adapter}`, () => {
    it.effect("verifies the principal it issued", () =>
      Effect.gen(function* () {
        const issuer = yield* TokenIssuer;
        const { token } = yield* issuer.issue(principal, 60);
        expect(yield* issuer.verify(token)).toEqual(principal);
      }).pipe(Effect.provide(make())),
    );
    it.effect("rejects a token after it expires", () =>
      Effect.gen(function* () {
        const issuer = yield* TokenIssuer;
        const { token } = yield* issuer.issue(principal, 60);
        yield* TestClock.adjust(61_000);
        const result = yield* Effect.flip(issuer.verify(token));
        expect(result._tag).toBe("TokenRejected");
      }).pipe(Effect.provide(make())),
    );
    it.effect("rejects a token it did not issue", () =>
      Effect.gen(function* () {
        const issuer = yield* TokenIssuer;
        const result = yield* Effect.flip(issuer.verify("not-a-token"));
        expect(result._tag).toBe("TokenRejected");
      }).pipe(Effect.provide(make())),
    );
  });
}

export function describeEntityStoreContract(adapter: string, make: LayerFactory<EntityStore>) {
  describe(`EntityStore contract: ${adapter}`, () => {
    it.effect("reads back what it wrote, by kind and id", () =>
      Effect.gen(function* () {
        const store = yield* EntityStore;
        store.put("change", "a", { state: "working", n: 1 });
        store.put("lease", "a", { state: "active" });
        expect(store.get("change", "a")).toEqual({ state: "working", n: 1 });
        expect(store.get("lease", "a")).toEqual({ state: "active" });
        expect(store.list("change")).toEqual([{ id: "a", value: { state: "working", n: 1 } }]);
      }).pipe(Effect.provide(make())),
    );
    it.effect("commits a transaction's writes together", () =>
      Effect.gen(function* () {
        const store = yield* EntityStore;
        store.transaction(() => {
          store.put("change", "a", 1);
          store.put("change", "b", 2);
        });
        expect([store.get("change", "a"), store.get("change", "b")]).toEqual([1, 2]);
      }).pipe(Effect.provide(make())),
    );
    it.effect("commits nothing when the transaction throws", () =>
      Effect.gen(function* () {
        const store = yield* EntityStore;
        store.put("change", "a", 1);
        expect(() =>
          store.transaction(() => {
            store.put("change", "a", 2);
            store.put("change", "b", 3);
            throw new Error("decision refused");
          }),
        ).toThrow("decision refused");
        expect([store.get("change", "a"), store.get("change", "b")]).toEqual([1, undefined]);
      }).pipe(Effect.provide(make())),
    );
    it.effect("returns a copy, so mutating a read never writes", () =>
      Effect.gen(function* () {
        const store = yield* EntityStore;
        store.put("change", "a", { n: 1 });
        const read = store.get("change", "a");
        if (read !== null && typeof read === "object" && !Array.isArray(read)) Object.assign(read, { n: 2 });
        expect(store.get("change", "a")).toEqual({ n: 1 });
      }).pipe(Effect.provide(make())),
    );
  });
}

/** A port whose contract is not written yet: one named `todo` per method, so the gap is visible in every run. */
export function describePendingContract(port: string, adapter: string, methods: readonly string[]) {
  describe(`${port} contract: ${adapter}`, () => {
    for (const method of methods) it.todo(`${port}.${method}`);
  });
}
