import { describe, expect, it } from "vitest";
import type { Proposition } from "../../../src/domain/coordination/index.ts";
import { type ChangeId, makeId } from "../../../src/domain/kernel/index.ts";
import { holds } from "../../../src/domain/verification/index.ts";
import { CHANGE_A, CHANGE_B, EFFECTS, PREMISE } from "./ledger.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
/** A change on neither side of the conflict, and another. */
const THIRD = makeId("chg", ulid(3));
const STRANGER = makeId("chg", ulid(4));

/** Every order of every subset: `against` is a list, and no place in it is special. */
const arrangements = <T>(items: readonly T[]): readonly (readonly T[])[] => [
  [],
  ...items.flatMap((item, i) =>
    arrangements(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest]),
  ),
];

const SIDES = [undefined, CHANGE_A, CHANGE_B] as const;
/** A premise as written against one effect, and the same premise held as a `should` against a scoped one. */
const PROPOSITIONS: readonly { readonly premise: Proposition; readonly effect: Proposition }[] = [
  { premise: PREMISE, effect: EFFECTS[1] ?? PREMISE },
  { premise: { ...PREMISE, strength: "should" }, effect: EFFECTS[3] ?? PREMISE },
];

interface Case {
  readonly holder: ChangeId | undefined;
  readonly author: ChangeId | undefined;
  readonly premise: Proposition;
  readonly effect: Proposition;
  readonly against: readonly ChangeId[];
}
/** Each side named or not, by one change or by two, under every ruling: against any of the sides and the others, in any order. */
const CASES: readonly Case[] = SIDES.flatMap((holder) =>
  SIDES.flatMap((author) =>
    PROPOSITIONS.flatMap(({ premise, effect }) =>
      arrangements([CHANGE_A, CHANGE_B, THIRD, STRANGER]).map((against) => ({
        holder,
        author,
        premise,
        effect,
        against,
      })),
    ),
  ),
);

/**
 * What a ruling upheld, by which of the conflict's two sides it went against:
 * the holder of the premise, the author of the effect. Written apart from
 * `holds`.
 */
const UPHELD = {
  neither: "nothing",
  author: "premise",
  holder: "effect",
  both: "nothing",
} as const;

const upheld = (c: Case): "premise" | "effect" | "nothing" => {
  if (c.holder === undefined || c.author === undefined) return "nothing";
  const holder = c.against.includes(c.holder);
  const author = c.against.includes(c.author);
  return UPHELD[holder && author ? "both" : holder ? "holder" : author ? "author" : "neither"];
};

const expected = (c: Case): readonly Proposition[] => {
  const side = upheld(c);
  return side === "premise" ? [c.premise] : side === "effect" ? [c.effect] : [];
};

const got = (c: Case): readonly Proposition[] =>
  holds(
    {
      ...(c.holder === undefined ? {} : { premise: { holder: c.holder, proposition: c.premise } }),
      ...(c.author === undefined ? {} : { effect: { changeId: c.author, proposition: c.effect } }),
    },
    c.against,
  );

describe("what a ruling upheld", () => {
  it("[conflict.holds] a ruling upheld the side it did not go against, as the conflict carries it: the premise when only the effect's change lost, the effect when only the premise's holder lost, and nothing when neither or both lost or the conflict does not name two sides", () => {
    expect(CASES.map((c) => ({ ...c, holds: got(c) }))).toEqual(
      CASES.map((c) => ({ ...c, holds: expected(c) })),
    );
    const count = (side: ReturnType<typeof upheld>): number =>
      CASES.filter((c) => upheld(c) === side).length;
    expect({
      premise: count("premise"),
      effect: count("effect"),
      nothing: count("nothing"),
    }).toEqual({ premise: 44, effect: 44, nothing: 1082 });
  });
});
