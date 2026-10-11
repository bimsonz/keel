import { type Predicate, SubjectKey } from "../../src/domain/coordination/index.ts";
import {
  canBlock,
  CommitSha,
  contentHashOf,
  type EvidenceClass,
  Glob,
  type PredicatePolicy,
  weakest,
} from "../../src/domain/kernel/index.ts";
import type {
  ChangeFacts,
  Condition,
  Flow,
  FlowDefaults,
  FlowDefinition,
  Read,
  StepKind,
  StepOutcome,
  StepSpec,
  FlowWorld,
} from "../../src/domain/verification/index.ts";
import { fc } from "../support/fast-check.ts";

export const base = CommitSha.make("b".repeat(40));
export const otherCommit = CommitSha.make("c".repeat(40));

export const factClasses: Readonly<Record<string, EvidenceClass>> = {
  diff: "proof",
  "derived-effects": "opinion",
  "agent-intent": "testimony",
  "subject-index": "ruling",
};

const kinds: readonly StepKind[] = [
  "deterministic",
  "decision-model",
  "generative",
  "probe",
  "human",
  "deploy",
];
const allWorlds: readonly FlowWorld[] = ["trunk", "A", "B", "AB"];
const pathPool = ["src/authz/**", "src/billing/**"] as const;
const subjectPool = ["authz", "billing.cache"] as const;

const ceilingFor = (kind: StepKind): fc.Arbitrary<EvidenceClass> =>
  kind === "decision-model" || kind === "generative"
    ? fc.constant("opinion")
    : kind === "human"
      ? fc.constant("ruling")
      : fc.constantFrom("proof", "ruling", "testimony", "opinion");

type Draft = {
  readonly kind: StepKind;
  readonly ceiling: EvidenceClass;
  readonly stepReads: readonly number[];
  readonly factReads: readonly string[];
  readonly decideOutcomes: readonly StepOutcome[];
  readonly routeOutcomes: readonly StepOutcome[];
  readonly optional: boolean;
  readonly worlds: readonly FlowWorld[] | undefined;
  readonly suite: boolean;
  readonly pinned: 0 | 1 | 2 | undefined;
  readonly paths: readonly string[];
  readonly subjects: readonly string[];
  readonly usd: number;
  readonly skipPick: readonly number[];
  readonly overridePick: readonly number[];
};

const draftArb = (i: number): fc.Arbitrary<Draft> =>
  fc.constantFrom(...kinds).chain((kind) =>
    fc.record({
      kind: fc.constant(kind),
      ceiling: ceilingFor(kind),
      stepReads:
        i === 0
          ? fc.constant([])
          : fc.subarray(
              Array.from({ length: i }, (_, j) => j),
              { maxLength: Math.min(2, i) },
            ),
      factReads: fc.subarray(Object.keys(factClasses), { maxLength: 2 }),
      decideOutcomes: fc.subarray(["pass", "fail", "escalate", "annotate"] as StepOutcome[]),
      routeOutcomes: fc.subarray(["escalate", "annotate"] as StepOutcome[]),
      optional: fc.boolean(),
      worlds: fc.option(fc.subarray([...allWorlds], { minLength: 1 }), { nil: undefined }),
      suite: fc.boolean(),
      pinned: fc.option(fc.constantFrom(0 as const, 1 as const, 2 as const), {
        nil: undefined,
        freq: 4,
      }),
      paths: fc.subarray([...pathPool]),
      subjects: fc.subarray([...subjectPool], { maxLength: 1 }),
      usd: fc.constantFrom(0, 0.001, 0.01, 0.1),
      skipPick: fc.subarray([0, 1, 2, 3, 4, 5], { maxLength: 2 }),
      overridePick: fc.subarray([0, 1, 2, 3, 4, 5], { maxLength: 2 }),
    }),
  );

/** Builds steps in order, so taint can be computed as they are drafted, and only well-typed outcomes are chosen. */
const buildSteps = (
  drafts: readonly Draft[],
): { readonly steps: readonly StepSpec[]; readonly decides: ReadonlySet<string> } => {
  const ids = Array.from({ length: drafts.length }, (_, n) => `s${n}`);
  const effective: EvidenceClass[] = [];
  const outcomes: StepOutcome[][] = [];
  for (const d of drafts) {
    const consumed = [
      ...d.stepReads.map((j) => effective[j] ?? "opinion"),
      ...d.factReads.map((f) => factClasses[f] ?? "opinion"),
    ];
    const eff = d.kind === "human" ? "ruling" : consumed.reduce(weakest, d.ceiling);
    effective.push(eff);
    outcomes.push([...(canBlock(eff) ? d.decideOutcomes : d.routeOutcomes), "abstain"]);
  }
  const steps = drafts.map((d, i): StepSpec => {
    const id = ids[i] ?? `s${i}`;
    const decides = canBlock(effective[i] ?? "opinion");
    const others = (picks: readonly number[]) =>
      picks.filter((j) => j < drafts.length && j !== i).map((j) => ids[j] ?? `s${j}`);
    const mayskip = others(d.skipPick).filter(
      (t) => decides || drafts[Number(t.slice(1))]?.optional === true,
    );
    const overrides =
      d.kind === "human"
        ? others(d.overridePick).filter((t) =>
            (outcomes[Number(t.slice(1))] ?? []).includes("fail"),
          )
        : [];
    const reads: Read[] = [
      ...d.stepReads.map((j): Read => ({ _tag: "step", step: ids[j] ?? `s${j}` })),
      ...d.factReads.map((fact): Read => ({ _tag: "fact", fact })),
    ];
    return {
      id,
      version: contentHashOf({ id, kind: d.kind }),
      kind: d.kind,
      evidenceCeiling: d.ceiling,
      appliesTo: {
        paths: d.paths.map((p) => Glob.make(p)),
        subjects: d.subjects.map((s) => SubjectKey.make(s)),
      },
      reads,
      outcomes: outcomes[i] ?? ["abstain"],
      mayskip,
      overrides,
      ...(d.worlds === undefined ? {} : { worlds: d.worlds }),
      budget: { usd: d.usd, cpuMs: 100, tokens: 0 },
      determinism: d.kind === "deterministic" ? "deterministic" : "nondeterministic",
      suite: d.suite,
      ...(d.pinned === undefined ? {} : { tier: d.pinned }),
      optional: d.optional,
    };
  });
  return { steps, decides: new Set(ids.filter((_, i) => canBlock(effective[i] ?? "opinion"))) };
};

type Shape = "step" | "worlds" | "budget" | "par" | "cascade" | "when";

/** A root seq over groups of steps; each group becomes a step, worlds, budget, par, cascade or when node. */
const buildFlow = (
  steps: readonly StepSpec[],
  decides: ReadonlySet<string>,
  shapes: readonly Shape[],
  conditionPick: number,
): Flow => {
  const items: Flow[] = [];
  const earlier: StepSpec[] = [];
  let i = 0;
  for (const shape of shapes) {
    if (i >= steps.length) break;
    const s = steps[i];
    if (s === undefined) break;
    const leaf: Flow = { _tag: "step", step: s.id };
    if ((shape === "par" || shape === "cascade") && i + 1 < steps.length) {
      const pair = [s, steps[i + 1]].filter((x): x is StepSpec => x !== undefined);
      const accept = pair.flatMap((p) => p.outcomes).find((o) => o !== "abstain");
      const members = pair.map((p): Flow => ({ _tag: "step", step: p.id }));
      const node: Flow =
        shape === "cascade" && accept !== undefined
          ? { _tag: "cascade", accept: [accept], items: members }
          : { _tag: "par", items: members };
      items.push(node);
      earlier.push(...pair);
      i += 2;
      continue;
    }
    if (shape === "worlds" && s.worlds !== undefined && s.worlds.length > 0)
      items.push({ _tag: "worlds", over: s.worlds, body: leaf });
    else if (shape === "budget")
      items.push({
        _tag: "budget",
        limit: { usd: 1, cpuMs: 10_000, tokens: 10_000 },
        onExhaust: "escalate",
        body: leaf,
      });
    else if (shape === "when" && earlier.length > 0) {
      const ref = earlier[conditionPick % earlier.length] ?? earlier[0];
      if (ref === undefined) items.push(leaf);
      else {
        // An opinion may gate a body only to add scrutiny: never on a mere annotation.
        const when = decides.has(ref.id)
          ? (ref.outcomes[0] ?? "abstain")
          : ref.outcomes.includes("escalate")
            ? "escalate"
            : "abstain";
        items.push({
          _tag: "when",
          condition: { _tag: "outcome", step: ref.id, in: [when] },
          body: leaf,
        });
      }
    } else if (s.worlds !== undefined && s.worlds.length > 0 && shape === "step")
      items.push({ _tag: "worlds", over: s.worlds, body: leaf });
    else items.push(leaf);
    earlier.push(s);
    i += 1;
  }
  for (; i < steps.length; i++) {
    const s = steps[i];
    if (s !== undefined)
      items.push(
        s.worlds === undefined
          ? { _tag: "step", step: s.id }
          : { _tag: "worlds", over: s.worlds, body: { _tag: "step", step: s.id } },
      );
  }
  return { _tag: "seq", exitOn: "fail", items };
};

export type FlowCase = { readonly spec: FlowDefinition; readonly facts: ChangeFacts };

export const emptyDefaults: FlowDefaults = {
  flow: { _tag: "seq", exitOn: "fail", items: [] },
  steps: [],
};

const touchedPool = [
  "src/authz/check.ts",
  "src/billing/charge.ts",
  "docs/readme.md",
  ".keel/flow.ts",
] as const;

/** A well-typed flow spec, read from the base commit, and the facts of a change it meets. */
export const flowCaseArb = (
  options: { readonly shapes?: readonly Shape[]; readonly maxSteps?: number } = {},
): fc.Arbitrary<FlowCase> =>
  fc
    .integer({ min: 1, max: options.maxSteps ?? 6 })
    .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => draftArb(i))))
    .chain((drafts) =>
      fc.record({
        drafts: fc.constant(drafts),
        shapes: fc.array(
          fc.constantFrom(
            ...(options.shapes ??
              (["step", "worlds", "budget", "par", "cascade", "when"] as const)),
          ),
          {
            minLength: drafts.length,
            maxLength: drafts.length,
          },
        ),
        conditionPick: fc.nat(),
        touched: fc
          .subarray([...touchedPool], { minLength: 1 })
          .map((t) => t.filter((p) => p !== ".keel/flow.ts" || t.length > 2)),
        subjects: fc.subarray([...subjectPool]),
      }),
    )
    .map(({ drafts, shapes, conditionPick, touched, subjects }) => {
      const { steps, decides } = buildSteps(drafts);
      return {
        spec: { commit: base, flow: buildFlow(steps, decides, shapes, conditionPick), steps },
        facts: {
          baseCommit: base,
          touchedPaths: touched,
          subjects: subjects.map((s) => SubjectKey.make(s)),
          facts: factClasses,
        },
      };
    });

/** Every step a `when` condition reads. */
const conditionReads = (flow: Flow, out = new Set<string>()): Set<string> => {
  const atoms = (c: Condition): void => {
    if (c._tag === "outcome") out.add(c.step);
    else if (c._tag === "not") atoms(c.item);
    else c.items.forEach(atoms);
  };
  switch (flow._tag) {
    case "step":
      return out;
    case "seq":
    case "par":
    case "cascade":
      for (const item of flow.items) conditionReads(item, out);
      return out;
    case "when":
      atoms(flow.condition);
      return conditionReads(flow.body, out);
    default:
      return conditionReads(flow.body, out);
  }
};

const guardedPredicates: readonly Predicate[] = ["freshness", "authority", "ordering"];
export const policyArb: fc.Arbitrary<PredicatePolicy> = fc.constantFrom(
  "block",
  "advise",
  "annotate",
);

/**
 * A flow case where some steps guard a tenet on a predicate, and the change's
 * predicate policy names some of those predicates (the rest default). A
 * guard here is never read by a `when`, so a verdict over it can be compared
 * with one where its fail is replaced: under advise its outcome stays `fail`
 * for any condition that reads it.
 */
export const guardedCaseArb = (): fc.Arbitrary<FlowCase> =>
  flowCaseArb().chain((c) =>
    fc
      .record({
        marks: fc.tuple(
          ...c.spec.steps.map(() =>
            fc.option(fc.constantFrom(...guardedPredicates), { nil: undefined, freq: 2 }),
          ),
        ),
        policy: fc.record(
          { freshness: policyArb, authority: policyArb, ordering: policyArb },
          { requiredKeys: [] },
        ),
      })
      .map(({ marks, policy }) => {
        const read = conditionReads(c.spec.flow);
        return {
          spec: {
            ...c.spec,
            steps: c.spec.steps.map((s, i) => {
              const guards = marks[i];
              return guards === undefined || read.has(s.id) ? s : { ...s, guards };
            }),
          },
          facts: { ...c.facts, predicatePolicy: policy },
        };
      }),
  );
