import { Brand, Result } from "effect";
import type { ChangeId } from "../kernel/index.ts";
import { compare } from "./compare.ts";
import { InvalidProbeCost } from "./errors.ts";
import type { GuardedTenet, HeldPremise } from "./graph.ts";

/** What it would cost to probe a premise: positive and finite. */
export type ProbeCost = Brand.Branded<number, "ProbeCost">;
const asProbeCost = Brand.nominal<ProbeCost>();

export const probeCost = (cost: number): Result.Result<ProbeCost, InvalidProbeCost> =>
  Number.isFinite(cost) && cost > 0
    ? Result.succeed(asProbeCost(cost))
    : Result.fail(new InvalidProbeCost(Number.isFinite(cost) ? { cost } : {}));

/**
 * A premise no tenet guards: the fleet is betting on it, and its probe is the
 * falsifier. `blast` is how much stands on it.
 */
export type Bet = {
  readonly premise: HeldPremise;
  readonly blast: number;
  readonly cost: ProbeCost;
  readonly standing: {
    readonly changes: readonly ChangeId[];
    readonly premises: readonly HeldPremise[];
  };
};

const isMust = (p: HeldPremise): boolean => (p.proposition.strength ?? "must") === "must";

/** A guarded tenet that speaks for the premise's whole domain, inside what it relies on. */
const guarded = (premise: HeldPremise, tenets: readonly GuardedTenet[]): boolean =>
  tenets.some(
    (t) =>
      t.guards.length > 0 && compare(premise.proposition, t.proposition).outcome === "compatible",
  );

/**
 * `other` stands on `premise` when it fails whenever the premise does: a
 * `must` premise whose claim sits inside the premise's, over at least its
 * subject and scope. Only `must` premises count.
 */
const standsOn = (other: HeldPremise, premise: HeldPremise): boolean =>
  isMust(other) && compare(premise.proposition, other.proposition).outcome === "compatible";

/** The order among equal scores: by holder, then by the claim itself. Narrative never counts. */
const tieKey = (p: HeldPremise): string => {
  const q = p.proposition;
  return [
    p.holder,
    q.subject,
    q.predicate,
    q.relation,
    String(q.value),
    q.unit ?? "",
    q.scope ?? "",
  ].join("\u0000");
};

/**
 * Every unguarded premise, ranked by blast ÷ probe cost, highest first. Blast
 * counts the live changes and premises standing on the bet. An agent's
 * confidence is never an input.
 */
export const rankBets = (
  premises: readonly HeldPremise[],
  tenets: readonly GuardedTenet[],
  costOf: (premise: HeldPremise) => ProbeCost,
): readonly Bet[] =>
  premises
    .filter((premise) => !guarded(premise, tenets))
    .map((premise): Bet => {
      const standing = premises.filter((other) => standsOn(other, premise));
      const changes = [...new Set(standing.map((p) => p.holder))];
      return {
        premise,
        blast: changes.length + standing.length,
        cost: costOf(premise),
        standing: { changes, premises: standing },
      };
    })
    .toSorted((a, b) => {
      const byScore = b.blast / b.cost - a.blast / a.cost;
      if (byScore !== 0) return byScore;
      const ka = tieKey(a.premise);
      const kb = tieKey(b.premise);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
