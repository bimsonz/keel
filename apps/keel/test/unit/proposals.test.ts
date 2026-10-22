// Proposing from a fork, as the doorway does once the policy let the proposer
// ask: the fork must be the project's, the commit its trunk's, and the base
// the newest point where the fork met the project that the commit holds.
import { describe, expect, it } from "@effect/vitest";
import { MAX_OPEN_PROPOSALS } from "@keeltown/core/application/coordination";
import {
  projectRepos,
  proposeFromFork,
  updateFromFork,
} from "@keeltown/core/application/integration";
import {
  type ChangeId,
  type CommitSha,
  Instant,
  makeId,
  type NamespaceId,
  type ProjectId,
  userActor,
} from "@keeltown/core/kernel";
import { QuotaExceeded } from "@keeltown/core/domain/identity";
import { PushRejected } from "@keeltown/core/domain/integration";
import {
  Changes,
  CodeHost,
  type InstanceQuotasConfig,
  PackTooLarge,
  Trunks,
} from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeChangesMemory,
  makeCodeHostMemory,
  makeNamespaceUsageMemory,
  makeProjectNamespacesMemory,
  makeProposalLedgerMemory,
  makeTrunksMemory,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";
import { ulid } from "ulid";

const UPSTREAM: ProjectId = makeId("prj", ulid());
const FORK: ProjectId = makeId("prj", ulid());
const ORG: NamespaceId = makeId("org", ulid());
/** The fork's own org, apart from the project's it was forked from. */
const FORK_ORG: NamespaceId = makeId("org", ulid());
const ANN = userActor(makeId("usr", ulid()));
const FORK_TRUNK = projectRepos(FORK).trunk;
const MAIN = "refs/heads/main";

/**
 * The fork's trunk: the fork point `a`; a landing of its own `f1`; Keel's
 * merge `m` of the upstream's `e` (on `a`); a later landing `f2`; and `off`, a
 * commit on `a` that never reached the fork's main. Its Trunk says it was
 * forked from UPSTREAM at `a`, is at `f2`, and met its upstream at `m`.
 */
async function forkWorld(options: { readonly quotas?: InstanceQuotasConfig } = {}) {
  const code = makeCodeHostMemory();
  const trunks = makeTrunksMemory();
  const changes = makeChangesMemory();
  const ledger = makeProposalLedgerMemory();
  const places = makeProjectNamespacesMemory();
  places.places.set(UPSTREAM, { projectId: UPSTREAM, namespace: ORG, name: "upstream" });
  places.places.set(FORK, { projectId: FORK, namespace: FORK_ORG, name: "fork" });
  const commits = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(FORK_TRUNK);
      const at = (ref: string, files: Record<string, string>, merged?: readonly CommitSha[]) =>
        Effect.flatMap(CodeHostFixture, (f) => f.commit(FORK_TRUNK, ref, files, merged));
      const base = { "README.md": "upstream\n" };
      const a = yield* at(MAIN, base);
      const e = yield* at("refs/heads/up", { "README.md": "upstream, later\n" }, [a]);
      const f1 = yield* at(MAIN, { ...base, "retry.ts": "1\n" });
      const m = yield* at(MAIN, { "README.md": "upstream, later\n", "retry.ts": "1\n" }, [e]);
      const f2 = yield* at(MAIN, { "README.md": "upstream, later\n", "retry.ts": "2\n" });
      const off = yield* at("refs/heads/side", { ...base, "side.ts": "x\n" }, [a]);
      return { a, e, f1, m, f2, off };
    }).pipe(Effect.provide(code.layer)),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* Trunks;
      yield* port.initialize(FORK, commits.a, "fork", {
        kind: "forked",
        project: UPSTREAM,
        commit: commits.a,
      });
    }).pipe(Effect.provide(trunks.layer)),
  );
  trunks.advance(FORK, commits.f2, Instant(Date.now()));
  trunks.meets(FORK, [{ at: commits.m, upstream: commits.e }]);
  /** Where each walk of the fork's trunk was told to stop, in order. */
  const stops: (readonly CommitSha[])[] = [];
  const watched = Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (host) =>
      CodeHost.of({
        ...host,
        isAncestor: (repo, ancestor, descendant, stopAt) => {
          if (repo.name === FORK_TRUNK.name) stops.push(stopAt ?? []);
          return host.isAncestor(repo, ancestor, descendant, stopAt);
        },
      }),
    ),
  ).pipe(Layer.provide(code.layer));
  /** What the change's object answers the next propose or move with, once, in place of doing it. */
  const refusing: { next?: PackTooLarge | PushRejected | QuotaExceeded } = {};
  const refusal = () => {
    const next = refusing.next;
    delete refusing.next;
    return next;
  };
  const refusable = Layer.effect(
    Changes,
    Effect.map(Changes, (held) =>
      Changes.of({
        ...held,
        propose: (changeId, input) => {
          const refused = refusal();
          return refused === undefined ? held.propose(changeId, input) : Effect.fail(refused);
        },
        updateProposal: (changeId, input) => {
          const refused = refusal();
          return refused === undefined
            ? held.updateProposal(changeId, input)
            : Effect.fail(refused);
        },
      }),
    ),
  ).pipe(Layer.provide(changes.layer));
  const layer = Layer.mergeAll(
    Layer.merge(code.layer, watched),
    trunks.layer,
    refusable,
    ledger.layer,
    places.layer,
    makeNamespaceUsageMemory(options.quotas === undefined ? {} : { quotas: options.quotas }).layer,
  );
  const propose = (commit: CommitSha, over: { fork?: ProjectId; key?: string } = {}) =>
    proposeFromFork({
      upstream: UPSTREAM,
      fork: over.fork ?? FORK,
      proposer: ANN,
      commit,
      goal: "Retry a refused push",
      idempotencyKey: over.key ?? `key-${commit}`,
      fingerprint: `body-${commit}`,
      account: ORG,
    }).pipe(Effect.provide(layer));
  const update = (changeId: ChangeId, commit: CommitSha, key = `update-${commit}`) =>
    updateFromFork({
      upstream: UPSTREAM,
      changeId,
      proposer: ANN,
      commit,
      idempotencyKey: key,
      account: ORG,
    }).pipe(Effect.provide(layer));
  /** A leased call of an agent working in the project proposed to, on `changeId`. */
  const agentSubmits = (changeId: ChangeId, commit: CommitSha) =>
    Changes.use((port) =>
      port.submit(
        {
          agentId: makeId("agt", ulid()),
          projectId: UPSTREAM,
          scopes: ["agent:work"],
          revocationEpoch: 1,
        },
        { changeId, lease: makeId("lse", ulid()), commitSha: commit, idempotencyKey: "s1" },
      ),
    ).pipe(Effect.provide(layer));
  return { commits, changes, trunks, stops, refusing, propose, update, agentSubmits };
}

describe("proposing from a fork", () => {
  it.effect(
    "[proposals.not-a-fork] a project that was not forked from the one proposed to is NotAForkOf, and nothing is reserved or proposed",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        const stranger: ProjectId = makeId("prj", ulid());
        const refused = yield* Effect.flip(w.propose(w.commits.f2, { fork: stranger }));
        expect(refused).toMatchObject({ _tag: "NotAForkOf", fork: stranger, upstream: UPSTREAM });
        // A fork, but of another project: it proposes nothing here.
        const elsewhere: ProjectId = makeId("prj", ulid());
        yield* Effect.flatMap(Trunks, (trunks) =>
          trunks.initialize(elsewhere, w.commits.a, "fork", {
            kind: "forked",
            project: makeId("prj", ulid()),
            commit: w.commits.a,
          }),
        ).pipe(Effect.provide(w.trunks.layer));
        const another = yield* Effect.flip(w.propose(w.commits.a, { fork: elsewhere }));
        expect(another).toMatchObject({ _tag: "NotAForkOf", fork: elsewhere, upstream: UPSTREAM });
        expect(w.changes.proposed()).toEqual([]);
      }),
  );

  it.effect(
    "[proposals.commit-off-fork] a commit the fork's trunk does not hold is CommitNotOnFork, and nothing is proposed",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        const refused = yield* Effect.flip(w.propose(w.commits.off));
        expect(refused).toMatchObject({
          _tag: "CommitNotOnFork",
          fork: FORK,
          commit: w.commits.off,
        });
        expect(w.changes.proposed()).toEqual([]);
      }),
  );

  it.effect(
    "[proposals.empty] a commit that carries nothing past where the fork met the project is ProposalEmpty, naming that base",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        const refused = yield* Effect.flip(w.propose(w.commits.a));
        expect(refused).toMatchObject({
          _tag: "ProposalEmpty",
          commit: w.commits.a,
          base: w.commits.a,
        });
        expect(w.changes.proposed()).toEqual([]);
      }),
  );

  it.effect(
    "[proposals.base-synced] a commit after the fork's merge of its upstream is based on the upstream head that merge took, and one before it on the fork point; each is proposed to the project as the ledger reserved it",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        const later = yield* w.propose(w.commits.f2);
        const earlier = yield* w.propose(w.commits.f1);
        expect(
          w.changes.proposed().map((p) => ({ base: p.input.base, commit: p.input.commit })),
        ).toEqual([
          { base: w.commits.e, commit: w.commits.f2 },
          { base: w.commits.a, commit: w.commits.f1 },
        ]);
        expect(w.changes.proposed().map((p) => p.input)).toEqual([
          expect.objectContaining({
            projectId: UPSTREAM,
            fork: { projectId: FORK, trunk: FORK_TRUNK },
            proposer: ANN,
          }),
          expect.anything(),
        ]);
        expect(later.id).not.toBe(earlier.id);
        expect(later).toMatchObject({
          origin: "proposal",
          proposal: { fork: FORK, proposer: ANN },
        });
      }),
  );

  it.effect(
    "[proposals.fork-pays] what a proposal copies in, first and on every move, is counted against its fork's namespace, never the project's it is proposed to: a stranger's proposals spend nothing of the upstream's repo bytes",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        const proposed = yield* w.propose(w.commits.f1);
        yield* w.update(proposed.id, w.commits.f2);
        expect(w.changes.proposed().map((p) => p.input.namespace)).toEqual([FORK_ORG]);
        expect(w.changes.moved().map((m) => m.input.namespace)).toEqual([FORK_ORG]);
      }),
  );

  it.effect(
    "[proposals.update-rebased] a proposal moved to a commit after the fork's merge of its upstream is based on the upstream head that merge took, as a first proposal of it would be; one that carries nothing past that is ProposalEmpty",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        const proposed = yield* w.propose(w.commits.f1);
        yield* w.update(proposed.id, w.commits.f2);
        expect(w.changes.moved().map((m) => m.input.base)).toEqual([w.commits.e]);
        const empty = yield* Effect.flip(w.update(proposed.id, w.commits.a));
        expect(empty).toMatchObject({
          _tag: "ProposalEmpty",
          commit: w.commits.a,
          base: w.commits.a,
        });
      }),
  );

  it.effect(
    "[proposals.walk-bounded] a commit is looked for in the fork's own history alone: every walk stops at the fork point and at each upstream head the fork met, never reading the upstream history a sync merged in",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        yield* w.propose(w.commits.f2);
        yield* Effect.flip(w.propose(w.commits.off, { key: "off" }));
        expect(w.stops.length).toBeGreaterThan(0);
        for (const stopAt of w.stops)
          expect([...stopAt].toSorted()).toEqual([w.commits.a, w.commits.e].toSorted());
      }),
  );

  it.effect(
    "[proposals.update-off-fork] a proposal moves only to a commit its own fork's trunk holds: another is CommitNotOnFork and nothing moves",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        const proposed = yield* w.propose(w.commits.f1);
        const refused = yield* Effect.flip(w.update(proposed.id, w.commits.off));
        expect(refused).toMatchObject({
          _tag: "CommitNotOnFork",
          fork: FORK,
          commit: w.commits.off,
        });
        expect(w.changes.changes.get(proposed.id)?.commitSha).toBe(w.commits.f1);
        const moved = yield* w.update(proposed.id, w.commits.f2);
        expect(moved.commitSha).toBe(w.commits.f2);
      }),
  );
});

describe("a proposal no agent holds", () => {
  it.effect(
    "[proposals.agent-lease-refused] an agent's leased call on a proposal is LeaseStale, as the Change DO's machine answers it: no agent holds a proposal, so no lease is its",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() => forkWorld());
        const proposed = yield* w.propose(w.commits.f1);
        expect(yield* Effect.flip(w.agentSubmits(proposed.id, w.commits.f1))).toMatchObject({
          _tag: "LeaseStale",
          changeId: proposed.id,
        });
      }),
  );
});

describe("what proposing and moving count against an account", () => {
  const PACK = new PackTooLarge({ repo: { namespace: "ns", name: "fork" }, bytes: 2, limit: 1 });
  const FULL = new QuotaExceeded({
    kind: "repo-bytes",
    reason: "limit",
    limit: 1,
    used: 1,
    requested: 1,
    nextActions: [],
  });
  const PUSH = new PushRejected({ reason: "the code host refused it" });

  it.effect(
    "[rate.moves-daily] an account moves its proposals to another commit as many times a day as the instance allows: a retry under its key counts once, a move refused before it is counted counts nothing, and the next is QuotaExceeded",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() =>
          forkWorld({ quotas: { defaults: { "proposal-moves": 1 } } }),
        );
        const proposed = yield* w.propose(w.commits.f1);
        yield* Effect.flip(w.update(proposed.id, w.commits.off, "off"));
        const moved = yield* w.update(proposed.id, w.commits.f2, "m1");
        const retried = yield* w.update(proposed.id, w.commits.f2, "m1");
        const refused = yield* Effect.flip(w.update(proposed.id, w.commits.f1, "m2"));
        expect([moved.commitSha, retried.commitSha]).toEqual([w.commits.f2, w.commits.f2]);
        expect(refused).toMatchObject({ _tag: "QuotaExceeded", kind: "proposal-moves", limit: 1 });
        expect(w.changes.changes.get(proposed.id)?.commitSha).toBe(w.commits.f2);
      }),
  );

  it.effect(
    "[rate.final-refusal-given-back] a proposal or a move refused for what its commit is (its pack too large, or past its fork's repo bytes) is given back; one refused for a reason a retry outlasts keeps its count, and its retry counts nothing more",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() =>
          forkWorld({ quotas: { defaults: { proposals: 1, "proposal-moves": 1 } } }),
        );
        w.refusing.next = PACK;
        expect(yield* Effect.flip(w.propose(w.commits.f1, { key: "big" }))).toMatchObject({
          _tag: "PackTooLarge",
        });
        const proposed = yield* w.propose(w.commits.f1, { key: "p1" });
        w.refusing.next = FULL;
        expect(yield* Effect.flip(w.update(proposed.id, w.commits.f2, "full"))).toMatchObject({
          _tag: "QuotaExceeded",
          kind: "repo-bytes",
        });
        expect((yield* w.update(proposed.id, w.commits.f2, "m1")).commitSha).toBe(w.commits.f2);

        const kept = yield* Effect.promise(() =>
          forkWorld({ quotas: { defaults: { proposals: 1 } } }),
        );
        kept.refusing.next = PUSH;
        yield* Effect.flip(kept.propose(kept.commits.f1, { key: "p1" }));
        expect(yield* Effect.flip(kept.propose(kept.commits.f2, { key: "p2" }))).toMatchObject({
          _tag: "QuotaExceeded",
          kind: "proposals",
        });
        expect((yield* kept.propose(kept.commits.f1, { key: "p1" })).commitSha).toBe(
          kept.commits.f1,
        );
      }),
  );

  it.effect(
    "[proposals.rate-limited-frees-place] a proposal refused for its account's day gives its place on the project back at once: refused again and again, it is the day's limit that refuses it, never the cap on what a proposer holds open",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(() =>
          forkWorld({ quotas: { defaults: { proposals: 1 } } }),
        );
        yield* w.propose(w.commits.f1, { key: "p1" });
        const refused: string[] = [];
        for (let n = 2; n <= MAX_OPEN_PROPOSALS + 2; n += 1)
          refused.push((yield* Effect.flip(w.propose(w.commits.f2, { key: `p${n}` })))._tag);
        expect(new Set(refused)).toEqual(new Set(["QuotaExceeded"]));
      }),
  );
});
