import { describe, expect, it } from "@effect/vitest";
import { deriveEffects, type Intent, type SourceFacts } from "@keeltown/core/domain/coordination";
import { CommitSha, Glob } from "@keeltown/core/kernel";
import { type RepoRef, SyntaxSource } from "@keeltown/core/ports";
import { Effect, Exit, type Layer } from "effect";
import { FORGE_LITE_ITEMS, FORGE_LITE_SUBJECTS } from "../forge-lite-facts.ts";
import { forgeLiteFactFiles, forgeLiteSeeds, forgeLiteTrees } from "../forge-lite-trees.ts";
import type { ParsedTree } from "../memory/syntax-source.ts";

/**
 * A port and a way to commit a whole tree to the one repo it reads. `parsed`
 * is what a parser reports for the tree: an adapter that parses takes no
 * notice of it, and the in-memory one answers it.
 */
export interface SyntaxSourceHarness {
  readonly layer: Layer.Layer<SyntaxSource>;
  readonly commit: (
    files: Readonly<Record<string, string | Uint8Array>>,
    parsed: ParsedTree,
  ) => Effect.Effect<{ readonly repo: RepoRef; readonly sha: CommitSha }>;
}

const NOTHING: ParsedTree = { stores: [], accesses: [], calls: [], subscriptions: [] };
const UNKNOWN = CommitSha.make("e".repeat(40));
const intent: Intent = {
  revision: 1,
  goal: "speed up permission checks",
  footprint: [{ path: Glob.make("src/**"), op: "edit" }],
  premises: [],
  declaredEffects: [],
};

const ref = (r: { readonly path: string; readonly symbol: string }) => `${r.path}#${r.symbol}`;
/** The facts that lie wholly in `files`, in one order whatever order they were reported in. */
const within = (facts: ParsedTree | SourceFacts, files: readonly string[]) => {
  const inside = (...refs: readonly { readonly path: string }[]) =>
    refs.every((r) => files.includes(r.path));
  return {
    stores: facts.stores
      .filter((s) => inside(s.at))
      .map((s) => `${ref(s.at)} ${s.holder}${s.weak ? " weak" : ""}`)
      .toSorted(),
    accesses: facts.accesses
      .filter((a) => inside(a.store, a.in))
      .map(
        (a) =>
          `${a.op} ${ref(a.store)} in ${ref(a.in)} by [${a.key.join(", ")}] expiring ${JSON.stringify(a.expiry ?? null)}${a.deferred ? " deferred" : ""}`,
      )
      .toSorted(),
    calls: facts.calls
      .filter((c) => inside(c.from, c.to))
      .map((c) => `${ref(c.from)} -> ${ref(c.to)}${c.deferred ? " deferred" : ""}`)
      .toSorted(),
    subscriptions: facts.subscriptions
      .filter((s) => inside(s.in, s.handler))
      .map(
        (s) =>
          `${s.event} via ${s.via} in ${ref(s.in)} to ${ref(s.handler)}${s.async ? " async" : ""}`,
      )
      .toSorted(),
  };
};

export function describeSyntaxSourceContract(adapter: string, make: () => SyntaxSourceHarness) {
  describe(`SyntaxSource contract: ${adapter}`, () => {
    it.effect(
      "[syntaxsource.contract.facts] reads forge-lite's eight changes: the files the fixture was transcribed from give exactly its facts, at the base and at the head",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const source = yield* SyntaxSource;
          for (const item of FORGE_LITE_ITEMS) {
            const files = forgeLiteFactFiles(item.id);
            const trees = forgeLiteTrees(item.id);
            const base = yield* harness.commit(trees.base, item.base);
            const head = yield* harness.commit(trees.head, item.head);
            const before = yield* source.facts(base.repo, base.sha, files);
            const after = yield* source.facts(head.repo, head.sha, files);
            expect([item.id, within(before.facts, files)]).toEqual([
              item.id,
              within(item.base, files),
            ]);
            expect([item.id, within(after.facts, files)]).toEqual([
              item.id,
              within(item.head, files),
            ]);
            expect(before.facts.commit).toBe(base.sha);
            expect(after.facts.commit).toBe(head.sha);
            expect(after.parser).not.toBe("");
          }
        }).pipe(Effect.provide(harness.layer));
      },
      60_000,
    );

    it.effect(
      "[syntaxsource.contract.derives] derives each change's effects from the seeds Precheck gives: the files it touches and the files the live anchors name",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const source = yield* SyntaxSource;
          for (const item of FORGE_LITE_ITEMS) {
            const seeds = forgeLiteSeeds(item.id);
            const trees = forgeLiteTrees(item.id);
            const base = yield* harness.commit(trees.base, item.base);
            const head = yield* harness.commit(trees.head, item.head);
            const before = yield* source.facts(base.repo, base.sha, seeds);
            const after = yield* source.facts(head.repo, head.sha, seeds);
            const derived = deriveEffects({
              base: before.facts,
              head: after.facts,
              subjects: FORGE_LITE_SUBJECTS,
              intent,
            });
            expect([item.id, derived.effects.map((effect) => effect.proposition.value)]).toEqual([
              item.id,
              item.derives,
            ]);
            expect([item.id, derived.undecided]).toEqual([item.id, []]);
            // Nothing but a file the change adds or removes is left out.
            expect(
              [...before.skipped, ...after.skipped].filter((skip) => skip.reason !== "absent"),
            ).toEqual([]);
          }
        }).pipe(Effect.provide(harness.layer));
      },
      60_000,
    );

    it.effect(
      "[syntaxsource.contract.absent] answers a seed that is not at the commit as skipped, never as a failure, and fails for a commit the repo does not hold",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const source = yield* SyntaxSource;
          const { repo, sha } = yield* harness.commit(
            { "src/a.ts": "export const a = 1;\n", "README.md": "# r\n" },
            NOTHING,
          );
          const reading = yield* source.facts(repo, sha, ["src/new.ts", "src/a.ts", "README.md"]);
          expect(reading.skipped).toEqual([
            { path: "README.md", reason: "unsupported" },
            { path: "src/new.ts", reason: "absent" },
          ]);
          expect(reading.facts).toEqual({ commit: sha, ...NOTHING });
          expect(
            Exit.isFailure(yield* Effect.exit(source.facts(repo, UNKNOWN, ["src/a.ts"]))),
          ).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
