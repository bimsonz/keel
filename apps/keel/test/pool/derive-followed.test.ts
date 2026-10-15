/**
 * Core's derive step in workerd, on tree-sitter, the Project DO's live anchors
 * and ARCHIVE, for a change whose created file imports code it does not touch:
 * the base is read over every file the head reached, so what that code already
 * did is not derived as the change's effect.
 */
import { env } from "cloudflare:workers";
import { subjectAddress } from "@keeltown/core/application/coordination";
import { deriveSubmission } from "@keeltown/core/application/verification";
import { Proposition, SubjectKey } from "@keeltown/core/domain/coordination";
import { type CommitSha, makeId, type ProjectId } from "@keeltown/core/kernel";
import { CodeHost, EvidenceStore, type PrecheckWorkspace } from "@keeltown/core/ports";
import { CodeHostFixture } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { ProjectsRpc } from "../../src/adapters/driven/do-rpc/projects.ts";
import { EvidenceStoreR2 } from "../../src/adapters/driven/r2/evidence-store.ts";
import { SyntaxSourceTreeSitter } from "../../src/adapters/driven/syntax/syntax-source.ts";
import { SYNTAX_WASM } from "../../src/adapters/driven/syntax/wasm.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { drainAfter, drainOutbox, POOL_ORG } from "./helpers.ts";

const key = Schema.decodeUnknownSync(SubjectKey);

const PRICE_FILE = "bench/p2.ts";
const TEST_FILE = "bench/p2.test.ts";
/** `price`, already logging before the change. */
const LOGGED_PRICE =
  'export function price(n: number): number {\n  console.info("priced", n);\n  return n * 2;\n}\n';
/** A test of `price`: the one file the change adds. */
const PRICE_TEST =
  'import { price } from "./p2.ts";\n\nexport const priced = (): number => price(2);\n';
/** What the other side relies on: `price` stays pure, anchored at it, pinned at a commit of neither push. */
const PRICE_IS_PURE = Schema.decodeUnknownSync(Proposition)({
  subject: "bench.price",
  predicate: "purity",
  relation: "is",
  value: true,
  anchors: [{ path: PRICE_FILE, symbol: "price", commit: "a".repeat(40) }],
});

/** Two commits on the change's workspace repo: `before`, then `after`, each the whole tree. */
const pushedOver = (
  c: ChangeUnderTest,
  workspace: PrecheckWorkspace,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(workspace.repo);
      const fixture = yield* CodeHostFixture;
      const base = yield* fixture.commit(workspace.repo, "refs/heads/main", before);
      const head = yield* fixture.commit(workspace.repo, "refs/heads/main", after);
      return { base, head };
    }).pipe(Effect.provide(c.code.layer)),
  );

/** The derive step itself on what Precheck's runtime composes here, reading the commits on the change's in-memory code host. */
const derivedFrom = (
  c: ChangeUnderTest,
  workspace: PrecheckWorkspace,
  base: CommitSha,
  commitSha: CommitSha,
  paths: readonly string[],
) =>
  Effect.runPromise(
    deriveSubmission(
      POOL_ORG,
      workspace,
      {
        changeId: c.changeId,
        revision: 1,
        commitSha,
        baseSha: workspace.baseSha,
        instanceId: "precheck-not-started",
      },
      base,
      paths,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          ProjectsRpc((projectId) =>
            env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)),
          ),
          SyntaxSourceTreeSitter(SYNTAX_WASM).pipe(Layer.provide(c.code.layer)),
          EvidenceStoreR2(env.ARCHIVE),
        ),
      ),
    ),
  );

describe("[d21.pool.derive-untouched-kept] a derivation over a file only a created file reaches", () => {
  it("[d21.pool.derive-untouched-kept] on tree-sitter, a change that only adds a test importing a function already impure derives no effect on the subject anchored there: the base is read over the file the test reaches", async () => {
    const projectId: ProjectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId, "project");
    const neighbour = await changeUnderTest(projectId, "project");
    const hearing = [key("bench.price"), key("bench")].map((subject) =>
      drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(subjectAddress(projectId, subject)))),
    );
    // Another live change relies on `price` being pure, though it already logs; its anchor is live.
    ok(await neighbour.declare("declare-neighbour", { premises: [PRICE_IS_PURE] }));
    await drainOutbox(neighbour.stub);

    // This change declares nothing and adds a test that imports `price`: it touches only the test.
    ok(await c.declare("declare-1"));
    const workspace = ok(decodeExit(ChangeCodecs.workspace, await c.stub.workspace()));
    const { base, head } = await pushedOver(
      c,
      workspace,
      { [PRICE_FILE]: LOGGED_PRICE },
      { [PRICE_FILE]: LOGGED_PRICE, [TEST_FILE]: PRICE_TEST },
    );
    const answer = await derivedFrom(c, workspace, base, head, [TEST_FILE]);
    expect(answer.subjects).toEqual([]);
    const record = await Effect.runPromise(
      EvidenceStore.use((store) => store.get(POOL_ORG, answer.derivationRef)).pipe(
        Effect.provide(EvidenceStoreR2(env.ARCHIVE)),
      ),
    );
    expect(record).toMatchObject({ seeds: [TEST_FILE], followed: [PRICE_FILE], effects: [] });

    await drainOutbox(c.stub);
    await Promise.all(hearing.map((subject) => drainOutbox(subject)));
  });
});
