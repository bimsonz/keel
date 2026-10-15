import { describe, expect, it } from "@effect/vitest";
import {
  type Agent,
  type AgentKey,
  agentIdOf,
  givenHandle,
  KeyThumbprint,
} from "@keeltown/core/domain/identity";
import {
  AgentId,
  idPattern,
  ID_PREFIXES,
  type IdPrefix,
  Instant,
  OrgId,
  ProjectId,
  RunId,
  UserId,
} from "@keeltown/core/kernel";
import { AgentDirectory, Clock, EntityStore, Ids, TokenIssuer } from "@keeltown/core/ports";
import { Effect, type Layer, Option, Schema } from "effect";
import { hashSecret } from "../memory/identity.ts";
import { makeEntityStoreMemory } from "../memory/storage.ts";
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
  return Schema.decodeUnknownSync(AgentId)(
    `agt_${[...bytes].map((b) => CROCKFORD[b % 32] ?? "0").join("")}`,
  );
}

function freshUserId(): UserId {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return Schema.decodeUnknownSync(UserId)(
    `usr_${[...bytes].map((b) => CROCKFORD[b % 32] ?? "0").join("")}`,
  );
}

/** A fresh id body: 26 characters of Crockford's base 32. */
const freshBody = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const freshRunId = (): RunId => Schema.decodeUnknownSync(RunId)(`run_${freshBody()}`);
const freshProjectId = (): ProjectId => Schema.decodeUnknownSync(ProjectId)(`prj_${freshBody()}`);

const agentId = freshAgentId();

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const randomBase64url = (length: number): string =>
  [...crypto.getRandomValues(new Uint8Array(length))].map((b) => BASE64URL[b % 64] ?? "A").join("");

/** A fresh Ed25519 public key as an agent holds it: random, so no two cases share one. */
export function freshAgentKey(addedAt: Instant = Instant(1_760_000_000_000)): AgentKey {
  const random = randomBase64url;
  return {
    jkt: Schema.decodeUnknownSync(KeyThumbprint)(random(43)),
    jwk: { kty: "OKP", crv: "Ed25519", x: random(43) },
    addedAt,
  };
}

/** An agent as signing up with `keys[0]` leaves it: its id and handle made from that key. */
export function signedUpAgent(keys: readonly AgentKey[] = [freshAgentKey()]): Agent {
  const [first] = keys;
  if (first === undefined) throw new Error("an agent signs up with a key");
  const id = agentIdOf(first.jkt);
  return {
    id,
    handle: givenHandle(id),
    name: givenHandle(id),
    scopes: ["agent:work", "agent:read"],
    keys,
    state: "active",
    revocationEpoch: 0,
    createdAt: first.addedAt,
  };
}

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
export const sampleProjectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
);

/** The org and the sponsoring user of the tenancy fixtures. */
export const sampleOrgId = Schema.decodeUnknownSync(OrgId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
export const sampleSponsorId = Schema.decodeUnknownSync(UserId)("usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

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

export function describeAgentDirectoryContract(
  adapter: string,
  make: LayerFactory<AgentDirectory>,
) {
  describe(`AgentDirectory contract: ${adapter}`, () => {
    it.effect("verifies a credential by its secret, and only by its secret", () =>
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const id = freshAgentId();
        const clientId = `client-${id}`;
        const secretHash = yield* Effect.promise(() => hashSecret("s3cret-value"));
        yield* directory.upsert({ ...sampleAgent, id }, { clientId, agentId: id, secretHash });
        expect(yield* directory.verifyCredential(clientId, "s3cret-value")).toEqual(
          Option.some(id),
        );
        expect(Option.isNone(yield* directory.verifyCredential(clientId, "s3cret-valuE"))).toBe(
          true,
        );
        expect(
          Option.isNone(yield* directory.verifyCredential(`never-${id}`, "s3cret-value")),
        ).toBe(true);
      }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[agentdir.run-project] keeps the project each run chose, the latest choice alone",
      () =>
        Effect.gen(function* () {
          const directory = yield* AgentDirectory;
          const id = freshAgentId();
          const [run, other] = [freshRunId(), freshRunId()];
          const [first, second] = [freshProjectId(), freshProjectId()];
          expect(Option.isNone(yield* directory.runProject(id, run))).toBe(true);
          yield* directory.chooseProject(id, run, first, Instant(1_760_000_000_000));
          expect(yield* directory.runProject(id, run)).toEqual(Option.some(first));
          // Another run of the agent, and the same run's id under another agent, chose nothing.
          expect(Option.isNone(yield* directory.runProject(id, other))).toBe(true);
          expect(Option.isNone(yield* directory.runProject(freshAgentId(), run))).toBe(true);
          yield* directory.chooseProject(id, run, second, Instant(1_760_000_001_000));
          expect(yield* directory.runProject(id, run)).toEqual(Option.some(second));
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
        const credential = {
          clientId: `client-${id}`,
          agentId: id,
          secretHash: `sha256:${"a".repeat(64)}`,
        };
        yield* directory.upsert(agent, credential);
        expect(yield* directory.findAgent(id)).toEqual(Option.some(agent));
        expect(yield* directory.findCredential(credential.clientId)).toEqual(
          Option.some(credential),
        );
      }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[tenancy.directory-org] returns an agent's org and sponsoring user exactly, and neither for an agent without them",
      () =>
        Effect.gen(function* () {
          const directory = yield* AgentDirectory;
          const sponsored = {
            ...sampleAgent,
            id: freshAgentId(),
            org: sampleOrgId,
            sponsor: sampleSponsorId,
          };
          const bare = { ...sampleAgent, id: freshAgentId() };
          for (const agent of [sponsored, bare])
            yield* directory.upsert(agent, {
              clientId: `client-${agent.id}`,
              agentId: agent.id,
              secretHash: `sha256:${"a".repeat(64)}`,
            });
          expect(yield* directory.findAgent(sponsored.id)).toEqual(Option.some(sponsored));
          const found = yield* directory.findAgent(bare.id);
          expect(Option.map(found, (agent) => ["org" in agent, "sponsor" in agent])).toEqual(
            Option.some([false, false]),
          );
        }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[signup.directory] returns an agent that signed up by key exactly: its handle and keys, and no project or kind",
      () =>
        Effect.gen(function* () {
          const directory = yield* AgentDirectory;
          const agent = signedUpAgent();
          yield* directory.upsertAccount(agent);
          const found = yield* directory.findAgent(agent.id);
          expect(found).toEqual(Option.some(agent));
          expect(Option.map(found, (a) => ["projectId" in a, "kind" in a])).toEqual(
            Option.some([false, false]),
          );
        }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[signup.directory] an account's keys are exactly the ones it was last written with, oldest first",
      () =>
        Effect.gen(function* () {
          const directory = yield* AgentDirectory;
          const first = freshAgentKey(Instant(1_760_000_000_000));
          const second = freshAgentKey(Instant(1_760_000_060_000));
          const agent = signedUpAgent([first, second]);
          yield* directory.upsertAccount(agent);
          expect(Option.map(yield* directory.findAgent(agent.id), (a) => a.keys)).toEqual(
            Option.some([first, second]),
          );
          yield* directory.upsertAccount({ ...agent, keys: [second], revocationEpoch: 1 });
          expect(
            Option.map(yield* directory.findAgent(agent.id), (a) => [a.keys, a.revocationEpoch]),
          ).toEqual(Option.some([[second], 1]));
        }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[signup.directory] an agent that signed up by key comes back from its sponsor's list exactly as it is, its own keys with it and no other agent's",
      () =>
        Effect.gen(function* () {
          const directory = yield* AgentDirectory;
          const sponsor = freshUserId();
          const first = signedUpAgent([
            freshAgentKey(Instant(1_760_000_000_000)),
            freshAgentKey(Instant(1_760_000_060_000)),
          ]);
          const second = { ...signedUpAgent(), createdAt: Instant(1_760_000_120_000) };
          const unsponsored = signedUpAgent();
          for (const agent of [first, second, unsponsored]) yield* directory.upsertAccount(agent);
          yield* directory.sponsor(first.id, sponsor, 1);
          yield* directory.sponsor(second.id, sponsor, 1);
          expect(yield* directory.sponsoredBy(sponsor)).toEqual([
            { ...first, sponsor },
            { ...second, sponsor },
          ]);
        }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[signup.directory] an agent enrolled by a person comes back with no handle and no keys",
      () =>
        Effect.gen(function* () {
          const directory = yield* AgentDirectory;
          const agent = { ...sampleAgent, id: freshAgentId() };
          yield* directory.upsert(agent, {
            clientId: `client-${agent.id}`,
            agentId: agent.id,
            secretHash: `sha256:${"a".repeat(64)}`,
          });
          expect(
            Option.map(yield* directory.findAgent(agent.id), (a) => ["handle" in a, "keys" in a]),
          ).toEqual(Option.some([false, false]));
        }).pipe(Effect.provide(make())),
    );
    it.effect("[a11e.synthetic] returns a synthetic agent, the load generator's, exactly", () =>
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const agent = { ...sampleAgent, id: freshAgentId(), kind: "synthetic" as const };
        yield* directory.upsert(agent, {
          clientId: `client-${agent.id}`,
          agentId: agent.id,
          secretHash: `sha256:${"a".repeat(64)}`,
        });
        expect(yield* directory.findAgent(agent.id)).toEqual(Option.some(agent));
      }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[b11.standing-guard] takes a standing only from a later seq than the row's, and keeps its epoch unless one is given",
      () =>
        Effect.gen(function* () {
          const directory = yield* AgentDirectory;
          const id = freshAgentId();
          yield* directory.upsert(
            { ...sampleAgent, id },
            { clientId: `client-${id}`, agentId: id, secretHash: `sha256:${"a".repeat(64)}` },
          );
          const standing = () =>
            Effect.map(directory.findAgent(id), (found) =>
              Option.map(found, (agent) => [agent.state, agent.revocationEpoch]),
            );
          yield* directory.standing(id, { state: "suspended" }, 3);
          expect(yield* standing()).toEqual(Option.some(["suspended", 0]));
          // The reinstatement before it arrives late: the row keeps the suspension.
          yield* directory.standing(id, { state: "active" }, 2);
          expect(yield* standing()).toEqual(Option.some(["suspended", 0]));
          yield* directory.standing(id, { state: "revoked", revocationEpoch: 1 }, 4);
          expect(yield* standing()).toEqual(Option.some(["revoked", 1]));
          // A repeat of the same seq is no newer.
          yield* directory.standing(id, { state: "active", revocationEpoch: 0 }, 4);
          expect(yield* standing()).toEqual(Option.some(["revoked", 1]));
          const unknown = freshAgentId();
          yield* directory.standing(unknown, { state: "suspended" }, 1);
          expect(Option.isNone(yield* directory.findAgent(unknown))).toBe(true);
        }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[link.sponsor-directory] takes a sponsor only from a later seq than the row's, clears it on null, and an upsert no longer moves it",
      () =>
        Effect.gen(function* () {
          const directory = yield* AgentDirectory;
          const id = freshAgentId();
          const first = freshUserId();
          const second = freshUserId();
          const credential = {
            clientId: `client-${id}`,
            agentId: id,
            secretHash: `sha256:${"a".repeat(64)}`,
          };
          const enrolled = { ...sampleAgent, id, org: sampleOrgId, sponsor: sampleSponsorId };
          yield* directory.upsert(enrolled, credential);
          const sponsor = () =>
            Effect.map(directory.findAgent(id), (found) =>
              Option.map(found, (agent) => agent.sponsor ?? null),
            );
          const sponsored = (userId: UserId) =>
            Effect.map(directory.sponsoredBy(userId), (agents) => agents.map((agent) => agent.id));
          expect(yield* sponsored(sampleSponsorId)).toContain(id);
          yield* directory.sponsor(id, null, 3);
          expect(yield* sponsor()).toEqual(Option.some(null));
          expect(yield* sponsored(sampleSponsorId)).not.toContain(id);
          yield* directory.sponsor(id, first, 5);
          expect(yield* sponsor()).toEqual(Option.some(first));
          expect(yield* sponsored(first)).toEqual([id]);
          // The end of the link before it arrives late, and a repeat of the same seq: neither moves the row.
          yield* directory.sponsor(id, null, 4);
          yield* directory.sponsor(id, second, 5);
          expect(yield* sponsor()).toEqual(Option.some(first));
          expect(yield* sponsored(second)).toEqual([]);
          // An enrolment replayed by its key carries the sponsor it first had: the row keeps the link's.
          yield* directory.upsert(enrolled, credential);
          expect(yield* sponsor()).toEqual(Option.some(first));
          yield* directory.sponsor(id, null, 6);
          yield* directory.upsert(enrolled, credential);
          expect(yield* sponsor()).toEqual(Option.some(null));
          const unknown = freshAgentId();
          yield* directory.sponsor(unknown, first, 1);
          expect(Option.isNone(yield* directory.findAgent(unknown))).toBe(true);
        }).pipe(Effect.provide(make())),
    );
    it.effect("replaces an agent on a second upsert, so a revocation epoch bump is visible", () =>
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const id = freshAgentId();
        const credential = {
          clientId: `client-${id}`,
          agentId: id,
          secretHash: `sha256:${"a".repeat(64)}`,
        };
        yield* directory.upsert({ ...sampleAgent, id }, credential);
        yield* directory.upsert(
          { ...sampleAgent, id, revocationEpoch: 1, state: "revoked" },
          credential,
        );
        const found = yield* directory.findAgent(id);
        expect(Option.map(found, (a) => [a.revocationEpoch, a.state])).toEqual(
          Option.some([1, "revoked"]),
        );
      }).pipe(Effect.provide(make())),
    );
  });
}

export function describeTokenIssuerContract(adapter: string, make: LayerFactory<TokenIssuer>) {
  const principal = {
    agentId,
    projectId: sampleProjectId,
    scopes: ["agent:read"] as const,
    revocationEpoch: 3,
  };
  describe(`TokenIssuer contract: ${adapter}`, () => {
    it.effect("verifies the principal it issued", () =>
      Effect.gen(function* () {
        const issuer = yield* TokenIssuer;
        const { token } = yield* issuer.issue(principal, 60);
        expect(yield* issuer.verify(token)).toEqual(principal);
      }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[tenancy.token-org] verifies the org and the sponsoring user it issued, each on its own, and neither for a principal without them",
      () =>
        Effect.gen(function* () {
          const issuer = yield* TokenIssuer;
          for (const tenant of [
            { ...principal, org: sampleOrgId, sponsor: sampleSponsorId },
            { ...principal, org: sampleOrgId },
            { ...principal, sponsor: sampleSponsorId },
          ])
            expect(yield* issuer.verify((yield* issuer.issue(tenant, 60)).token)).toEqual(tenant);
          const bare = yield* issuer.verify((yield* issuer.issue(principal, 60)).token);
          expect(["org" in bare, "sponsor" in bare]).toEqual([false, false]);
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

/**
 * One store for one test. `run` executes a program against it, inside
 * whatever context its storage needs (a Durable Object's, for DO SQLite);
 * every `run` in a test sees the same storage.
 */
export interface EntityStoreHarness {
  readonly run: <A, E>(program: Effect.Effect<A, E, EntityStore>) => Effect.Effect<A, E>;
}

/** The in-memory harness: a fresh memory store. */
export function memoryEntityStoreHarness(): EntityStoreHarness {
  const layer = makeEntityStoreMemory().layer;
  return { run: (program) => Effect.provide(program, layer) };
}

export function describeEntityStoreContract(adapter: string, make: () => EntityStoreHarness) {
  describe(`EntityStore contract: ${adapter}`, () => {
    it.effect("reads back what it wrote, by kind and id", () =>
      make().run(
        Effect.gen(function* () {
          const store = yield* EntityStore;
          store.put("change", "a", { state: "working", n: 1 });
          store.put("lease", "a", { state: "active" });
          expect(store.get("change", "a")).toEqual({ state: "working", n: 1 });
          expect(store.get("lease", "a")).toEqual({ state: "active" });
          expect(store.list("change")).toEqual([{ id: "a", value: { state: "working", n: 1 } }]);
        }),
      ),
    );
    it.effect(
      "[t694.list-prefix] lists a kind in id order, and by a prefix only the ids that start with it",
      () =>
        make().run(
          Effect.gen(function* () {
            const store = yield* EntityStore;
            const ids = ["b/2", "a", "b/1", "b", "b0", "c/b/1", "b/\u{1F600}", "b/\uFFFD", "a/b"];
            for (const id of ids) store.put("row", id, id);
            store.put("other", "b/3", 3);
            const listed = (prefix?: string) => store.list("row", prefix).map((row) => row.id);
            const inOrder = [
              "a",
              "a/b",
              "b",
              "b/1",
              "b/2",
              "b/\uFFFD",
              "b/\u{1F600}",
              "b0",
              "c/b/1",
            ];
            expect(listed()).toEqual(inOrder);
            expect(listed("")).toEqual(inOrder);
            expect(listed("b/")).toEqual(["b/1", "b/2", "b/\uFFFD", "b/\u{1F600}"]);
            expect(listed("b")).toEqual(["b", "b/1", "b/2", "b/\uFFFD", "b/\u{1F600}", "b0"]);
            expect(listed("b/\u{1F600}")).toEqual(["b/\u{1F600}"]);
            expect(listed("b/\uFFFD")).toEqual(["b/\uFFFD"]);
            expect(listed("c/b/")).toEqual(["c/b/1"]);
            expect(listed("d")).toEqual([]);
            expect(store.list("row", "b/2")).toEqual([{ id: "b/2", value: "b/2" }]);
          }),
        ),
    );
    it.effect("commits a transaction's writes together", () =>
      make().run(
        Effect.gen(function* () {
          const store = yield* EntityStore;
          store.transaction(() => {
            store.put("change", "a", 1);
            store.put("change", "b", 2);
          });
          expect([store.get("change", "a"), store.get("change", "b")]).toEqual([1, 2]);
        }),
      ),
    );
    it.effect("commits nothing when the transaction throws", () =>
      make().run(
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
        }),
      ),
    );
    it.effect("returns a copy, so mutating a read never writes", () =>
      make().run(
        Effect.gen(function* () {
          const store = yield* EntityStore;
          store.put("change", "a", { n: 1 });
          const read = store.get("change", "a");
          if (read !== null && typeof read === "object" && !Array.isArray(read))
            Object.assign(read, { n: 2 });
          expect(store.get("change", "a")).toEqual({ n: 1 });
        }),
      ),
    );
  });
}

/** A port whose contract is not written yet: one named `todo` per method, so the gap is visible in every run. */
export function describePendingContract(port: string, adapter: string, methods: readonly string[]) {
  describe(`${port} contract: ${adapter}`, () => {
    for (const method of methods) it.todo(`${port}.${method}`);
  });
}

export * from "./event-outbox.ts";
