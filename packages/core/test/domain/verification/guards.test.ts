import { describe, expect, it } from "vitest";
import {
  type Proposition,
  type SubjectKey,
  subjectsRelated,
  subjectsSiblings,
} from "../../../src/domain/coordination/index.ts";
import { CommitSha, contentHashOf, makeId } from "../../../src/domain/kernel/index.ts";
import {
  type AdmittedGuard,
  type GuardExposure,
  guardStepId,
  guardSteps,
  selectGuards,
} from "../../../src/domain/verification/index.ts";
import { key, subjectArb } from "../../arbitraries/coordination.ts";
import { heldDecisionArb } from "../../arbitraries/flow.ts";
import { graphPropositionArb } from "../../arbitraries/graph.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const paths = ["src/authz/check.ts", "src/authz/cache.ts", "src/billing/charge.ts", "README.md"];

/** An admitted guard; before TenetEstablished it has no tenet id, only the proposition it holds. */
const guardArb = (n: number): fc.Arbitrary<AdmittedGuard> =>
  fc.tuple(graphPropositionArb, fc.boolean()).map(([proposition, named]) => ({
    guardId: makeId("grd", ulid(n)),
    probe: contentHashOf({ probe: n }),
    tenet: named ? { id: makeId("tnt", ulid(n)), proposition } : { proposition },
  }));

/** The same guards, before any tenet is established. */
const unnamed = (admitted: readonly AdmittedGuard[]): readonly AdmittedGuard[] =>
  admitted.map((g) => ({ ...g, tenet: { proposition: g.tenet.proposition } }));

/** Up to four admitted guards with distinct ids, listed in any order. */
const admittedArb: fc.Arbitrary<readonly AdmittedGuard[]> = fc
  .subarray([1, 2, 3, 4], { maxLength: 4 })
  .chain((ns) => fc.tuple(...ns.map(guardArb)))
  .chain((gs: readonly AdmittedGuard[]) => fc.shuffledSubarray([...gs], { minLength: gs.length }));

/** Two distinct children of one parent: near, but neither related to the other. */
const siblingsArb: fc.Arbitrary<readonly [SubjectKey, SubjectKey]> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom("authz", "billing"),
      fc.shuffledSubarray(["cache", "audit-log", "permission-evaluation"], {
        minLength: 2,
        maxLength: 2,
      }),
    )
    .map(
      ([top, [x = "cache", y = "audit-log"]]) => [key(`${top}.${x}`), key(`${top}.${y}`)] as const,
    ),
  fc
    .tuple(
      fc.constantFrom("authz.cache", "billing.audit-log"),
      fc.shuffledSubarray(["read", "write"], { minLength: 2, maxLength: 2 }),
    )
    .map(([mid, [x = "read", y = "write"]]) => [key(`${mid}.${x}`), key(`${mid}.${y}`)] as const),
);

/** The same guards, some holding a decision: drawn after `admittedArb`'s own draws, so the tests on that keep theirs. */
const ruledArb: fc.Arbitrary<readonly AdmittedGuard[]> = admittedArb.chain((gs) =>
  fc.tuple(...gs.map(() => fc.option(heldDecisionArb, { nil: undefined }))).map((held) =>
    gs.map((g, i) => {
      const decision = held[i];
      return decision === undefined ? g : { ...g, decision };
    }),
  ),
);

/** A guard as listed with no decision. */
const unruledOf = (g: AdmittedGuard): AdmittedGuard => ({
  guardId: g.guardId,
  probe: g.probe,
  tenet: g.tenet,
});

/** The decision the one step holds, for a list of listings of one guard on `authz`. */
const keptOf = (listed: readonly AdmittedGuard[]) =>
  selectGuards(listed, { subjects: [key("authz")], touchedPaths: [] })[0]?.spec.guards?.decision;

const exposureArb: fc.Arbitrary<GuardExposure> = fc.record({
  subjects: fc.array(subjectArb, { maxLength: 2 }),
  touchedPaths: fc.subarray(paths, { maxLength: 2 }),
});

/** Exposure's never-miss rule, written out: a near subject, or an edit to an anchored path. */
const exposed = (tenet: Proposition, change: GuardExposure): boolean =>
  change.subjects.some(
    (s) => subjectsRelated(s, tenet.subject) || subjectsSiblings(s, tenet.subject),
  ) || (tenet.anchors ?? []).some((a) => change.touchedPaths.includes(a.path));

const ids = (steps: readonly { readonly id: string }[]): readonly string[] =>
  steps.map((s) => s.id);

const tenetOn = (subject: SubjectKey, anchored: readonly string[] = []): Proposition => ({
  subject,
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
  anchors: anchored.map((path) => ({ path, commit: CommitSha.make("a".repeat(40)) })),
});
const admittedOn = (tenet: Proposition): AdmittedGuard => ({
  guardId: makeId("grd", ulid(7)),
  probe: contentHashOf({ probe: 7 }),
  tenet: { id: makeId("tnt", ulid(7)), proposition: tenet },
});

describe("guardSteps: which admitted guards a change runs", () => {
  it("[guards.apply-by-subject] a change runs exactly the guards it is exposed to: a near subject or an anchored edit", () => {
    let near = 0;
    fc.assert(
      fc.property(admittedArb, exposureArb, (admitted, change) => {
        const want = admitted
          .filter((g) => exposed(g.tenet.proposition, change))
          .map((g) => guardStepId(g.guardId))
          .toSorted();
        for (const g of admitted)
          if (
            change.subjects.some(
              (s) =>
                s !== g.tenet.proposition.subject &&
                subjectsRelated(s, g.tenet.proposition.subject),
            )
          )
            near++;
        return ids(guardSteps(admitted, change)).join() === want.join();
      }),
    );
    expect(near).toBeGreaterThan(0);
    const g = admittedOn(tenetOn(key("authz.permission-evaluation")));
    expect(ids(guardSteps([g], { subjects: [key("authz")], touchedPaths: [] }))).toEqual([
      guardStepId(g.guardId),
    ]);
    expect(guardSteps([g], { subjects: [key("billing")], touchedPaths: [] })).toEqual([]);
  });

  it("[guards.tenet-id-optional] a guard admitted before its tenet is established is selected by exposure and compiles to the same step, citing the guard", () => {
    fc.assert(
      fc.property(admittedArb, exposureArb, (admitted, change) => {
        const before = selectGuards(unnamed(admitted), change);
        const after = selectGuards(admitted, change);
        return (
          JSON.stringify(before.map((g) => g.spec)) === JSON.stringify(after.map((g) => g.spec)) &&
          before.every((g) => g.because[0] === `guards ${g.spec.id.slice("guard:".length)}`)
        );
      }),
    );
    const g = admittedOn(tenetOn(key("authz.permission-evaluation")));
    const [selected] = selectGuards(unnamed([g]), { subjects: [key("authz")], touchedPaths: [] });
    expect(selected?.because[0]).toBe(`guards ${g.guardId}`);
  });

  it("[guards.sibling-applies] a change near the tenet's subject only as a sibling still runs the guard", () => {
    fc.assert(
      fc.property(siblingsArb, ([a, b]) => {
        const g = admittedOn(tenetOn(a));
        return (
          subjectsSiblings(a, b) &&
          ids(guardSteps([g], { subjects: [b], touchedPaths: [] })).length === 1
        );
      }),
    );
    const g = admittedOn(tenetOn(key("authz.cache")));
    expect(
      ids(guardSteps([g], { subjects: [key("authz.permission-evaluation")], touchedPaths: [] })),
    ).toEqual([guardStepId(g.guardId)]);
  });

  it("[guards.anchored-edit] a change that declares nothing but edits code the tenet anchors runs the guard", () => {
    fc.assert(
      fc.property(subjectArb, fc.constantFrom(...paths), (subject, path) => {
        const g = admittedOn(tenetOn(subject, [path]));
        return ids(guardSteps([g], { subjects: [], touchedPaths: [path] })).length === 1;
      }),
    );
    const g = admittedOn(tenetOn(key("authz.cache"), ["src/authz/cache.ts"]));
    expect(guardSteps([g], { subjects: [], touchedPaths: ["src/authz/cache.ts"] })).toHaveLength(1);
    expect(guardSteps([g], { subjects: [], touchedPaths: ["src/authz/check.ts"] })).toEqual([]);
  });

  it("[guards.step-shape] each step is a proof probe running the guard's admitted bundle, under its tenet's predicate", () => {
    fc.assert(
      fc.property(admittedArb, exposureArb, (admitted, change) =>
        guardSteps(admitted, change).every((s) => {
          const g = admitted.find((x) => guardStepId(x.guardId) === s.id);
          return (
            g !== undefined &&
            s.kind === "probe" &&
            s.evidenceCeiling === "proof" &&
            s.version === g.probe &&
            s.guards?.probe === g.probe &&
            s.guards.predicate === g.tenet.proposition.predicate &&
            s.outcomes.includes("abstain") &&
            !s.optional
          );
        }),
      ),
    );
    const g = admittedOn(tenetOn(key("authz")));
    const [step] = guardSteps([g], { subjects: [key("authz")], touchedPaths: [] });
    expect([step?.version, step?.guards]).toEqual([
      g.probe,
      { predicate: "freshness", probe: g.probe },
    ]);
  });

  it("[guards.canonical] the steps depend on the set of admitted guards alone: in step-id order, one per guard", () => {
    fc.assert(
      fc.property(admittedArb, exposureArb, fc.boolean(), (admitted, change, doubled) => {
        const reordered = admitted.toReversed();
        const listed = doubled ? [...reordered, ...admitted] : reordered;
        const a = guardSteps(admitted, change);
        const b = guardSteps(listed, change);
        return (
          JSON.stringify(a) === JSON.stringify(b) && ids(a).join() === ids(a).toSorted().join()
        );
      }),
    );
    const one = admittedOn(tenetOn(key("authz")));
    const two = { ...one, guardId: makeId("grd", ulid(2)) };
    expect(
      ids(guardSteps([one, two, one], { subjects: [key("authz")], touchedPaths: [] })),
    ).toEqual([guardStepId(two.guardId), guardStepId(one.guardId)]);
  });

  it("[guards.holds-decision] a guard's step carries the decision it holds, and cites it after the guard's name and before the exposure", () => {
    let ruled = 0;
    let unruled = 0;
    assertReaching(
      fc.property(ruledArb, exposureArb, (admitted, change) =>
        selectGuards(admitted, change).every((s) => {
          const g = admitted.find((x) => guardStepId(x.guardId) === s.spec.id);
          if (g === undefined) return false;
          const [name, ...exposure] = selectGuards([unruledOf(g)], change)[0]?.because ?? [];
          const cited =
            g.decision === undefined
              ? []
              : [`holds decision ${g.decision.id}: ${g.decision.summary}`];
          if (g.decision === undefined) unruled++;
          else ruled++;
          return (
            JSON.stringify(s.because) === JSON.stringify([name, ...cited, ...exposure]) &&
            JSON.stringify(s.spec.guards?.decision) === JSON.stringify(g.decision)
          );
        }),
      ),
    );
    expect(ruled).toBeGreaterThan(0);
    expect(unruled).toBeGreaterThan(0);

    const decision = { id: makeId("dec", ulid(1)), summary: "The premise holds" };
    const g = { ...admittedOn(tenetOn(key("authz"))), decision };
    const [selected] = selectGuards([g], { subjects: [key("authz")], touchedPaths: [] });
    expect(selected?.spec.guards).toEqual({ predicate: "freshness", probe: g.probe, decision });
    expect(selected?.because).toEqual([
      `guards tenet ${g.tenet.id}`,
      `holds decision ${decision.id}: The premise holds`,
      "relies on or alters authz, near authz",
    ]);
  });

  it("[guards.canonical-ruled] a guard listed with rival decisions gives the same step in every order: a decision held before none, then the least id", () => {
    let rivalled = 0;
    assertReaching(
      fc.property(
        ruledArb,
        fc.array(fc.option(heldDecisionArb, { nil: undefined }), { minLength: 1, maxLength: 3 }),
        exposureArb,
        (admitted, rivals, change) => {
          const [g] = admitted;
          if (g === undefined) return true;
          const listed = [
            ...admitted,
            ...rivals.map((decision) =>
              decision === undefined ? unruledOf(g) : { ...unruledOf(g), decision },
            ),
          ];
          const a = selectGuards(listed, change);
          const kept = a.find((s) => s.spec.id === guardStepId(g.guardId));
          const held = [g.decision, ...rivals].flatMap((d) => (d === undefined ? [] : [d.id]));
          if (kept !== undefined && new Set([g.decision?.id, ...rivals.map((d) => d?.id)]).size > 1)
            rivalled++;
          return (
            JSON.stringify(a) === JSON.stringify(selectGuards(listed.toReversed(), change)) &&
            (kept === undefined || kept.spec.guards?.decision?.id === held.toSorted()[0])
          );
        },
      ),
    );
    expect(rivalled).toBeGreaterThan(0);

    const bare = admittedOn(tenetOn(key("authz")));
    const one = { ...bare, decision: { id: makeId("dec", ulid(1)), summary: "The premise holds" } };
    const two = { ...bare, decision: { id: makeId("dec", ulid(2)), summary: "Another ruling" } };
    expect([keptOf([one, bare]), keptOf([bare, one])]).toEqual([one.decision, one.decision]);
    expect([keptOf([one, two]), keptOf([two, one])]).toEqual([one.decision, one.decision]);
  });
});
