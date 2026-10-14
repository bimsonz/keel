import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decideWorkspace,
  evolveWorkspace,
  replayWorkspace,
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
import { workspaceChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
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
const OTHER_WORKSPACE = makeId("wsp", ulid(2));
const CHANGE_A = makeId("chg", ulid(1));
const CHANGE_B = makeId("chg", ulid(2));
const CHANGE_C = makeId("chg", ulid(3));
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
const W_KINDS: readonly WKind[] = ["Fork", "Grant", "Pushed", "Collect"];
const W_PROGRESS: Readonly<Record<WKey, readonly WKind[]>> = {
  none: ["Fork"],
  ready: ["Grant", "Grant", "Collect"],
  granted: ["Pushed", "Grant", "Collect"],
  collected: W_KINDS,
};

interface WStep {
  readonly mode: "progress" | "any";
  readonly pick: number;
  readonly who: number;
}
const wStepArb: fc.Arbitrary<WStep> = fc.record({ mode, pick: fc.nat(), who: fc.nat({ max: 5 }) });
const wPlanArb = fc.array(wStepArb, { minLength: 2, maxLength: 12 });

const HOLDERS = [CHANGE_A, CHANGE_C, CHANGE_B] as const;

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
const grant = (holder: typeof CHANGE_A): WorkspaceCommand => ({
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
    const [granted] = eventsOf(wDrive([fork, grant(CHANGE_B)]).results[1] ?? Result.succeed([]));
    if (granted === undefined) throw new Error("the grant committed nothing");
    const wire = Schema.encodeSync(WorkspaceEvent)(granted);
    expect(Schema.decodeUnknownSync(WorkspaceEvent)(wire)).toEqual(granted);
    // A grant to anything but a change does not decode.
    for (const holder of [`sk_${ulid(1)}`, OTHER_WORKSPACE, AGENT])
      expect(() => Schema.decodeUnknownSync(WorkspaceEvent)({ ...wire, holder })).toThrow(
        'at ["holder"]',
      );
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

  it("[workspace.granted-once] a workspace is granted once: the same holder again is a no-op and another holder is refused", () => {
    let regrants = 0;
    fc.assert(
      fc.property(wPlanArb, (steps) => {
        const played = wRun(steps);
        const log = played.at(-1)?.log ?? [];
        const grants = log.filter((c) => c.payload._tag === "WorkspaceGranted").length;
        const probesOk = played.every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "Grant" || r.before?.state !== "granted") return true;
            regrants++;
            return r.before.holder === p.command.holder
              ? Result.isSuccess(p.result) && p.result.success.length === 0
              : failureTag(p.result) === "WorkspaceStateRefused";
          }),
        );
        return probesOk && grants <= 1;
      }),
    );
    expect(regrants).toBeGreaterThan(0);
    const contested = wDrive([fork, grant(CHANGE_A), grant(CHANGE_B)]);
    expect(contested.state?.holder).toBe(CHANGE_A);
    expect(failureTag(contested.results[2] ?? Result.succeed([]))).toBe("WorkspaceStateRefused");
    expect(
      eventsOf(wDrive([fork, grant(CHANGE_A), grant(CHANGE_A)]).results[2] ?? Result.succeed([])),
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

/** What the Workspace fold's table is about: whose it is, its state and who holds it. */
interface FoldedWorkspace {
  readonly id: Workspace["id"];
  readonly state: Workspace["state"];
  readonly holder?: Workspace["holder"];
}

/** The fold's from-table (state-machines.md § Workspace), typed apart from `evolveWorkspace`. */
const workspaceFolds = (
  from: FoldedWorkspace | undefined,
  event: WorkspaceEvent,
): FoldedWorkspace | "illegal" => {
  if (from === undefined)
    return event._tag === "WorkspaceForked" ? { id: event.workspaceId, state: "ready" } : "illegal";
  if (event.workspaceId !== from.id) return "illegal";
  switch (event._tag) {
    case "WorkspaceForked":
      return "illegal";
    case "WorkspaceGranted":
      return from.state === "ready"
        ? { ...from, state: "granted", holder: event.holder }
        : "illegal";
    case "WorkspacePushed":
      return from.state === "granted" ? from : "illegal";
    case "WorkspaceCollected":
      return from.state === "ready" || from.state === "granted"
        ? { ...from, state: "collected" }
        : "illegal";
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

describe("the Workspace fold", () => {
  it("[workspace.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = foldCases<Workspace, WorkspaceEvent, FoldedWorkspace>({
      evolve: evolveWorkspace,
      walked: workspaceTour(),
      summary: (w) => ({
        id: w.id,
        state: w.state,
        ...(w.holder === undefined ? {} : { holder: w.holder }),
      }),
      shown: (f) => `${f.id} ${f.state}${f.holder === undefined ? "" : ` held by ${f.holder}`}`,
      // Each event as committed and as another workspace's.
      forms: (event) => [event, { ...event, workspaceId: OTHER_WORKSPACE }],
      times: [T0],
      table: workspaceFolds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Nine rows by sixteen forms: every event the tour committed, for each holder, as this
    // workspace's and as another's.
    expect(foldShape(cases)).toEqual({
      folds: 144,
      refused: 124,
      rows: [
        "none",
        `${WORKSPACE} ready`,
        `${WORKSPACE} granted held by ${CHANGE_A}`,
        `${WORKSPACE} granted held by ${CHANGE_C}`,
        `${WORKSPACE} granted held by ${CHANGE_B}`,
        `${WORKSPACE} collected`,
        `${WORKSPACE} collected held by ${CHANGE_A}`,
        `${WORKSPACE} collected held by ${CHANGE_C}`,
        `${WORKSPACE} collected held by ${CHANGE_B}`,
      ],
    });
  });
});

describe("the Workspace chart", { timeout: PROPERTY_TIMEOUT }, () => {
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
});
