import { Effect, Result, Schema } from "effect";
import {
  type Derivation,
  DerivedEffect,
  deriveEffects,
  type FootprintEntry,
  type SubjectAnchors,
  SubjectKey,
  subjectsNear,
  SymbolRef,
  TouchedAnchor,
  type Undecided,
} from "../../domain/coordination/index.ts";
import {
  Anchor,
  canonicalJson,
  ChangeId,
  CommitSha,
  type ContentHash,
  type Json,
  matchesGlob,
  type NamespaceId,
} from "../../domain/kernel/index.ts";
import {
  ChangePrecheck,
  EvidenceStore,
  type PrecheckWorkspace,
  Projects,
  type SyntaxReading,
  SyntaxSkipped,
  SyntaxSource,
  SyntaxUnavailable,
} from "../ports/index.ts";
import type { PrecheckSubmission } from "./precheck.ts";

/**
 * Precheck's derivation, in two Workflow steps. `derive` reads the base and
 * the submitted commit, derives the change's effects and keeps the record;
 * `derived` commits what was kept. Two steps, so that a replay commits the
 * derivation that was kept, never a second reading taken after the live
 * anchors moved.
 */

/** The derivation record's kind, kept in the record: another shape takes another number. */
export const DERIVATION_KIND = "keel.derivation/1";

const SubjectAnchorsJson: Schema.Codec<SubjectAnchors, unknown> = Schema.Struct({
  subject: SubjectKey,
  anchors: Schema.Array(Anchor),
});

const UndecidedJson: Schema.Codec<Undecided, unknown> = Schema.Struct({
  subject: SubjectKey,
  store: SymbolRef,
  reason: Schema.Literals(["holder-unknown", "expiry-unknown"]),
});

/** A reading as the record keeps it: its parser and the files it left out, or why it could not be made. Never its facts. */
const RecordedReading = Schema.Union([
  Schema.Struct({ parser: Schema.NonEmptyString, skipped: Schema.Array(SyntaxSkipped) }),
  Schema.Struct({ unavailable: SyntaxUnavailable.fields.reason }),
]);
type RecordedReading = typeof RecordedReading.Type;

/**
 * What one Precheck pass derived and what it derived it from, kept in the
 * evidence store under its content hash: `EffectsDerived.derivationRef` is
 * that hash. It holds what the pass read (the seeds, the anchors it
 * attributed against, each reading's parser and the files it left out) and
 * what it concluded (the effects, and the caches the rules could not decide).
 * The facts are not kept: they are the parser's answer for those seeds at
 * those commits.
 *
 * A reading that could not be made is kept as `unavailable` with its reason,
 * and the pass then derives nothing: no effects beside an unavailable reading
 * says the code was not read, never that it has no effect.
 */
export const DerivationRecord = Schema.Struct({
  kind: Schema.Literal(DERIVATION_KIND),
  changeId: ChangeId,
  revision: Schema.Int,
  repo: Schema.Struct({ namespace: Schema.String, name: Schema.String }),
  base: CommitSha,
  head: CommitSha,
  seeds: Schema.Array(Schema.String),
  anchors: Schema.Array(SubjectAnchorsJson),
  readings: Schema.Struct({ base: RecordedReading, head: RecordedReading }),
  effects: Schema.Array(DerivedEffect),
  undecided: Schema.Array(UndecidedJson),
  /** The live anchors the diff touches; absent from a record kept before they were. */
  touched: Schema.optional(Schema.Array(TouchedAnchor)),
});
export type DerivationRecord = typeof DerivationRecord.Type;

/** The record as the evidence store keeps it: encoded, then through JSON, so an absent field is absent. */
const recordJson = (record: DerivationRecord): Json =>
  JSON.parse(JSON.stringify(Schema.encodeSync(DerivationRecord)(record)));

/**
 * What the `derive` step answers: the kept record's hash, and the subjects it
 * derived an effect on. Never the effects or the facts: a Workflow step's
 * output is capped at 1 MiB, and a project's anchors and a reading are not.
 */
export interface DerivationKept {
  readonly derivationRef: ContentHash;
  readonly subjects: readonly SubjectKey[];
}

/** The paths a subject's anchors pin. */
const pathsOf = (row: SubjectAnchors): readonly string[] => row.anchors.map((a) => a.path);

/**
 * The files a derivation asks the parser for: the paths the change touches,
 * and the anchored paths of the subjects near them, since a subject is
 * attributed through its anchored code whether or not the change touched that
 * file. Near is exposure's never-miss rule, the one that selects a guard for a
 * change: a subject related or a sibling to one the change declared, or to
 * one a live anchor pins to a touched path. Never every anchored path in the
 * project, which in a large one is more seeds than the parser takes, so that
 * no pass there would derive anything. Each once, in path order, so both
 * commits are read from the same seeds.
 *
 * What it gives up: a subject that is not near, anchored in a file no seed
 * imports, is not attributed a cache the change adds elsewhere. The record
 * keeps the seeds, so what a pass did not read can be seen.
 */
export const derivationSeeds = (
  touched: readonly string[],
  declared: readonly SubjectKey[],
  anchors: readonly SubjectAnchors[],
): readonly string[] => {
  const edited = new Set(touched);
  const at = anchors.filter((row) => pathsOf(row).some((p) => edited.has(p)));
  const focus = [...declared, ...at.map((row) => row.subject)];
  const near = anchors.filter((row) => focus.some((s) => subjectsNear(s, row.subject)));
  return [...new Set([...touched, ...near.flatMap(pathsOf)])].toSorted();
};

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a footprint entry names `symbol`, or code inside it (a class's member). */
const namesSymbol = (entry: FootprintEntry, symbol: string): boolean =>
  entry.symbol === symbol || symbol.startsWith(`${entry.symbol ?? ""}.`);

/**
 * The live anchors a change's diff touches: each anchor, of any subject, in a
 * file the diff changes, whether or not Keel derived an effect from the edit.
 * The change's footprint sharpens it: when every entry covering the file names
 * symbols and none names the anchored one, the change says it edits other code
 * there, and the anchor is not touched. An anchor on a whole file always is.
 * Each subject and anchor once, in subject and path order.
 */
export const touchedAnchors = (
  touched: readonly string[],
  footprint: readonly FootprintEntry[],
  anchors: readonly SubjectAnchors[],
): readonly TouchedAnchor[] => {
  const edited = new Set(touched);
  const found = new Map<string, TouchedAnchor>();
  for (const row of anchors)
    for (const anchor of row.anchors) {
      if (!edited.has(anchor.path)) continue;
      const covering = footprint.filter((entry) => matchesGlob(entry.path, anchor.path));
      const elsewhere =
        anchor.symbol !== undefined &&
        covering.length > 0 &&
        covering.every((entry) => entry.symbol !== undefined) &&
        !covering.some((entry) => anchor.symbol !== undefined && namesSymbol(entry, anchor.symbol));
      if (elsewhere) continue;
      found.set(
        canonicalJson({ subject: row.subject, path: anchor.path, symbol: anchor.symbol ?? null }),
        { subject: row.subject, anchor },
      );
    }
  return [...found.values()].toSorted((a, b) =>
    a.subject === b.subject
      ? byCodePoint(
          `${a.anchor.path}\n${a.anchor.symbol ?? ""}`,
          `${b.anchor.path}\n${b.anchor.symbol ?? ""}`,
        )
      : byCodePoint(a.subject, b.subject),
  );
};

/**
 * The subjects a plan is compiled for: those the change declared, then those
 * Precheck derived an effect on, each once. Compile selects a derived
 * subject's admitted guards in the same pass, whether or not the change named it.
 */
export const planSubjects = (
  declared: readonly SubjectKey[],
  derived: readonly SubjectKey[],
): readonly SubjectKey[] => [...new Set([...declared, ...derived])];

/** One commit's reading, or why none could be made. */
type Reading = SyntaxReading | { readonly unavailable: SyntaxUnavailable["reason"] };

const recorded = (reading: Reading): RecordedReading =>
  "unavailable" in reading
    ? { unavailable: reading.unavailable }
    : { parser: reading.parser, skipped: reading.skipped };

/**
 * The `derive` step. Reads the project's live anchors here, inside the step,
 * so the anchors and the readings belong to one moment; parses the base and
 * the submitted commit from the same seeds; derives the change's effects
 * against what its intent declared; and keeps the record.
 *
 * A reading that cannot be made is recorded, never refused and never thrown:
 * a parser's limits are not the change's fault. `parser-starting` is the
 * parser's own state, so that reading is asked for once more, at once; any
 * other reason would answer the same again. Half a reading derives nothing,
 * since a base that was not read would make every cache at the head look new.
 * Both commits were read by `ancestry`, so a repo or commit gone since is a
 * defect, and the step retries.
 */
export const deriveSubmission = Effect.fn("verification/deriveSubmission")(function* (
  namespace: NamespaceId,
  workspace: PrecheckWorkspace,
  submission: PrecheckSubmission,
  base: CommitSha,
  touched: readonly string[],
) {
  const anchors = yield* (yield* Projects).liveAnchors(workspace.projectId);
  const seeds = derivationSeeds(touched, workspace.subjects, anchors);
  const source = yield* SyntaxSource;
  const read = (commit: CommitSha, retry: boolean): Effect.Effect<Reading> =>
    source.facts(workspace.repo, commit, seeds).pipe(
      Effect.catchTag("SyntaxUnavailable", (e): Effect.Effect<Reading> =>
        e.reason === "parser-starting" && retry
          ? read(commit, false)
          : Effect.succeed({ unavailable: e.reason }),
      ),
      Effect.orDie,
    );
  const before = yield* read(base, true);
  const after = yield* read(submission.commitSha, true);
  const derivation: Derivation =
    "unavailable" in before || "unavailable" in after
      ? { effects: [], undecided: [] }
      : deriveEffects({
          base: before.facts,
          head: after.facts,
          subjects: anchors,
          intent: workspace.intent,
        });
  const touchedHere = touchedAnchors(touched, workspace.intent.footprint, anchors);
  const derivationRef = yield* (yield* EvidenceStore).put(
    namespace,
    recordJson({
      kind: DERIVATION_KIND,
      changeId: submission.changeId,
      revision: submission.revision,
      repo: workspace.repo,
      base,
      head: submission.commitSha,
      seeds,
      anchors,
      readings: { base: recorded(before), head: recorded(after) },
      effects: derivation.effects,
      undecided: derivation.undecided,
      ...(touchedHere.length === 0 ? {} : { touched: touchedHere }),
    }),
  );
  const subjects = [...new Set(derivation.effects.map((e) => e.proposition.subject))].toSorted();
  const kept: DerivationKept = { derivationRef, subjects };
  return kept;
});

/**
 * The `derived` step: commits EffectsDerived from the record `derive` kept,
 * read back by its hash. It reads no code and no anchors, so a replay commits
 * the same derivation however the project has moved since. A record that is
 * missing or does not decode is a defect: `derive` stored it before it
 * answered the hash.
 */
export const commitDerivation = Effect.fn("verification/commitDerivation")(function* (
  namespace: NamespaceId,
  submission: PrecheckSubmission,
  derivationRef: ContentHash,
) {
  const stored = yield* (yield* EvidenceStore).get(namespace, derivationRef).pipe(Effect.orDie);
  const record = Schema.decodeUnknownResult(DerivationRecord)(stored);
  if (Result.isFailure(record))
    return yield* Effect.die(new Error(`${derivationRef} is not a derivation record`));
  return yield* (yield* ChangePrecheck).derived(submission.changeId, {
    revision: submission.revision,
    instanceId: submission.instanceId,
    effects: record.success.effects,
    derivationRef,
    ...(record.success.touched === undefined ? {} : { touched: record.success.touched }),
  });
});
