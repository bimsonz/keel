import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  compare,
  type Intent,
  preflight,
  type Proposition,
} from "../../../src/domain/coordination/index.ts";
import { type DecisionId, Instant, makeId } from "../../../src/domain/kernel/index.ts";
import {
  type Decision,
  type DecisionCommand,
  decideDecision,
  evolveDecision,
  type RulingFacts,
  scopedPrecedent,
} from "../../../src/domain/memory/index.ts";
import { comparablePairArb, key, write } from "../../arbitraries/coordination.ts";
import { fc } from "../../support/fast-check.ts";

const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
const DECISION = makeId("dec", ulid(1));
const LATER = makeId("dec", ulid(2));
const ESCALATION = makeId("esc", ulid(1));
const CHANGE = makeId("chg", ulid(1));
const SCOPES = [undefined, "env:prod", "env:prod;tenant:t1"] as const;

const OPTIONS = ["keep", "revert", "overrule"].map((id) => ({
  id,
  label: `choose ${id}`,
  consequence: `what ${id} does`,
}));
const ruled = (option: string, category: string): RulingFacts => ({
  id: ESCALATION,
  state: "ruled",
  category,
  options: OPTIONS,
  evidence: [{ class: "proof", summary: "probe fails in AB" }],
  ruling: { option },
});

/** How a decision's life went on after it was recorded. */
const ENDINGS = ["active", "superseded", "overruled"] as const;
type Ending = (typeof ENDINGS)[number];

/**
 * A decision as the machine makes it: recorded at `T0` on a ruling of `keep`
 * over `scope`, then ended the given way a tick later, each command decided
 * and its events folded.
 */
const lifeOf = (id: DecisionId, scope: string | undefined, ending: Ending): Decision => {
  const over = scope === undefined ? {} : { scope };
  const steps: readonly { readonly command: DecisionCommand; readonly ruling: RulingFacts }[] = [
    { command: { _tag: "Record", ...over }, ruling: ruled("keep", "permission-semantics") },
    ...(ending === "superseded"
      ? [
          {
            command: { _tag: "Supersede" as const, by: LATER, ...over },
            ruling: ruled("keep", "permission-semantics"),
          },
        ]
      : []),
    ...(ending === "overruled"
      ? [
          {
            command: { _tag: "Overrule" as const, by: LATER, requestedBy: CHANGE },
            ruling: ruled("overrule", "overrule-request"),
          },
        ]
      : []),
  ];
  const decision = steps.reduce<Decision | undefined>((state, { command, ruling }, i) => {
    const now = Instant(T0 + i);
    const decided = decideDecision(state, command, { now, decisionId: id, escalation: ruling });
    if (Result.isFailure(decided)) throw new Error(`${command._tag} was refused`);
    return decided.success.reduce<Decision | undefined>(
      (s, payload) => evolveDecision(s, { at: now, payload }),
      state,
    );
  }, undefined);
  if (decision === undefined) throw new Error("nothing was recorded");
  return decision;
};

const authz = key("authz");
const P: Proposition = {
  subject: authz,
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
};
const E: Proposition = { ...P, relation: "is", value: "per-session", scope: "env:prod" };

/** A premise and an effect that contradict each other on the lattice. */
const contradictingPairArb = comparablePairArb()
  .map(({ premise, effect }) => ({ premise: write(premise), effect: write(effect) }))
  .filter(({ premise, effect }) => compare(premise, effect).outcome === "contradicts");

describe("the precedent a decision scopes", () => {
  it("[precedent.ended-scopes-none] an active decision scopes a precedent of its own id, summary, date and scope with what it upheld as given; superseded or overruled, it scopes none", () => {
    const cases = SCOPES.flatMap((scope) =>
      ENDINGS.flatMap((ending) => [[], [P], [P, E]].map((upheld) => ({ scope, ending, upheld }))),
    );
    type Case = (typeof cases)[number];
    const got = ({ scope, ending, upheld }: Case) => {
      const decision = lifeOf(DECISION, scope, ending);
      return { state: decision.state, precedent: scopedPrecedent(decision, upheld) };
    };
    const expected = ({ scope, ending, upheld }: Case) => ({
      state: ending,
      precedent:
        ending === "active"
          ? {
              ref: {
                decisionId: DECISION,
                summary: "choose keep",
                decidedAt: T0,
                ...(scope === undefined ? {} : { scope }),
              },
              holds: upheld,
            }
          : undefined,
    });
    expect(cases.map((c) => ({ ...c, ...got(c) }))).toStrictEqual(
      cases.map((c) => ({ ...c, ...expected(c) })),
    );
  });

  it("[precedent.ended-not-met] an intent that contradicts what a decision upheld is told to distinguish it while the decision is active; once it is superseded or overruled the intent proceeds, the ended decision is not listed, and the decision that ended it brings only what it upheld itself", () => {
    fc.assert(
      fc.property(
        contradictingPairArb,
        fc.boolean(),
        fc.constantFrom(...SCOPES),
        ({ premise, effect }, viaPremise, scope) => {
          const intent: Intent = viaPremise
            ? { revision: 1, goal: "g", footprint: [], premises: [premise] }
            : { revision: 1, goal: "g", footprint: [], premises: [], declaredEffects: [effect] };
          const met = ENDINGS.map((ending) => {
            const rows = [
              { decision: lifeOf(DECISION, scope, ending), holds: [viaPremise ? effect : premise] },
              { decision: lifeOf(LATER, scope, "active"), holds: [] },
            ];
            const told = preflight(
              CHANGE,
              intent,
              { neighbours: [], contradictions: [] },
              rows.flatMap((r) => scopedPrecedent(r.decision, r.holds) ?? []),
            );
            return {
              ending,
              move: told.suggestedMove,
              basis: told.basis,
              listed: told.precedents.map((p) => p.decisionId),
            };
          });
          expect(met).toEqual([
            {
              ending: "active",
              move: "distinguish",
              basis: { _tag: "precedent", decisionId: DECISION },
              listed: [DECISION, LATER],
            },
            { ending: "superseded", move: "proceed", basis: undefined, listed: [LATER] },
            { ending: "overruled", move: "proceed", basis: undefined, listed: [LATER] },
          ]);
        },
      ),
    );
  });
});
