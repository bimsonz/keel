import { FEED } from "@keeltown/core/application/memory";
import {
  getVerdict,
  indexVerdicts,
  VERDICT_INDEX,
  VERDICT_INDEX_STEP,
  VERDICT_READ_STEPS,
  verdictReasons,
} from "@keeltown/core/application/verification";
import type { PlanStep } from "@keeltown/core/domain/verification";
import { EventEnvelope, ProjectId, VerdictId } from "@keeltown/core/kernel";
import { EntityStore, type Stored } from "@keeltown/core/ports";
import { makeEntityStoreMemory } from "@keeltown/testing";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

const PROJECT = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8AA");
const encode = Schema.encodeSync(EventEnvelope);
const position = (n: number) => String(n).padStart(12, "0");
const verdictIdOf = (n: number) =>
  Schema.decodeUnknownSync(VerdictId)(`vrd_01JZ8PT2C4E6G8J0M2N4${String(n).padStart(6, "0")}`);

/** The event at feed position `n`: a VerdictIssued when `verdict`, a ChangeStarted otherwise. */
const arrival = (n: number, verdict: boolean): Stored =>
  JSON.parse(
    JSON.stringify(
      encode(
        Schema.decodeUnknownSync(EventEnvelope)({
          eventId: `evt_01JZ8PT2C4E6G8J0M2N4${String(n).padStart(6, "0")}`,
          type: verdict ? "VerdictIssued" : "ChangeStarted",
          entity: verdict
            ? { kind: "verdict", id: verdictIdOf(n) }
            : { kind: "change", id: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
          seq: 1,
          at: 1_700_000_000_000 + n,
          dedupeKey: `n${n}`,
          project: PROJECT,
          affected: [],
          notified: ["projector"],
          payload: verdict
            ? {
                _tag: "VerdictIssued",
                verdictId: verdictIdOf(n),
                subject: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
                outcome: "bounce",
                evidence: [`failed: test ${n}`],
              }
            : { _tag: "ChangeStarted", changeId: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
        }),
      ),
    ),
  );

type Store = (typeof EntityStore)["Service"];

/** A feed of `length` entries, recorded before any verdict index existed, with a verdict at each of `verdicts`. */
function feedOf(length: number, verdicts: readonly number[]): Store {
  const store = makeEntityStoreMemory().service;
  for (let n = 1; n <= length; n += 1)
    store.put(FEED.kind, position(n), arrival(n, verdicts.includes(n)));
  store.put(FEED.head.kind, FEED.head.id, length);
  return store;
}

const read = (store: Store, n: number) =>
  Effect.runSyncExit(Effect.provideService(getVerdict(verdictIdOf(n)), EntityStore, store));

const indexedTo = (store: Store) => store.get(VERDICT_INDEX.indexed.kind, VERDICT_INDEX.indexed.id);

describe("the verdict index", () => {
  it("[verdict.index-finds] finds a verdict the feed holds by its id alone, with its project and when it was issued, and no other", () => {
    const store = feedOf(30, [7, 21]);
    const found = read(store, 21);
    expect(Exit.isSuccess(found) && found.value).toMatchObject({
      verdict: { verdictId: verdictIdOf(21), outcome: "bounce", evidence: ["failed: test 21"] },
      project: PROJECT,
      issuedAt: 1_700_000_000_021,
    });
    expect(Exit.isSuccess(read(store, 7))).toBe(true);
    const missing = read(store, 8);
    expect(Exit.isFailure(missing) && JSON.stringify(missing.cause)).toContain("VerdictNotFound");
  });

  it("[verdict.index-catch-up] walks a feed recorded before it in bounded steps from its own marker, and stops at the head", () => {
    const store = feedOf(25, [1, 11, 25]);
    expect(indexVerdicts(store, 10)).toEqual({ to: 10, level: false });
    expect(store.get(VERDICT_INDEX.at, verdictIdOf(1))).toBe(1);
    expect(store.get(VERDICT_INDEX.at, verdictIdOf(11))).toBeUndefined();
    expect(indexVerdicts(store, 10)).toEqual({ to: 20, level: false });
    expect(store.get(VERDICT_INDEX.at, verdictIdOf(11))).toBe(11);
    expect(indexVerdicts(store, 10)).toEqual({ to: 25, level: true });
    expect(store.get(VERDICT_INDEX.at, verdictIdOf(25))).toBe(25);
    expect(indexVerdicts(store, 10)).toEqual({ to: 25, level: true });
    expect(indexedTo(store)).toBe(25);
  });

  it("[verdict.read-steps] a read that misses moves the index on at most VERDICT_READ_STEPS steps, and the next read goes on from there", () => {
    const far = VERDICT_READ_STEPS * VERDICT_INDEX_STEP + 5;
    const store = feedOf(far, [far]);
    expect(Exit.isFailure(read(store, far))).toBe(true);
    expect(indexedTo(store)).toBe(VERDICT_READ_STEPS * VERDICT_INDEX_STEP);
    expect(Exit.isSuccess(read(store, far))).toBe(true);
    expect(indexedTo(store)).toBe(far);
  });
});

const step = (id: string, extra: Partial<PlanStep> = {}): PlanStep => ({
  id,
  kind: "deterministic",
  evidenceCeiling: "proof",
  appliesTo: [],
  tier: { tier: 2, reason: "policy" },
  because: "the flow",
  ...extra,
});

describe("a verdict's reasons", () => {
  it("[verdict.reasons] classes each line by the plan step it names, the longest id first, and a line naming none as proof", () => {
    const steps = [
      step("keel"),
      step("keel.test", { evidenceCeiling: "testimony" }),
      step("guard:grd_1", { evidenceCeiling: "proof", effectiveClass: "opinion" }),
    ];
    expect(
      verdictReasons(
        [
          "keel.test: fail (testimony, tier 2: policy) evidence sha256:aa",
          "guard failed: guard:grd_1 (freshness): subject GET /x -> 200 (expected 404)",
          "failed: test/a.test.ts > a",
          "keel: pass (proof, tier 2: policy)",
        ],
        steps,
      ),
    ).toEqual([
      {
        line: "keel.test: fail (testimony, tier 2: policy) evidence sha256:aa",
        step: "keel.test",
        class: "testimony",
      },
      {
        line: "guard failed: guard:grd_1 (freshness): subject GET /x -> 200 (expected 404)",
        step: "guard:grd_1",
        class: "opinion",
      },
      { line: "failed: test/a.test.ts > a", class: "proof" },
      { line: "keel: pass (proof, tier 2: policy)", step: "keel", class: "proof" },
    ]);
    expect(verdictReasons(["keel.test: fail"], [])).toEqual([
      { line: "keel.test: fail", class: "proof" },
    ]);
  });
});
