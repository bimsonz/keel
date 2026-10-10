import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decideSketch,
  decideWorkspace,
  evolveSketch,
  evolveWorkspace,
  replaySketch,
  replayWorkspace,
  Sketch,
  type SketchCommand,
  SketchEvent,
  Workspace,
  type WorkspaceCommand,
  WorkspaceEvent,
} from "../../../src/domain/coordination/index.ts";
import {
  canonicalJson,
  CommitSha,
  type Committed,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { sketchChart, workspaceChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import {
  eventsOf,
  failureTag,
  type Fold,
  type Machine,
  memo,
  play,
  type Played,
  tour,
} from "../../support/machine.ts";

/**
 * Each property plays hundreds of seeded runs through decide and evolve; on a
 * busy runner the full unit suite can push one past vitest's 5 s default, so
 * it gets the arch tests' limit instead of fewer runs.
 */
const PROPERTY_TIMEOUT = 60_000;

const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
const WORKSPACE = makeId("wsp", ulid(1));
const SKETCH = makeId("sk", ulid(1));
const OTHER_SKETCH = makeId("sk", ulid(2));
const CHANGE_A = makeId("chg", ulid(1));
const CHANGE_B = makeId("chg", ulid(2));
const AGENT = makeId("agt", ulid(1));
const BASE = CommitSha.make("b".repeat(40));
const TTL = 60 * 60 * 1000;

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));

/** The log as the outbox persists it, and back: encoded, serialised, decoded. */
const throughTheWire = <E>(
  schema: Schema.Codec<E, unknown>,
  log: readonly Committed<E>[],
): Committed<E>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(schema)(c.payload) }))),
  ).map((w) => ({
    at: Instant(w.at),
    payload: Schema.decodeUnknownSync(schema)(w.payload),
  }));

const mode = fc.oneof(
  { weight: 5, arbitrary: fc.constant("progress" as const) },
  { weight: 2, arbitrary: fc.constant("any" as const) },
);

// Workspace

type WKind = WorkspaceCommand["_tag"];
type WKey = "none" | Workspace["state"];
const W_KINDS: readonly WKind[] = ["Fork", "Grant", "Reassign", "Pushed", "Collect"];
const W_PROGRESS: Readonly<Record<WKey, readonly WKind[]>> = {
  none: ["Fork"],
  ready: ["Grant", "Grant", "Collect"],
  granted: ["Reassign", "Pushed", "Grant", "Collect"],
  collected: W_KINDS,
};

interface WStep {
  readonly mode: "progress" | "any";
  readonly pick: number;
  readonly who: number;
}
const wStepArb: fc.Arbitrary<WStep> = fc.record({ mode, pick: fc.nat(), who: fc.nat({ max: 5 }) });
const wPlanArb = fc.array(wStepArb, { minLength: 2, maxLength: 12 });

const HOLDERS = [CHANGE_A, SKETCH, CHANGE_B] as const;

const wBuild = (kind: WKind, state: Workspace | undefined, step: WStep): WorkspaceCommand => {
  switch (kind) {
    case "Fork":
      return { _tag: "Fork", repo: "keel-ws-1", sourceRepo: "keel-trunk" };
    case "Grant":
      // Mostly the holder it already has (a retried grant), sometimes another.
      return {
        _tag: "Grant",
        holder:
          step.who < 3 && state?.holder !== undefined
            ? state.holder
            : (HOLDERS[step.who % 3] ?? CHANGE_A),
        expiresAt: Instant(T0 + TTL),
        baseSha: BASE,
      };
    case "Reassign":
      return {
        _tag: "Reassign",
        sketchId: step.who % 3 === 0 ? OTHER_SKETCH : SKETCH,
        changeId: step.who % 2 === 0 ? CHANGE_A : CHANGE_B,
      };
    case "Pushed":
      return { _tag: "Pushed", ref: "refs/heads/main", sha: CommitSha.make("c".repeat(40)) };
    case "Collect":
      return {
        _tag: "Collect",
        reason: (["landed", "withdrawn", "expired"] as const)[step.who % 3] ?? "landed",
      };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

const workspaceMachine: Machine<
  Workspace,
  WorkspaceCommand,
  WorkspaceEvent,
  { readonly now: Instant; readonly workspaceId: typeof WORKSPACE }
> = {
  decide: decideWorkspace,
  evolve: evolveWorkspace,
};

const wRun = memo((steps: readonly WStep[]) =>
  play(
    workspaceMachine,
    {
      start: T0,
      dt: () => 1,
      facts: (now) => ({ now, workspaceId: WORKSPACE }),
      every: (state, step) => W_KINDS.map((k) => wBuild(k, state, step)),
      choose: (state, step) => {
        const choices = step.mode === "progress" ? W_PROGRESS[state?.state ?? "none"] : W_KINDS;
        return wBuild(choices[step.pick % choices.length] ?? "Fork", state, step);
      },
    },
    steps,
  ),
);

/** The docs' table (state-machines.md § Workspace), typed independently: the state a command leads to, a no-op, or a refusal. */
const wOracle = (
  before: Workspace | undefined,
  command: WorkspaceCommand,
): WKey | "refused" | "noop" => {
  if (before === undefined) return command._tag === "Fork" ? "ready" : "refused";
  switch (command._tag) {
    case "Fork":
      return "refused";
    case "Grant":
      if (before.state === "ready") return "granted";
      return before.state === "granted" && before.holder === command.holder ? "noop" : "refused";
    case "Reassign":
      return before.state === "granted" && before.holder === command.sketchId
        ? "granted"
        : "refused";
    case "Pushed":
      return before.state === "granted" ? "granted" : "refused";
    case "Collect":
      return before.state === "collected" ? "noop" : "collected";
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const wComparable = (w: Workspace | undefined): string =>
  w === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Workspace)(w)));

const drive = <S, C, E, F>(
  machine: Machine<S, C, E, F>,
  facts: (now: Instant) => F,
  script: readonly (readonly [C, number])[],
) => {
  let state: S | undefined;
  let now = T0;
  const results: Result.Result<readonly E[], { readonly _tag: string }>[] = [];
  for (const [command, dt] of script) {
    now = Instant(now + dt);
    const result = machine.decide(state, command, facts(now));
    results.push(result);
    if (Result.isSuccess(result))
      for (const payload of result.success) state = machine.evolve(state, { at: now, payload });
  }
  return { state, results };
};
const wDrive = (script: readonly WorkspaceCommand[]) =>
  drive(
    workspaceMachine,
    (now) => ({ now, workspaceId: WORKSPACE }),
    script.map((c) => [c, 1] as const),
  );

const fork: WorkspaceCommand = { _tag: "Fork", repo: "keel-ws-1", sourceRepo: "keel-trunk" };
const grant = (holder: typeof CHANGE_A | typeof SKETCH): WorkspaceCommand => ({
  _tag: "Grant",
  holder,
  expiresAt: Instant(T0 + TTL),
  baseSha: BASE,
});

describe("the Workspace machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[workspace.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(wPlanArb, (steps) =>
        wRun(steps).every((r) =>
          r.probes.every((p) => {
            const expected = wOracle(r.before, p.command);
            if (expected === "refused") return Result.isFailure(p.result);
            if (expected === "noop")
              return Result.isSuccess(p.result) && p.result.success.length === 0;
            return (
              Result.isSuccess(p.result) && !p.threw && (p.after?.state ?? "none") === expected
            );
          }),
        ),
      ),
    );
    const landed = wDrive([fork, grant(CHANGE_A), { _tag: "Collect", reason: "landed" }]);
    expect(landed.state).toMatchObject({ state: "collected", holder: CHANGE_A, baseSha: BASE });
  });

  it("[workspace.one-terminal] a collected workspace takes no command that changes it", () => {
    let collected = 0;
    fc.assert(
      fc.property(wPlanArb, (steps) =>
        wRun(steps).every((r) => {
          if (r.before?.state !== "collected") return true;
          collected++;
          return r.probes.every((p) => eventsOf(p.result).length === 0);
        }),
      ),
    );
    expect(collected).toBeGreaterThan(0);
    expect(
      failureTag(
        wDrive([fork, { _tag: "Collect", reason: "expired" }, grant(CHANGE_A)]).results[2] ??
          Result.succeed([]),
      ),
    ).toBe("WorkspaceStateRefused");
  });

  it("[workspace.replay] at every step, the events so far, through the wire, replay to the same workspace", () => {
    fc.assert(
      fc.property(wPlanArb, (steps) =>
        wRun(steps).every(
          (r) =>
            wComparable(replayWorkspace(throughTheWire(WorkspaceEvent, r.log))) ===
            wComparable(r.after),
        ),
      ),
    );
    expect(wDrive([fork, grant(SKETCH)]).state?.holder).toBe(SKETCH);
  });

  it("[workspace.decide-evolvable] evolve takes every event decide emits, for every command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(wPlanArb, (steps) =>
        wRun(steps).every((r) => !r.taken.threw && r.probes.every((p) => !p.threw)),
      ),
    );
    expect(() =>
      evolveWorkspace(undefined, {
        at: T0,
        payload: { _tag: "WorkspaceCollected", workspaceId: WORKSPACE, reason: "landed" },
      }),
    ).toThrow(IllegalTransition);
  });

  it("[workspace.granted-once] a workspace is granted once: the same holder again is a no-op, another holder is refused, and promotion reassigns it from the sketch to its change only once", () => {
    let regrants = 0;
    fc.assert(
      fc.property(wPlanArb, (steps) => {
        const played = wRun(steps);
        const log = played.at(-1)?.log ?? [];
        const grants = log.filter((c) => c.payload._tag === "WorkspaceGranted").length;
        const reassigns = log.filter((c) => c.payload._tag === "WorkspaceReassigned");
        const probesOk = played.every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "Grant" || r.before?.state !== "granted") return true;
            regrants++;
            return r.before.holder === p.command.holder
              ? Result.isSuccess(p.result) && p.result.success.length === 0
              : failureTag(p.result) === "WorkspaceStateRefused";
          }),
        );
        return (
          probesOk &&
          grants <= 1 &&
          reassigns.length <= 1 &&
          reassigns.every(
            (c) => c.payload._tag === "WorkspaceReassigned" && c.payload.sketchId === SKETCH,
          )
        );
      }),
    );
    expect(regrants).toBeGreaterThan(0);
    const promoted = wDrive([
      fork,
      grant(SKETCH),
      { _tag: "Reassign", sketchId: SKETCH, changeId: CHANGE_A },
      { _tag: "Reassign", sketchId: SKETCH, changeId: CHANGE_B },
    ]);
    expect(promoted.state?.holder).toBe(CHANGE_A);
    expect(failureTag(promoted.results[3] ?? Result.succeed([]))).toBe("WorkspaceStateRefused");
    expect(
      eventsOf(wDrive([fork, grant(CHANGE_A), grant(CHANGE_A)]).results[2] ?? Result.succeed([])),
    ).toEqual([]);
  });
});

// Sketch

type SKind = SketchCommand["_tag"];
type SKey = "none" | Sketch["state"];
const S_KINDS: readonly SKind[] = ["Open", "Promote", "Discard", "Expire"];
const S_PROGRESS: Readonly<Record<SKey, readonly SKind[]>> = {
  none: ["Open"],
  open: ["Promote", "Discard", "Expire", "Expire"],
  promoted: S_KINDS,
  expired: S_KINDS,
  discarded: S_KINDS,
};

interface SStep {
  readonly mode: "progress" | "any";
  readonly pick: number;
  readonly dt: number;
}
const sStepArb: fc.Arbitrary<SStep> = fc.record({
  mode,
  pick: fc.nat(),
  // Mostly well inside the TTL, now and then right at or past it.
  dt: fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 0, max: TTL / 4 }) },
    { weight: 1, arbitrary: fc.integer({ min: TTL - 2, max: TTL + 2 }) },
  ),
});
const sPlanArb = fc.array(sStepArb, { minLength: 2, maxLength: 10 });

const sBuild = (kind: SKind, now: Instant): SketchCommand => {
  switch (kind) {
    case "Open":
      return {
        _tag: "Open",
        agentId: AGENT,
        workspaceId: WORKSPACE,
        expiresAt: Instant(now + TTL),
      };
    case "Promote":
      return { _tag: "Promote", changeId: CHANGE_A };
    case "Discard":
      return { _tag: "Discard", by: AGENT };
    case "Expire":
      return { _tag: "Expire" };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

const sketchMachine: Machine<
  Sketch,
  SketchCommand,
  SketchEvent,
  { readonly now: Instant; readonly sketchId: typeof SKETCH }
> = {
  decide: decideSketch,
  evolve: evolveSketch,
};

const sRun = memo(
  (steps: readonly SStep[]): readonly Played<Sketch, SketchCommand, SketchEvent>[] => {
    let clock = T0;
    return play(
      sketchMachine,
      {
        start: T0,
        dt: (step) => {
          clock = Instant(clock + step.dt);
          return step.dt;
        },
        facts: (now) => ({ now, sketchId: SKETCH }),
        every: () => S_KINDS.map((k) => sBuild(k, clock)),
        choose: (state, step) => {
          const choices = step.mode === "progress" ? S_PROGRESS[state?.state ?? "none"] : S_KINDS;
          return sBuild(choices[step.pick % choices.length] ?? "Open", clock);
        },
      },
      steps,
    );
  },
);

const sOracle = (
  before: Sketch | undefined,
  command: SketchCommand,
  now: number,
): SKey | "refused" | "noop" => {
  if (before === undefined) return command._tag === "Open" ? "open" : "refused";
  const live = before.state === "open" && now < before.expiresAt;
  switch (command._tag) {
    case "Open":
      return "refused";
    case "Promote":
      return live ? "promoted" : "refused";
    case "Discard":
      return live ? "discarded" : "refused";
    case "Expire":
      return before.state === "open" && now >= before.expiresAt ? "expired" : "noop";
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const sComparable = (s: Sketch | undefined): string =>
  s === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Sketch)(s)));
const sDrive = (script: readonly (readonly [SketchCommand, number])[]) =>
  drive(sketchMachine, (now) => ({ now, sketchId: SKETCH }), script);
const open: SketchCommand = {
  _tag: "Open",
  agentId: AGENT,
  workspaceId: WORKSPACE,
  expiresAt: Instant(T0 + TTL),
};

describe("the Sketch machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[sketch.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(sPlanArb, (steps) =>
        sRun(steps).every((r) =>
          r.probes.every((p) => {
            const expected = sOracle(r.before, p.command, r.now);
            if (expected === "refused") return Result.isFailure(p.result);
            if (expected === "noop")
              return Result.isSuccess(p.result) && p.result.success.length === 0;
            return (
              Result.isSuccess(p.result) && !p.threw && (p.after?.state ?? "none") === expected
            );
          }),
        ),
      ),
    );
    expect(
      sDrive([
        [open, 0],
        [{ _tag: "Promote", changeId: CHANGE_A }, 10],
      ]).state,
    ).toMatchObject({ state: "promoted", changeId: CHANGE_A });
  });

  it("[sketch.one-terminal] a promoted, expired or discarded sketch takes no command that changes it", () => {
    let ended = 0;
    fc.assert(
      fc.property(sPlanArb, (steps) =>
        sRun(steps).every((r) => {
          if (r.before === undefined || r.before.state === "open") return true;
          ended++;
          return r.probes.every((p) => eventsOf(p.result).length === 0);
        }),
      ),
    );
    expect(ended).toBeGreaterThan(0);
    expect(
      failureTag(
        sDrive([
          [open, 0],
          [{ _tag: "Discard", by: AGENT }, 1],
          [{ _tag: "Promote", changeId: CHANGE_A }, 1],
        ]).results[2] ?? Result.succeed([]),
      ),
    ).toBe("SketchStateRefused");
  });

  it("[sketch.replay] at every step, the events so far, through the wire, replay to the same sketch", () => {
    fc.assert(
      fc.property(sPlanArb, (steps) =>
        sRun(steps).every(
          (r) =>
            sComparable(replaySketch(throughTheWire(SketchEvent, r.log))) === sComparable(r.after),
        ),
      ),
    );
    expect(sDrive([[open, 0]]).state?.state).toBe("open");
  });

  it("[sketch.decide-evolvable] evolve takes every event decide emits, for every command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(sPlanArb, (steps) =>
        sRun(steps).every((r) => !r.taken.threw && r.probes.every((p) => !p.threw)),
      ),
    );
    expect(() =>
      evolveSketch(undefined, { at: T0, payload: { _tag: "SketchExpired", sketchId: SKETCH } }),
    ).toThrow(IllegalTransition);
  });

  it("[sketch.ttl-on-read] past its deadline a sketch can no longer be promoted or discarded, alarm or no alarm, and an early alarm commits nothing", () => {
    let late = 0;
    fc.assert(
      fc.property(sPlanArb, (steps) =>
        sRun(steps).every((r) =>
          r.probes.every((p) => {
            if (r.before?.state !== "open") return true;
            const due = r.now >= r.before.expiresAt;
            if (p.command._tag === "Expire")
              return due
                ? eventsOf(p.result).length === 1
                : Result.isSuccess(p.result) && p.result.success.length === 0;
            if (p.command._tag === "Open" || !due) return true;
            late++;
            return (
              Result.isFailure(p.result) &&
              p.result.failure._tag === "SketchStateRefused" &&
              "reason" in p.result.failure &&
              p.result.failure.reason === "expired"
            );
          }),
        ),
      ),
    );
    expect(late).toBeGreaterThan(0);
    // Exactly at the deadline, before any alarm: too late to promote.
    const atDeadline = sDrive([
      [open, 0],
      [{ _tag: "Promote", changeId: CHANGE_A }, TTL],
    ]);
    expect(failureTag(atDeadline.results[1] ?? Result.succeed([]))).toBe("SketchStateRefused");
    expect(atDeadline.state?.state).toBe("open");
    expect(
      eventsOf(
        sDrive([
          [open, 0],
          [{ _tag: "Expire" }, TTL - 1],
        ]).results[1] ?? Result.succeed([]),
      ),
    ).toEqual([]);
  });
});

// The charts check the machines; they never drive them.

/** Every event a step committed or tried, folded one at a time. */
const foldsIn = <S, C, E, F>(machine: Machine<S, C, E, F>, r: Played<S, C, E>) =>
  foldsOf(machine, r.before, [r.taken.result, ...r.probes.map((p) => p.result)], r.now);

const workspaceView: View<Workspace, WorkspaceEvent> = {
  from: (f) => f.before?.state ?? "none",
  to: (f) => f.after.state,
};
const sketchView: View<Sketch, SketchEvent> = {
  from: (f) => f.before?.state ?? "none",
  to: (f) => f.after.state,
};

/** The Workspace machine walked breadth-first: every command kind, for every holder. */
let workspaceWalk: readonly Fold<Workspace, WorkspaceEvent>[] | undefined;
const workspaceTour = (): readonly Fold<Workspace, WorkspaceEvent>[] => {
  workspaceWalk ??= tour(workspaceMachine, {
    start: T0,
    facts: (now) => ({ now, workspaceId: WORKSPACE }),
    moves: (state) =>
      W_KINDS.flatMap((kind) =>
        [0, 1, 2, 3, 4, 5].map((who) => ({
          command: wBuild(kind, state, { mode: "progress", pick: 0, who }),
          dt: 1,
        })),
      ),
    signature: (w) => `${w?.state ?? "none"}|${w?.holder ?? ""}`,
  });
  return workspaceWalk;
};

/** The Sketch machine walked breadth-first: every command kind, a moment later and past the TTL. */
let sketchWalk: readonly Fold<Sketch, SketchEvent>[] | undefined;
const sketchTour = (): readonly Fold<Sketch, SketchEvent>[] => {
  sketchWalk ??= tour(sketchMachine, {
    start: T0,
    facts: (now) => ({ now, sketchId: SKETCH }),
    // Only Open reads the clock, and only from nothing, at T0 + dt.
    moves: () =>
      S_KINDS.flatMap((kind) =>
        [1, TTL + 1].map((dt) => ({ command: sBuild(kind, Instant(T0 + dt)), dt })),
      ),
    signature: (sk) => sk?.state ?? "none",
  });
  return sketchWalk;
};

describe("the Workspace and Sketch charts", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[workspace.chart] every state change a run makes is an edge of the Workspace chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(wPlanArb, (steps) =>
        wRun(steps).every(
          (r) => offChart(workspaceChart, foldsIn(workspaceMachine, r), workspaceView).length === 0,
        ),
      ),
    );
    const walked = workspaceTour();
    expect(offChart(workspaceChart, walked, workspaceView)).toEqual([]);
    expect(uncovered(workspaceChart, walked, workspaceView)).toEqual([]);
  });

  it("[sketch.chart] every state change a run makes is an edge of the Sketch chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(sPlanArb, (steps) =>
        sRun(steps).every(
          (r) => offChart(sketchChart, foldsIn(sketchMachine, r), sketchView).length === 0,
        ),
      ),
    );
    const walked = sketchTour();
    expect(offChart(sketchChart, walked, sketchView)).toEqual([]);
    expect(uncovered(sketchChart, walked, sketchView)).toEqual([]);
  });
});
