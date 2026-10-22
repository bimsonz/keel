// Proposing from a fork, as the doorway does once the policy let the proposer
// ask: the fork must be the project's, the commit its trunk's, and the base
// the newest point where the fork met the project that the commit holds.
import { describe, expect, it } from "@effect/vitest";
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
import { CodeHost, Trunks } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeChangesMemory,
  makeCodeHostMemory,
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
async function forkWorld() {
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
  const layer = Layer.mergeAll(
    Layer.merge(code.layer, watched),
    trunks.layer,
    changes.layer,
    ledger.layer,
    places.layer,
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
    }).pipe(Effect.provide(layer));
  const update = (changeId: ChangeId, commit: CommitSha) =>
    updateFromFork({
      upstream: UPSTREAM,
      changeId,
      proposer: ANN,
      commit,
      idempotencyKey: `update-${commit}`,
    }).pipe(Effect.provide(layer));
  return { commits, changes, trunks, stops, propose, update };
}

describe("proposing from a fork", () => {
  it.effect(
    "[proposals.not-a-fork] a project that was not forked from the one proposed to is NotAForkOf, and nothing is reserved or proposed",
    () =>
      Effect.gen(function* () {
        const w = yield* Effect.promise(forkWorld);
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
        const w = yield* Effect.promise(forkWorld);
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
        const w = yield* Effect.promise(forkWorld);
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
        const w = yield* Effect.promise(forkWorld);
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
        const w = yield* Effect.promise(forkWorld);
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
        const w = yield* Effect.promise(forkWorld);
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
        const w = yield* Effect.promise(forkWorld);
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
        const w = yield* Effect.promise(forkWorld);
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
