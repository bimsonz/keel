import { describe, expect, it } from "@effect/vitest";
import {
  commitDerivation,
  derivationSeeds,
  deriveSubmission,
  planSubjects,
  type PrecheckSubmission,
  startPrecheck,
  touchedAnchors,
} from "@keeltown/core/application/verification";
import {
  FootprintEntry,
  type Intent,
  IntentDeclared,
  type Proposition,
  type StoreHolder,
  type SubjectAnchors,
  SubjectKey,
  type SymbolRef,
} from "@keeltown/core/domain/coordination";
import {
  type Anchor,
  CommitSha,
  type ContentHash,
  contentHashOf,
  type EventEnvelope,
  Instant,
  makeId,
  type ProjectId,
  type WorkspaceId,
} from "@keeltown/core/kernel";
import {
  ChangePrecheck,
  type PrecheckDerived,
  Projects,
  type RepoRef,
  SyntaxSource,
  SyntaxUnavailable,
} from "@keeltown/core/ports";
import {
  makeChangePrecheckMemory,
  makeEvidenceStoreMemory,
  makeProjectsMemory,
  makeSyntaxSourceMemory,
  type ParsedTree,
  sampleNamespace,
  ulidOf,
} from "@keeltown/testing";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

const changeId = makeId("chg", "01JZD21D21D21D21D21D21D21D");
const projectId: ProjectId = makeId("prj", "01JZD21D21D21D21D21D21D21D");
const workspaceId: WorkspaceId = makeId("wsp", "01JZD21D21D21D21D21D21D21D");
const INSTANCE = "precheck-evt_1";

/** Where the evidence store keeps a derivation record: among the evidence of the namespace the step was given. */
const keptAt = (ref: ContentHash): string =>
  `ns/org_01JZ8PT2C4E6G8J0M2N4Q6S8V0/evidence/${ref.slice("sha256:".length)}`;

const key = (value: string) => Schema.decodeUnknownSync(SubjectKey)(value);
const EVALUATION = key("authz.permission-evaluation");
const INVOICES = key("billing.invoices");

const GUARD = "src/authz/require-permission.ts";
const CACHE = "src/authz/cache.ts";
const INVOICE = "src/billing/invoice.ts";
const ROUTES = "src/routes/repos.ts";
const SESSION = "src/authz/session.ts";
const BLOBS = "src/storage/blobs.ts";
/** The commit the live anchors were pinned at when they were declared: neither commit under Precheck. */
const PINNED = CommitSha.make("a".repeat(40));

const at = (path: string, symbol: string): SymbolRef => ({ path, symbol });
const callerRole = at(GUARD, "callerRole");
/** Where a live change anchored permission evaluation: the symbol that reads the caller's role. */
const CALLER_ROLE: Anchor = { path: GUARD, symbol: "callerRole", commit: PINNED };

/** A tree with no store in it. */
const NO_CACHE: ParsedTree = {
  stores: [],
  accesses: [],
  calls: [],
  subscriptions: [],
  impurities: [],
};

/**
 * What a parser reports for a class `name` in `path` that `reader` reads
 * through: one store, read in `get` and filled in `set`, both called by
 * `reader`. Keyed by session and repository, in a class field, unless told.
 */
const cacheIn = (
  path: string,
  name: string,
  reader: SymbolRef,
  holder: StoreHolder = "instance",
): ParsedTree => {
  const store = at(path, `${name}.#entries`);
  const get = at(path, `${name}.get`);
  const set = at(path, `${name}.set`);
  const keyed = ["sessionId", "repoId"];
  return {
    stores: [{ at: store, holder, weak: false }],
    accesses: [
      { store, in: get, op: "read", key: keyed, deferred: false },
      { store, in: set, op: "write", key: keyed, deferred: false },
    ],
    calls: [
      { from: reader, to: get, deferred: false },
      { from: reader, to: set, deferred: false },
    ],
    subscriptions: [],
    impurities: [],
  };
};
const together = (trees: readonly ParsedTree[]): ParsedTree => ({
  stores: trees.flatMap((t) => t.stores),
  accesses: trees.flatMap((t) => t.accesses),
  calls: trees.flatMap((t) => t.calls),
  subscriptions: trees.flatMap((t) => t.subscriptions),
  impurities: trees.flatMap((t) => t.impurities),
});
/** `callerRole` reads roles through a cache keyed by session and repository. */
const ROLE_CACHE = cacheIn(CACHE, "RoleCache", callerRole);

/** The effect the role cache has on permission evaluation, as the record and EffectsDerived carry it. */
const perSession = (head: CommitSha, declared: boolean) => {
  const anchors = [
    { path: CACHE, symbol: "RoleCache.#entries", commit: head },
    { path: GUARD, symbol: "callerRole", commit: head },
  ];
  return {
    proposition: {
      subject: "authz.permission-evaluation",
      predicate: "freshness",
      relation: "is",
      value: "per-session",
      anchors,
    },
    anchors,
    declared,
    method: "extractor",
    evidenceClass: "ruling",
  };
};

/** The change's intent: it declares no effect unless given some. */
const intentWith = (declaredEffects?: readonly Proposition[]): Intent => ({
  revision: 1,
  goal: "speed up permission checks",
  footprint: [],
  premises: [],
  ...(declaredEffects === undefined ? {} : { declaredEffects }),
});

const holderOf = (n: number) => makeId("chg", ulidOf(n));

/** Another live change's IntentDeclared, as its Change DO commits it: each row a premise anchored in code. */
const declaring = (n: number, rows: readonly SubjectAnchors[]): EventEnvelope => ({
  eventId: makeId("evt", ulidOf(n)),
  type: "IntentDeclared",
  entity: { kind: "change", id: holderOf(n) },
  seq: 1,
  at: Instant(Date.UTC(2026, 9, 12)),
  dedupeKey: `declare-${n}`,
  affected: [],
  notified: [],
  payload: Schema.encodeSync(IntentDeclared)(
    IntentDeclared.make({
      changeId: holderOf(n),
      agentId: makeId("agt", ulidOf(n)),
      origin: "agent",
      revision: 1,
      goal: `change ${n}`,
      footprint: [],
      premises: rows.map((row) => ({
        subject: row.subject,
        predicate: "freshness",
        relation: "at-most",
        value: "per-request",
        anchors: row.anchors,
      })),
      leaseId: makeId("lse", ulidOf(n)),
    }),
  ),
});

/** That change's ChangeWithdrawn: its anchors leave the project's index. */
const withdrawing = (n: number): EventEnvelope => ({
  eventId: makeId("evt", ulidOf(1000 + n)),
  type: "ChangeWithdrawn",
  entity: { kind: "change", id: holderOf(n) },
  seq: 2,
  at: Instant(Date.UTC(2026, 9, 12)),
  dedupeKey: `withdraw-${n}`,
  affected: [],
  notified: [],
  payload: { _tag: "ChangeWithdrawn", changeId: holderOf(n), by: "agent" },
});

type Committed = { readonly repo: RepoRef; readonly sha: CommitSha };

/**
 * Derivation's world in memory: commits whose parse a test writes by hand,
 * the project's live anchors as its other changes declared them, the change
 * under Precheck and the evidence store. Every reading asked of the parser is
 * in `asked`, every read of the live anchors in `anchorReads`, and every
 * derivation sent to the change in `committed`, a replay's included.
 */
function derivingWorld() {
  const syntax = makeSyntaxSourceMemory();
  const changes = makeChangePrecheckMemory();
  const projects = makeProjectsMemory();
  const evidence = makeEvidenceStoreMemory();
  const asked: { readonly commit: CommitSha; readonly seeds: readonly string[] }[] = [];
  /** Why the next readings of a commit cannot be made: each ask takes one reason, and with none left the commit reads. */
  const unavailable = new Map<CommitSha, SyntaxUnavailable["reason"][]>();
  const anchorReads: ProjectId[] = [];
  const committed: PrecheckDerived[] = [];
  const parser = Layer.effect(
    SyntaxSource,
    Effect.gen(function* () {
      const source = yield* SyntaxSource;
      return SyntaxSource.of({
        facts: (repo, commit, seeds) =>
          Effect.suspend(() => {
            asked.push({ commit, seeds });
            const reason = unavailable.get(commit)?.shift();
            return reason === undefined
              ? source.facts(repo, commit, seeds)
              : Effect.fail(new SyntaxUnavailable({ reason }));
          }),
      });
    }),
  ).pipe(Layer.provide(syntax.layer));
  const index = Layer.effect(
    Projects,
    Effect.gen(function* () {
      const held = yield* Projects;
      return Projects.of({
        ...held,
        liveAnchors: (id) =>
          Effect.suspend(() => {
            anchorReads.push(id);
            return held.liveAnchors(id);
          }),
      });
    }),
  ).pipe(Layer.provide(projects.layer));
  const change = Layer.effect(
    ChangePrecheck,
    Effect.gen(function* () {
      const precheck = yield* ChangePrecheck;
      return ChangePrecheck.of({
        ...precheck,
        derived: (id, derived) =>
          Effect.suspend(() => {
            committed.push(derived);
            return precheck.derived(id, derived);
          }),
      });
    }),
  ).pipe(Layer.provide(changes.layer));
  /** What the `derived` step is given: the kept records and the change, and no way to the code or the anchors. */
  const kept = Layer.mergeAll(evidence.layer, change);

  return {
    changes,
    evidence,
    asked,
    unavailable,
    anchorReads,
    committed,
    commit: syntax.commit,
    /** Another live change of the project declares a premise on each row's subject, anchored as the row says. */
    anchored: (n: number, rows: readonly SubjectAnchors[]) =>
      void projects.live.hear(projectId, declaring(n, rows)),
    /** That change withdraws. */
    withdrawn: (n: number) => void projects.live.hear(projectId, withdrawing(n)),
    liveAnchors: () => projects.live.anchorsOf(projectId),
    /**
     * Submits the change at revision 1 on `head` over `base`, starts its
     * Precheck and takes the `derive` step for these touched paths. The
     * change declared no subject unless given some.
     */
    derive: (
      base: Committed,
      head: Committed,
      touched: readonly string[],
      intent: Intent = intentWith(),
      subjects: readonly SubjectKey[] = [],
    ) =>
      Effect.gen(function* () {
        changes.submit(changeId, 1, {
          workspaceId,
          repo: base.repo,
          baseSha: base.sha,
          grantedSha: base.sha,
          projectId,
          subjects,
          intent,
        });
        const submission: PrecheckSubmission = {
          changeId,
          revision: 1,
          commitSha: head.sha,
          baseSha: base.sha,
          instanceId: INSTANCE,
        };
        const workspace = yield* startPrecheck(submission);
        const answer = yield* deriveSubmission(
          sampleNamespace,
          workspace,
          submission,
          base.sha,
          touched,
        );
        return { submission, answer };
      }).pipe(Effect.provide(Layer.mergeAll(parser, index, kept))),
    /** The `derived` step. */
    commitKept: (submission: PrecheckSubmission, derivationRef: ContentHash) =>
      commitDerivation(sampleNamespace, submission, derivationRef).pipe(Effect.provide(kept)),
    /** The record the evidence store holds under `ref` for the submission's namespace, as the JSON it keeps. */
    record: (ref: ContentHash): Record<string, unknown> =>
      JSON.parse(evidence.documents.get(keptAt(ref)) ?? "{}"),
  };
}

/** The parser's answer for a commit it read with nothing left out. */
const READ = { parser: "memory", skipped: [] };

/** `[d21.derive.small]` builds two thousand modules and their anchors: under load that outlasts the default five seconds. */
const PROPERTY_TIMEOUT = 60_000;

/** One of the many modules of `[d21.derive.small]`, by its number. */
const moduleFile = (n: string) => `src/load/module-${n}.ts`;

describe("Precheck's derivation", () => {
  it.effect(
    "[d21.derive.undeclared] a head that reads through a session-keyed cache under an anchored symbol derives freshness is per-session on the anchoring subject, undeclared, and answers that subject",
    () => {
      const world = derivingWorld();
      return Effect.gen(function* () {
        world.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
        const base = yield* world.commit({ [GUARD]: "base\n" }, NO_CACHE);
        const head = yield* world.commit({ [GUARD]: "head\n", [CACHE]: "new\n" }, ROLE_CACHE);
        const { answer } = yield* world.derive(base, head, [CACHE, GUARD]);
        expect(answer).toEqual({
          derivationRef: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          subjects: ["authz.permission-evaluation"],
        });
        expect(world.record(answer.derivationRef)["effects"]).toEqual([
          perSession(head.sha, false),
        ]);
      });
    },
  );

  it.effect(
    "[d21.derive.unchanged] a touched file that changes no cache derives nothing, and the derivation is still recorded and committed",
    () => {
      const world = derivingWorld();
      return Effect.gen(function* () {
        world.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
        // The cache is at the base already: the head edits its file and leaves what it caches alone.
        const base = yield* world.commit({ [GUARD]: "same\n", [CACHE]: "base\n" }, ROLE_CACHE);
        const head = yield* world.commit({ [GUARD]: "same\n", [CACHE]: "head\n" }, ROLE_CACHE);
        const { answer, submission } = yield* world.derive(base, head, [CACHE]);
        expect(answer.subjects).toEqual([]);
        expect([...world.evidence.documents.keys()]).toEqual([keptAt(answer.derivationRef)]);
        expect(world.record(answer.derivationRef)).toMatchObject({
          kind: "keel.derivation/1",
          base: base.sha,
          head: head.sha,
          readings: { base: READ, head: READ },
          effects: [],
          undecided: [],
        });
        yield* world.commitKept(submission, answer.derivationRef);
        expect(world.committed).toEqual([
          {
            revision: 1,
            instanceId: INSTANCE,
            effects: [],
            derivationRef: answer.derivationRef,
            paths: [CACHE],
          },
        ]);
        expect(world.changes.calls.map((c) => c.method)).toEqual([
          "precheckStarted",
          "effectsDerived",
        ]);
      });
    },
  );

  it.effect(
    "[d21.derive.seeds] both commits are read from the touched paths and the anchored paths of the subjects near them, each once and in path order: a subject anchored on a touched path brings its other files and its sibling's, a subject under one the change declared brings its own, and a far subject's file is not a seed though its anchors are still attributed against",
    () => {
      const world = derivingWorld();
      return Effect.gen(function* () {
        world.anchored(1, [
          { subject: EVALUATION, anchors: [CALLER_ROLE, { path: CACHE, commit: PINNED }] },
        ]);
        world.anchored(2, [
          { subject: INVOICES, anchors: [{ path: INVOICE, symbol: "total", commit: PINNED }] },
        ]);
        world.anchored(3, [
          { subject: key("authz.sessions"), anchors: [{ path: SESSION, commit: PINNED }] },
        ]);
        world.anchored(4, [
          { subject: key("storage.blobs"), anchors: [{ path: BLOBS, commit: PINNED }] },
        ]);
        const base = yield* world.commit({ [GUARD]: "base\n", [INVOICE]: "base\n" }, NO_CACHE);
        const head = yield* world.commit(
          { [GUARD]: "base\n", [INVOICE]: "base\n", [CACHE]: "new\n", [ROUTES]: "new\n" },
          ROLE_CACHE,
        );
        // The change touched the routes and the cache, and declared it relies on storage.
        // The cache is anchored by permission evaluation, whose other anchor is the guard and whose sibling is sessions.
        const { answer } = yield* world.derive(base, head, [ROUTES, CACHE], intentWith(), [
          key("storage"),
        ]);
        const seeds = [
          "src/authz/cache.ts",
          "src/authz/require-permission.ts",
          "src/authz/session.ts",
          "src/routes/repos.ts",
          "src/storage/blobs.ts",
        ];
        expect(world.asked).toEqual([
          { commit: base.sha, seeds },
          { commit: head.sha, seeds },
        ]);
        expect(world.anchorReads).toEqual([projectId]);
        const record = world.record(answer.derivationRef);
        expect(record["seeds"]).toEqual(seeds);
        // Invoices is far from everything the change touched or declared: its file is not read, and its anchors are still kept.
        expect(record["anchors"]).toHaveLength(4);
        expect(record["anchors"]).toEqual(
          expect.arrayContaining(
            [
              "authz.permission-evaluation",
              "authz.sessions",
              "billing.invoices",
              "storage.blobs",
            ].map((subject) => expect.objectContaining({ subject })),
          ),
        );
        expect(
          derivationSeeds(
            ["b.ts", "a.ts"],
            [],
            [
              { subject: EVALUATION, anchors: [{ path: "d.ts", commit: PINNED }] },
              {
                subject: INVOICES,
                anchors: [
                  { path: "a.ts", symbol: "total", commit: PINNED },
                  { path: "c.ts", symbol: "tax", commit: PINNED },
                  { path: "c.ts", symbol: "net", commit: PINNED },
                ],
              },
            ],
          ),
        ).toEqual(["a.ts", "b.ts", "c.ts"]);
      });
    },
  );

  it.effect(
    "[d21.derive.record] the kept record carries each reading's parser and the files it left out, the anchors, the seeds, the effects and the undecided claims, never the facts, and its hash is the derivationRef",
    () => {
      const world = derivingWorld();
      return Effect.gen(function* () {
        world.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
        const base = yield* world.commit({ [GUARD]: "base\n", "README.md": "base\n" }, NO_CACHE);
        // The head adds the role cache, and a token cache whose holder the parser could not tell.
        const head = yield* world.commit(
          { [GUARD]: "head\n", "README.md": "head\n", [CACHE]: "new\n" },
          together([ROLE_CACHE, cacheIn(CACHE, "TokenCache", callerRole, "unknown")]),
        );
        const { answer } = yield* world.derive(base, head, [CACHE, GUARD, "README.md"]);
        const unsupported = { path: "README.md", reason: "unsupported" };
        const record = {
          kind: "keel.derivation/1",
          changeId,
          revision: 1,
          repo: { namespace: "memory", name: base.repo.name },
          base: base.sha,
          head: head.sha,
          seeds: ["README.md", "src/authz/cache.ts", "src/authz/require-permission.ts"],
          // What the diff touched, sorted, whatever order it was named in.
          paths: ["README.md", CACHE, GUARD],
          anchors: [
            {
              subject: "authz.permission-evaluation",
              anchors: [
                { path: "src/authz/require-permission.ts", symbol: "callerRole", commit: PINNED },
              ],
            },
          ],
          readings: {
            base: {
              parser: "memory",
              skipped: [unsupported, { path: "src/authz/cache.ts", reason: "absent" }],
            },
            head: { parser: "memory", skipped: [unsupported] },
          },
          effects: [perSession(head.sha, false)],
          undecided: [
            {
              subject: "authz.permission-evaluation",
              store: { path: "src/authz/cache.ts", symbol: "TokenCache.#entries" },
              reason: "holder-unknown",
            },
          ],
          // The guard's file is in the diff, and a premise of the subject is anchored there.
          touched: [
            {
              subject: "authz.permission-evaluation",
              anchor: {
                path: "src/authz/require-permission.ts",
                symbol: "callerRole",
                commit: PINNED,
              },
            },
          ],
        };
        expect(world.record(answer.derivationRef)).toEqual(record);
        expect([...world.evidence.documents.keys()]).toEqual([keptAt(answer.derivationRef)]);
        expect(answer.derivationRef).toBe(contentHashOf(record));
      });
    },
  );

  it.effect(
    "[d21.derive.parser-starting] a reading refused as parser-starting is asked for once more and then read, and one refused so twice is recorded as unavailable with no effects and never asked for a third time",
    () => {
      const once = derivingWorld();
      const twice = derivingWorld();
      return Effect.gen(function* () {
        once.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
        const base = yield* once.commit({ [GUARD]: "base\n", [CACHE]: "base\n" }, NO_CACHE);
        const head = yield* once.commit({ [GUARD]: "base\n", [CACHE]: "head\n" }, ROLE_CACHE);
        once.unavailable.set(head.sha, ["parser-starting"]);
        const read = yield* once.derive(base, head, [CACHE]);
        expect(once.asked.map((ask) => ask.commit)).toEqual([base.sha, head.sha, head.sha]);
        expect(once.record(read.answer.derivationRef)).toMatchObject({
          readings: { base: READ, head: READ },
          effects: [perSession(head.sha, false)],
        });
        expect(read.answer.subjects).toEqual(["authz.permission-evaluation"]);

        twice.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
        const under = yield* twice.commit({ [GUARD]: "base\n", [CACHE]: "base\n" }, NO_CACHE);
        const over = yield* twice.commit({ [GUARD]: "base\n", [CACHE]: "head\n" }, ROLE_CACHE);
        // A third ask of the base would read it: only the two refusals are scripted.
        twice.unavailable.set(under.sha, ["parser-starting", "parser-starting"]);
        const unread = yield* twice.derive(under, over, [CACHE]);
        expect(twice.asked.map((ask) => ask.commit)).toEqual([under.sha, under.sha, over.sha]);
        const kept = twice.record(unread.answer.derivationRef);
        expect(kept["readings"]).toEqual({ base: { unavailable: "parser-starting" }, head: READ });
        expect(kept["effects"]).toEqual([]);
        expect(unread.answer.subjects).toEqual([]);
      });
    },
  );

  it.effect(
    "[d21.derive.unavailable] a reading that cannot be made for any other reason is recorded against the commit it failed for, with no effects: the step still answers, and asks for each commit once",
    () =>
      Effect.gen(function* () {
        for (const reason of [
          "too-many-seeds",
          "too-many-bytes",
          "too-many-failures",
          "parser-failed",
        ] as const)
          for (const failed of ["base", "head"] as const) {
            const world = derivingWorld();
            world.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
            const base = yield* world.commit({ [GUARD]: "base\n", [CACHE]: "base\n" }, NO_CACHE);
            const head = yield* world.commit({ [GUARD]: "base\n", [CACHE]: "head\n" }, ROLE_CACHE);
            // A second ask of the failed commit would read it, and derive the role cache.
            world.unavailable.set(failed === "base" ? base.sha : head.sha, [reason]);
            const { answer } = yield* world.derive(base, head, [CACHE]);
            expect(world.asked.map((ask) => ask.commit)).toEqual([base.sha, head.sha]);
            const kept = world.record(answer.derivationRef);
            expect(kept["readings"]).toEqual(
              failed === "base"
                ? { base: { unavailable: reason }, head: READ }
                : { base: READ, head: { unavailable: reason } },
            );
            expect(kept["effects"]).toEqual([]);
            expect(kept["undecided"]).toEqual([]);
            expect(answer.subjects).toEqual([]);
          }
      }),
  );

  it.effect(
    "[d21.derive.missing-commit] a commit the code host no longer holds is a defect, which the Workflow retries, and nothing is recorded",
    () => {
      const world = derivingWorld();
      return Effect.gen(function* () {
        world.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
        const base = yield* world.commit({ [GUARD]: "base\n" }, NO_CACHE);
        const gone = { repo: base.repo, sha: CommitSha.make("f".repeat(40)) };
        const exit = yield* Effect.exit(world.derive(base, gone, [GUARD]));
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(world.asked.map((ask) => ask.commit)).toEqual([base.sha, gone.sha]);
        expect(world.evidence.documents.size).toBe(0);
      });
    },
  );

  it.effect(
    "[d21.derive.committed] the derived step commits the kept record's effects and its hash under the submission's revision and instance, the same on a replay, and reads neither the code nor the anchors, though both have moved",
    () => {
      const world = derivingWorld();
      return Effect.gen(function* () {
        world.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
        const base = yield* world.commit({ [GUARD]: "base\n" }, NO_CACHE);
        const head = yield* world.commit({ [GUARD]: "head\n", [CACHE]: "new\n" }, ROLE_CACHE);
        const { answer, submission } = yield* world.derive(base, head, [CACHE, GUARD]);
        // The anchoring change withdraws and the parser gives up: a derivation taken now would find nothing.
        world.withdrawn(1);
        world.unavailable.set(head.sha, ["parser-failed"]);
        expect(world.liveAnchors()).toEqual([]);

        yield* world.commitKept(submission, answer.derivationRef);
        yield* world.commitKept(submission, answer.derivationRef);
        const payload = {
          revision: 1,
          instanceId: INSTANCE,
          effects: [perSession(head.sha, false)],
          derivationRef: answer.derivationRef,
          // What the diff touched is the record's too: the anchor moved on since, and is still named.
          touched: [
            {
              subject: "authz.permission-evaluation",
              anchor: {
                path: "src/authz/require-permission.ts",
                symbol: "callerRole",
                commit: PINNED,
              },
            },
          ],
          // And every path the diff touched, sorted: what the landing is indexed under.
          paths: [CACHE, GUARD].toSorted(),
        };
        expect(world.committed).toEqual([payload, payload]);
        expect([...world.evidence.documents.keys()]).toEqual([keptAt(answer.derivationRef)]);
        // The change took it once: the replay committed nothing new.
        expect(world.changes.calls.map((c) => c.method)).toEqual([
          "precheckStarted",
          "effectsDerived",
        ]);
        expect(world.asked.map((ask) => ask.commit)).toEqual([base.sha, head.sha]);
        expect(world.anchorReads).toEqual([projectId]);

        // A hash no record is kept under is a defect, never a derivation of nothing.
        const missing = yield* Effect.exit(
          world.commitKept(submission, contentHashOf({ kind: "keel.derivation/1" })),
        );
        expect(Exit.isFailure(missing) && Cause.hasDies(missing.cause)).toBe(true);
        expect(world.committed).toHaveLength(2);
      });
    },
  );

  it.effect(
    "[d21.derive.declared] an effect the change's intent declared is derived as declared",
    () => {
      const world = derivingWorld();
      return Effect.gen(function* () {
        world.anchored(1, [{ subject: EVALUATION, anchors: [CALLER_ROLE] }]);
        const base = yield* world.commit({ [GUARD]: "base\n" }, NO_CACHE);
        const head = yield* world.commit({ [GUARD]: "head\n", [CACHE]: "new\n" }, ROLE_CACHE);
        const { answer } = yield* world.derive(
          base,
          head,
          [CACHE, GUARD],
          intentWith([
            { subject: EVALUATION, predicate: "freshness", relation: "is", value: "per-session" },
          ]),
        );
        expect(world.record(answer.derivationRef)["effects"]).toEqual([perSession(head.sha, true)]);
        expect(answer.subjects).toEqual(["authz.permission-evaluation"]);
      });
    },
  );

  it("[d21.derive.subjects-join] a plan's subjects are those the change declared, then those derived, each once", () => {
    const sessions = key("authz.sessions");
    expect(planSubjects([INVOICES, EVALUATION], [EVALUATION, sessions])).toEqual([
      "billing.invoices",
      "authz.permission-evaluation",
      "authz.sessions",
    ]);
    expect(planSubjects([], [EVALUATION, sessions])).toEqual([
      "authz.permission-evaluation",
      "authz.sessions",
    ]);
    expect(planSubjects([INVOICES], [])).toEqual(["billing.invoices"]);
  });

  it.effect(
    "[d21.derive.small] the derive step's answer stays under 4 KiB for a project with 2,000 live anchors and a large reading, whose record does not",
    () => {
      const world = derivingWorld();
      return Effect.gen(function* () {
        const modules = Array.from({ length: 2000 }, (_, i) => String(i).padStart(4, "0"));
        // Each module's handler is anchored to a subject of its own, and reads a table nothing fills.
        world.anchored(
          1,
          modules.map((n) => ({
            subject: key(`load.module-${n}`),
            anchors: [{ path: moduleFile(n), symbol: "handle", commit: PINNED }],
          })),
        );
        const tables = modules.map((n): ParsedTree => {
          const store = at(moduleFile(n), "TABLE");
          const lookup = at(moduleFile(n), "lookup");
          return {
            stores: [{ at: store, holder: "module", weak: false }],
            accesses: [{ store, in: lookup, op: "read", key: ["id"], deferred: false }],
            calls: [{ from: at(moduleFile(n), "handle"), to: lookup, deferred: false }],
            subscriptions: [],
            impurities: [],
          };
        });
        const files = Object.fromEntries(modules.map((n) => [moduleFile(n), "module\n"]));
        const base = yield* world.commit(files, together(tables));
        // The head gives the first forty handlers a session cache each.
        const head = yield* world.commit(
          files,
          together([
            ...tables,
            ...modules
              .slice(0, 40)
              .map((n) => cacheIn(moduleFile(n), "Cache", at(moduleFile(n), "handle"))),
          ]),
        );
        const { answer } = yield* world.derive(base, head, modules.slice(0, 40).map(moduleFile));
        expect(answer.subjects).toHaveLength(40);
        expect(world.record(answer.derivationRef)["effects"]).toHaveLength(40);
        expect(JSON.stringify(answer).length).toBeLessThan(4096);
        expect(world.evidence.documents.get(keptAt(answer.derivationRef))?.length).toBeGreaterThan(
          256 * 1024,
        );
      });
    },
    { timeout: PROPERTY_TIMEOUT },
  );
});

/** An anchor in `path`, on `symbol` or the whole file. */
const anchorIn = (path: string, symbol?: string): Anchor => ({
  path,
  ...(symbol === undefined ? {} : { symbol }),
  commit: PINNED,
});
/** A footprint entry editing `path`, or `symbol` in it. */
const editOf = (path: string, symbol?: string) =>
  Schema.decodeUnknownSync(FootprintEntry)({
    path,
    op: "edit",
    ...(symbol === undefined ? {} : { symbol }),
  });
/** Each touched anchor as subject, path and symbol. */
const touchedNames = (found: ReturnType<typeof touchedAnchors>) =>
  found.map((each) => `${each.subject}:${each.anchor.path}:${each.anchor.symbol ?? "*"}`);

describe("the live anchors a diff touches", () => {
  it("[anchor.touched] every anchor in an edited file is touched, unless the change's footprint names only other symbols there; a whole-file anchor always is", () => {
    const anchors: readonly SubjectAnchors[] = [
      {
        subject: INVOICES,
        anchors: [anchorIn("p.ts", "price"), anchorIn("p.ts", "total"), anchorIn("q.ts", "tax")],
      },
      { subject: EVALUATION, anchors: [anchorIn("p.ts")] },
    ];
    // No footprint for the file: everything anchored in it is touched.
    expect(touchedNames(touchedAnchors(["p.ts"], [], anchors))).toEqual([
      "authz.permission-evaluation:p.ts:*",
      "billing.invoices:p.ts:price",
      "billing.invoices:p.ts:total",
    ]);
    // The footprint names `price` there: `total` is left alone, the whole-file anchor is not.
    expect(touchedNames(touchedAnchors(["p.ts"], [editOf("p.ts", "price")], anchors))).toEqual([
      "authz.permission-evaluation:p.ts:*",
      "billing.invoices:p.ts:price",
    ]);
    // A footprint of the whole file, or a glob over it, names every symbol in it.
    expect(touchedNames(touchedAnchors(["p.ts"], [editOf("*.ts")], anchors))).toHaveLength(3);
    // An untouched file's anchors are not touched, whatever the footprint says.
    expect(touchedNames(touchedAnchors(["r.ts"], [editOf("q.ts", "tax")], anchors))).toEqual([]);
  });
});
