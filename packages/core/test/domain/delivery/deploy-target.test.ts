import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  clearDeployTarget,
  DeployTarget,
  type DeployTargetCleared,
  DeployTargetName,
  type DeployTargetRefused,
  DeployTargetSet,
  evolveDeployTargets,
  MAX_DEPLOY_TARGETS,
  resolveDeployTarget,
  setDeployTarget,
} from "../../../src/domain/delivery/index.ts";
import { makeId } from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const PROJECT = makeId("prj", ulid(1));
const OWNER = makeId("usr", ulid(1));
const nameOf = Schema.decodeUnknownSync(DeployTargetName);
/** More names than a project may hold, so a run can reach the cap and pass it. */
const NAMES = Array.from({ length: MAX_DEPLOY_TARGETS + 4 }, (_, i) => nameOf(`target-${i}`));
const ACCOUNTS = ["0".repeat(32), "a".repeat(32), "0123456789abcdef".repeat(2)];
const CREDENTIALS = [1, 2, 3].map((n) => makeId("crd", ulid(n)));

const target = (name: number, account = 0, credential = 0): DeployTarget => ({
  name: NAMES[name] ?? nameOf("target-0"),
  provider: "cloudflare",
  accountId: ACCOUNTS[account] ?? "0".repeat(32),
  credential: CREDENTIALS[credential] ?? makeId("crd", ulid(1)),
});

const targetArb: fc.Arbitrary<DeployTarget> = fc
  .tuple(fc.nat(NAMES.length - 1), fc.nat(2), fc.nat(2))
  .map(([name, account, credential]) => target(name, account, credential));

type Step =
  | { readonly _tag: "set"; readonly target: DeployTarget; readonly credentialInOrg: boolean }
  | { readonly _tag: "clear"; readonly name: DeployTargetName };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      _tag: fc.constant("set" as const),
      target: targetArb,
      credentialInOrg: fc.integer({ min: 1, max: 6 }).map((n) => n !== 1),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      _tag: fc.constant("clear" as const),
      name: fc.constantFrom(...NAMES),
    }),
  },
);
/**
 * Every fifth step is tried twice in a row, so each run sets a target to what
 * it already is and clears a name already cleared: generated steps alone
 * repeated a whole record about ten times in 300 runs.
 */
const stepsArb = fc
  .array(stepArb, { maxLength: 80 })
  .map((steps) => steps.flatMap((step, i) => (i % 5 === 0 ? [step, step] : [step])));

/** What the rules say a step does, kept apart from the code: the targets as a map by name. */
type Expected =
  | { readonly outcome: "set" | "unchanged" | "cleared" }
  | { readonly outcome: "refused"; readonly reason: DeployTargetRefused["reason"] };

const sameRecord = (a: DeployTarget, b: DeployTarget): boolean =>
  JSON.stringify([a.name, a.provider, a.accountId, a.credential]) ===
  JSON.stringify([b.name, b.provider, b.accountId, b.credential]);

const expectedOf = (held: ReadonlyMap<string, DeployTarget>, step: Step): Expected => {
  if (step._tag === "clear")
    return held.has(step.name) ? { outcome: "cleared" } : { outcome: "refused", reason: "not-set" };
  if (!step.credentialInOrg) return { outcome: "refused", reason: "credential-not-in-org" };
  const current = held.get(step.target.name);
  if (current !== undefined)
    return { outcome: sameRecord(current, step.target) ? "unchanged" : "set" };
  return held.size >= MAX_DEPLOY_TARGETS
    ? { outcome: "refused", reason: "too-many-targets" }
    : { outcome: "set" };
};

interface Played {
  readonly step: Step;
  readonly expected: Expected;
  readonly before: readonly DeployTarget[];
  readonly events: readonly unknown[] | undefined;
  readonly refused: DeployTargetRefused["reason"] | undefined;
  readonly after: readonly DeployTarget[];
}

type DeployTargetEvent = typeof DeployTargetSet.Type | typeof DeployTargetCleared.Type;

const decide = (
  targets: readonly DeployTarget[],
  step: Step,
): Result.Result<readonly DeployTargetEvent[], DeployTargetRefused> =>
  step._tag === "set"
    ? setDeployTarget(targets, {
        projectId: PROJECT,
        target: { ...step.target },
        by: OWNER,
        credentialInOrg: step.credentialInOrg,
      })
    : clearDeployTarget(targets, { projectId: PROJECT, name: step.name, by: OWNER });

/** Runs the steps through decide and evolve, with the map the rules predict beside them. */
const play = (
  steps: readonly Step[],
): { readonly trace: Played[]; readonly held: Map<string, DeployTarget> } => {
  const held = new Map<string, DeployTarget>();
  const trace: Played[] = [];
  let targets: readonly DeployTarget[] = [];
  for (const step of steps) {
    const expected = expectedOf(held, step);
    if (expected.outcome === "set" && step._tag === "set") held.set(step.target.name, step.target);
    if (expected.outcome === "cleared" && step._tag === "clear") held.delete(step.name);
    const before = targets;
    const decided = decide(targets, step);
    if (Result.isSuccess(decided))
      for (const event of decided.success) targets = evolveDeployTargets(targets, event);
    trace.push({
      step,
      expected,
      before,
      events: Result.isSuccess(decided) ? decided.success : undefined,
      refused: Result.isFailure(decided) ? decided.failure.reason : undefined,
      after: targets,
    });
  }
  return { trace, held };
};

const agrees = (played: Played): boolean =>
  played.expected.outcome === "refused"
    ? played.refused === played.expected.reason && played.after === played.before
    : played.refused === undefined &&
      played.events?.length === (played.expected.outcome === "unchanged" ? 0 : 1);

/** Strings shaped like the secrets a person might paste, built here so the file holds none. */
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const shaped = (length: number, alphabet: string): string =>
  Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
const SECRET_SHAPES = [
  shaped(40, TOKEN_ALPHABET),
  shaped(37, "0123456789abcdef"),
  [shaped(36, TOKEN_ALPHABET), shaped(120, TOKEN_ALPHABET), shaped(43, TOKEN_ALPHABET)].join("."),
  `${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}\n${shaped(64, TOKEN_ALPHABET)}`,
  `sk-${shaped(48, TOKEN_ALPHABET)}`,
];
/** Near misses of the two shapes: another kind's id, a short or lower-case ULID, hex of the wrong length or case. */
const NEAR_MISSES = [
  makeId("usr", ulid(1)),
  `crd_${ulid(1).slice(1)}`,
  `crd_${ulid(1)}0`,
  `crd_${"a".repeat(26)}`,
  `CRD_${ulid(1)}`,
  "0".repeat(31),
  "0".repeat(33),
  "A".repeat(32),
  "",
];

const decodeTarget = Schema.decodeUnknownResult(DeployTarget);
const decodeSet = Schema.decodeUnknownResult(DeployTargetSet);
const isTarget = (value: unknown): boolean => Result.isSuccess(decodeTarget(value));
const isSet = (value: unknown): boolean => Result.isSuccess(decodeSet(value));

describe("a project's deploy targets", () => {
  it("[deploy-target.reference-only] holds a credential's id and an account's id, and no other string in either place", () => {
    const record = target(0);
    const event = { _tag: "DeployTargetSet", projectId: PROJECT, target: record, by: OWNER };
    expect(isTarget(record)).toBe(true);
    expect(isSet(event)).toBe(true);
    const refusedEverywhere = (field: "credential" | "accountId", value: string): boolean =>
      !isTarget({ ...record, [field]: value }) &&
      !isSet({ ...event, target: { ...record, [field]: value } });
    for (const secret of [...SECRET_SHAPES, ...NEAR_MISSES]) {
      const wrongKind = { credential: CREDENTIALS, accountId: ACCOUNTS };
      for (const field of ["credential", "accountId"] as const)
        expect([field, secret, refusedEverywhere(field, secret)]).toEqual([field, secret, true]);
      expect(wrongKind.credential.every((id) => refusedEverywhere("accountId", id))).toBe(true);
      expect(wrongKind.accountId.every((id) => refusedEverywhere("credential", id))).toBe(true);
    }
    fc.assert(
      fc.property(fc.string(), (text) => {
        const credential = /^crd_[0-9A-HJKMNP-TV-Z]{26}$/.test(text);
        const account = /^[0-9a-f]{32}$/.test(text);
        return (
          refusedEverywhere("credential", text) === !credential &&
          refusedEverywhere("accountId", text) === !account
        );
      }),
    );
  });

  it("[deploy-target.own-org-credential] refuses a target whose credential is not in the project's org, and changes nothing", () => {
    let foreign = 0;
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const { trace } = play(steps);
        const outside = trace.filter((p) => p.step._tag === "set" && !p.step.credentialInOrg);
        foreign += outside.length;
        return outside.every(
          (p) => p.refused === "credential-not-in-org" && p.events === undefined && agrees(p),
        );
      }),
    );
    expect(foreign).toBeGreaterThan(0);
    const refused = setDeployTarget([], {
      projectId: PROJECT,
      target: target(0),
      by: OWNER,
      credentialInOrg: false,
    });
    expect(Result.isFailure(refused) && refused.failure.reason).toBe("credential-not-in-org");
  });

  it("[deploy-target.set-then-resolve] resolves a name to the last record set under it, one a name, in name order", () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const { trace, held } = play(steps);
        const targets = trace.at(-1)?.after ?? [];
        const names = targets.map((t) => t.name);
        return (
          JSON.stringify(names) === JSON.stringify([...held.keys()].toSorted()) &&
          NAMES.every((name) => {
            const resolved = resolveDeployTarget(targets, name);
            const expected = held.get(name);
            return expected === undefined
              ? Result.isFailure(resolved) && resolved.failure.reason === "not-set"
              : Result.isSuccess(resolved) && sameRecord(resolved.success, expected);
          })
        );
      }),
    );
    // Set twice under one name, with another name between: the later record wins and the order is by name.
    const { trace } = play([
      { _tag: "set", target: target(2, 0, 0), credentialInOrg: true },
      { _tag: "set", target: target(1, 0, 0), credentialInOrg: true },
      { _tag: "set", target: target(2, 1, 1), credentialInOrg: true },
      { _tag: "clear", name: NAMES[1] ?? nameOf("target-1") },
    ]);
    expect(trace[2]?.after).toEqual([target(1, 0, 0), target(2, 1, 1)]);
    expect(trace[3]?.after).toEqual([target(2, 1, 1)]);
  });

  it("[deploy-target.unchanged-silent] commits nothing for a target set to what it is, and one event with the whole record for any difference", () => {
    let unchanged = 0;
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const { trace } = play(steps);
        const sets = trace.filter((p) => p.step._tag === "set" && p.expected.outcome !== "refused");
        unchanged += sets.filter((p) => p.expected.outcome === "unchanged").length;
        return sets.every(
          (p) =>
            agrees(p) &&
            (p.expected.outcome === "unchanged"
              ? p.after === p.before
              : p.step._tag === "set" &&
                JSON.stringify(p.events) ===
                  JSON.stringify([
                    DeployTargetSet.make({ projectId: PROJECT, target: p.step.target, by: OWNER }),
                  ])),
        );
      }),
    );
    expect(unchanged).toBeGreaterThan(0);
    // One field apart, each in turn: an account or a credential set anew is a change.
    const held = [target(0, 0, 0)];
    const again = (next: DeployTarget) =>
      setDeployTarget(held, { projectId: PROJECT, target: next, by: OWNER, credentialInOrg: true });
    expect(Result.getOrThrow(again(target(0, 0, 0)))).toEqual([]);
    expect(Result.getOrThrow(again(target(0, 1, 0)))).toHaveLength(1);
    expect(Result.getOrThrow(again(target(0, 0, 1)))).toHaveLength(1);
  });

  it("[deploy-target.cap] refuses a name beyond the cap, and still takes a record in place of one it holds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_DEPLOY_TARGETS }),
        fc.nat(MAX_DEPLOY_TARGETS - 1),
        (count, replaced) => {
          const held = Array.from({ length: count }, (_, i) => target(i));
          const fresh = setDeployTarget(held, {
            projectId: PROJECT,
            target: target(count),
            by: OWNER,
            credentialInOrg: true,
          });
          const inPlace = setDeployTarget(held, {
            projectId: PROJECT,
            target: target(replaced % Math.max(count, 1), 1, 1),
            by: OWNER,
            credentialInOrg: true,
          });
          const full = count === MAX_DEPLOY_TARGETS;
          return (
            (full
              ? Result.isFailure(fresh) && fresh.failure.reason === "too-many-targets"
              : Result.isSuccess(fresh) && fresh.success.length === 1) &&
            (count === 0 || (Result.isSuccess(inPlace) && inPlace.success.length === 1))
          );
        },
      ),
    );
    expect(MAX_DEPLOY_TARGETS).toBe(16);
  });

  it("[deploy-target.clear] clears a name that is set with one event, and refuses a name that is not", () => {
    let cleared = 0;
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const { trace } = play(steps);
        const clears = trace.filter((p) => p.step._tag === "clear");
        cleared += clears.filter((p) => p.expected.outcome === "cleared").length;
        return clears.every(
          (p) =>
            agrees(p) &&
            (p.expected.outcome === "refused" ||
              (p.step._tag === "clear" &&
                JSON.stringify(p.events) ===
                  JSON.stringify([
                    {
                      _tag: "DeployTargetCleared",
                      projectId: PROJECT,
                      name: p.step.name,
                      by: OWNER,
                    },
                  ]))),
        );
      }),
    );
    expect(cleared).toBeGreaterThan(0);
    const absent = clearDeployTarget([target(0)], {
      projectId: PROJECT,
      name: NAMES[1] ?? nameOf("target-1"),
      by: OWNER,
    });
    expect(Result.isFailure(absent) && absent.failure.reason).toBe("not-set");
  });
});
