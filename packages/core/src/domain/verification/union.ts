import { Result } from "effect";
import { type PredicatePolicy, type ContentHash, type Glob, weakest } from "../kernel/index.ts";
import { planHashOf } from "./compile.ts";
import { UnionVersionConflict } from "./errors.ts";
import type { FlowPlan, PlanPreimage } from "./flow.ts";
import { byHeldDecision } from "./guards.ts";
import type { PlanStep, StepOutcome } from "./plan.ts";

const WORLDS = ["trunk", "A", "B", "AB"] as const;
const OUTCOMES: readonly StepOutcome[] = ["pass", "fail", "escalate", "annotate", "abstain"];
/** How strict each policy is: the union keeps the strictest a member asked for. */
const STRICTNESS: Readonly<Record<PredicatePolicy, number>> = { annotate: 0, advise: 1, block: 2 };

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type PlannedGuard = NonNullable<PlanStep["guards"]>;
/**
 * Which of two members' guards a shared step keeps: the stricter policy, then
 * the decision `byHeldDecision` puts first. Members come in plan-hash order,
 * so without the second a ruled guard's decision would be kept or lost by a hash.
 */
const byStrictness = (a: PlannedGuard, b: PlannedGuard): number =>
  STRICTNESS[b.policy] - STRICTNESS[a.policy] || byHeldDecision(a.decision, b.decision);
const sortedUnion = <A extends string>(...lists: readonly (readonly A[])[]): A[] =>
  [...new Set(lists.flat())].toSorted(byCodePoint);
const inOrder = <A>(order: readonly A[], ...lists: readonly (readonly A[])[]): A[] =>
  order.filter((x) => lists.some((l) => l.includes(x)));

/**
 * One step as two members planned it: the same spec (same version), so the
 * only differences are what each change's facts and paths made of it. Every
 * choice is the stricter one, and none depends on argument order.
 */
const mergeStep = (a: PlanStep, b: PlanStep): PlanStep => {
  const tier =
    a.tier.tier !== b.tier.tier
      ? a.tier.tier > b.tier.tier
        ? a.tier
        : b.tier
      : byCodePoint(a.tier.reason, b.tier.reason) <= 0
        ? a.tier
        : b.tier;
  const worlds =
    a.worlds === undefined && b.worlds === undefined
      ? undefined
      : inOrder(WORLDS, a.worlds ?? [], b.worlds ?? []);
  const guards =
    a.guards === undefined
      ? b.guards
      : b.guards === undefined || byStrictness(a.guards, b.guards) <= 0
        ? a.guards
        : b.guards;
  return {
    id: a.id,
    kind: a.kind,
    evidenceCeiling: weakest(a.evidenceCeiling, b.evidenceCeiling),
    appliesTo: sortedUnion<Glob>(a.appliesTo, b.appliesTo),
    tier,
    because: sortedUnion(
      a.because.split("; ").filter((r) => r !== ""),
      b.because.split("; ").filter((r) => r !== ""),
    ).join("; "),
    effectiveClass: weakest(
      a.effectiveClass ?? a.evidenceCeiling,
      b.effectiveClass ?? b.evidenceCeiling,
    ),
    ...(a.outcomes === undefined && b.outcomes === undefined
      ? {}
      : { outcomes: inOrder(OUTCOMES, a.outcomes ?? [], b.outcomes ?? []) }),
    optional: a.optional === true && b.optional === true,
    ...(worlds === undefined ? {} : { worlds }),
    ...(guards === undefined ? {} : { guards }),
  };
};

const mergeLists = (
  plans: readonly FlowPlan[],
  pick: (p: FlowPlan) => Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> => {
  const out: Record<string, readonly string[]> = {};
  for (const plan of plans)
    for (const [id, list] of Object.entries(pick(plan))) out[id] = sortedUnion(out[id] ?? [], list);
  return out;
};

/**
 * The plan a batch runs: the union of its members' plans (the Lane stores
 * it). A batch of one runs its member's plan unchanged, hash and all. Members
 * are taken once each, in planHash order, so the union depends on the set of
 * plans alone. The flow runs every member's flow side by side (`par`); a step
 * two members share is planned once, at the stricter of their choices, and
 * runs at most once per plan run: every branch that names it reads that one
 * result. Steps at different versions, guard steps pinning different probes,
 * or plans from different compilers, cannot share a run.
 */
export const unionPlans = (
  plans: readonly [FlowPlan, ...FlowPlan[]],
): Result.Result<FlowPlan, UnionVersionConflict> => {
  const members = [...new Map(plans.map((p) => [p.planHash, p] as const)).values()].toSorted(
    (a, b) => byCodePoint(a.planHash, b.planHash),
  );
  const [first, ...rest] = members;
  if (first === undefined || rest.length === 0) return Result.succeed(first ?? plans[0]);

  const compilers = sortedUnion(members.map((m) => m.compiler));
  if (compilers.length > 1) return Result.fail(new UnionVersionConflict({ versions: compilers }));
  const versions = new Map<string, Set<ContentHash>>();
  const probes = new Map<string, Set<ContentHash>>();
  for (const m of members) {
    for (const [id, v] of Object.entries(m.versions))
      versions.set(id, (versions.get(id) ?? new Set()).add(v));
    for (const s of m.steps)
      if (s.guards !== undefined)
        probes.set(s.id, (probes.get(s.id) ?? new Set()).add(s.guards.probe));
  }
  for (const pinned of [versions, probes])
    for (const [stepId, vs] of [...pinned].toSorted(([a], [b]) => byCodePoint(a, b)))
      if (vs.size > 1)
        return Result.fail(new UnionVersionConflict({ stepId, versions: sortedUnion([...vs]) }));

  const steps = new Map<string, PlanStep>();
  for (const m of members)
    for (const s of m.steps) {
      const seen = steps.get(s.id);
      steps.set(s.id, seen === undefined ? s : mergeStep(seen, s));
    }
  const preimage: PlanPreimage = {
    compiler: first.compiler,
    baseCommit: members.map((m) => m.baseCommit).toSorted(byCodePoint)[0] ?? first.baseCommit,
    flow: { _tag: "par", items: members.map((m) => m.flow) },
    steps: [...steps.values()],
    versions: Object.fromEntries(members.flatMap((m) => Object.entries(m.versions))),
    overrides: mergeLists(members, (m) => m.overrides),
    mayskip: mergeLists(members, (m) => m.mayskip),
    humanClass: members.some((m) => m.humanClass),
    members: members.map((m) => m.planHash),
  };
  return Result.succeed({
    ...preimage,
    planHash: planHashOf(preimage),
    costEstimate: members.reduce((sum, m) => sum + m.costEstimate, 0),
  });
};
