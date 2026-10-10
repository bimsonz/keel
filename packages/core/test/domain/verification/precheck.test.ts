import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { matchesAny, matchesGlob } from "../../../src/domain/kernel/index.ts";
import {
  GUARD_PATHS,
  precheck,
  type PrecheckPolicy,
} from "../../../src/domain/verification/index.ts";
import { protectedGlobs, touchedPaths } from "../../arbitraries/paths.ts";
import { fc } from "../../support/fast-check.ts";

const policyArb: fc.Arbitrary<PrecheckPolicy> = protectedGlobs.map((protectedPaths) => ({
  protectedPaths,
  guardPaths: GUARD_PATHS,
}));

/** The oracle: every distinct touched path that a guard glob or a protected glob matches, sorted. */
const offending = (touched: readonly string[], policy: PrecheckPolicy) =>
  [...new Set(touched)]
    .filter((p) => matchesAny([...policy.guardPaths, ...policy.protectedPaths], p))
    .toSorted();

const isGuard = (path: string, policy: PrecheckPolicy) => matchesAny(policy.guardPaths, path);

describe("precheck", () => {
  it("[precheck.guard-refused] refuses every touched guard path, as a guard's", () => {
    fc.assert(
      fc.property(touchedPaths, policyArb, (touched, policy) => {
        const guards = touched.filter((p) => isGuard(p, policy));
        fc.pre(guards.length > 0);
        const result = precheck(touched, policy);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isSuccess(result)) return;
        for (const path of guards)
          expect(result.failure.paths).toContainEqual(
            expect.objectContaining({ path, rule: "guard" }),
          );
      }),
    );
  });

  it("[precheck.protected-refused] refuses every touched protected path that is not a guard's, as protected", () => {
    fc.assert(
      fc.property(touchedPaths, policyArb, (touched, policy) => {
        const protectedOnly = touched.filter(
          (p) => !isGuard(p, policy) && matchesAny(policy.protectedPaths, p),
        );
        fc.pre(protectedOnly.length > 0);
        const result = precheck(touched, policy);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isSuccess(result)) return;
        for (const path of protectedOnly)
          expect(result.failure.paths).toContainEqual(
            expect.objectContaining({ path, rule: "protected" }),
          );
      }),
    );
  });

  it("[precheck.exact] cites exactly the offending paths, once each, in order, each with a glob that matches it", () => {
    fc.assert(
      fc.property(touchedPaths, policyArb, (touched, policy) => {
        const expected = offending(touched, policy);
        fc.pre(expected.length > 0);
        const result = precheck(touched, policy);
        if (Result.isSuccess(result)) throw new Error(`passed, but ${expected.join(", ")} offend`);
        expect(result.failure.paths.map((r) => r.path)).toEqual(expected);
        for (const r of result.failure.paths) expect(matchesGlob(r.glob, r.path)).toBe(true);
      }),
    );
  });

  it("[precheck.clean-passes] passes a submission that touches no guard or protected path", () => {
    fc.assert(
      fc.property(touchedPaths, policyArb, (touched, policy) => {
        fc.pre(offending(touched, policy).length === 0);
        expect(precheck(touched, policy)).toEqual(
          Result.succeed({ touched: [...new Set(touched)].toSorted() }),
        );
      }),
    );
  });

  it("[precheck.order-free] gives the same ruling whatever the order of the paths, and however often each appears", () => {
    fc.assert(
      fc.property(
        touchedPaths.chain((t) =>
          fc.tuple(fc.constant(t), fc.shuffledSubarray([...t, ...t], { minLength: 2 * t.length })),
        ),
        policyArb,
        ([touched, reordered], policy) => {
          expect(precheck(reordered, policy)).toEqual(precheck(touched, policy));
        },
      ),
    );
  });

  it("[precheck.next-actions] gives a way forward for each rule broken, naming exactly its paths", () => {
    fc.assert(
      fc.property(touchedPaths, policyArb, (touched, policy) => {
        const result = precheck(touched, policy);
        fc.pre(Result.isFailure(result));
        if (Result.isSuccess(result)) return;
        for (const rule of ["guard", "protected"] as const) {
          const paths = result.failure.paths.filter((r) => r.rule === rule).map((r) => r.path);
          if (paths.length === 0) continue;
          const named = result.failure.nextActions.filter(
            (a) => JSON.stringify(a.args?.["paths"]) === JSON.stringify(paths),
          );
          expect({ rule, actions: named.length > 0 }).toEqual({ rule, actions: true });
        }
        for (const action of result.failure.nextActions)
          expect(action.title.length).toBeGreaterThan(0);
      }),
    );
  });

  it("refuses the guard tree with the shipped GUARD_PATHS, and lets the rest of .keel through", () => {
    const policy = { protectedPaths: [], guardPaths: GUARD_PATHS };
    expect(Result.isFailure(precheck([".keel/guards/auth.probe.ts"], policy))).toBe(true);
    expect(Result.isSuccess(precheck([".keel/flow.yaml", "src/app.ts"], policy))).toBe(true);
  });
});
