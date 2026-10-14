import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Change,
  type ChangeCommand,
  ChangeEvent,
  decideChange,
  evolveChange,
  LEASE_TTL_MS,
  type Preflight,
  replayChange,
} from "../../../src/domain/coordination/index.ts";
import { Instant, makeId, RunRef } from "../../../src/domain/kernel/index.ts";

const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
const CHANGE = makeId("chg", ulid(1));
const AGENT = makeId("agt", ulid(1));
const run = Schema.decodeUnknownSync(RunRef);
const RUN_B = run({ id: makeId("run", ulid(1)), label: "run-b" });
const RUN_C = run({ id: makeId("run", ulid(2)), label: "run-c" });
const UNLABELLED = run({ id: makeId("run", ulid(3)) });

const preflight: Preflight = {
  neighbours: [],
  contradictions: [],
  precedents: [],
  suggestedMove: "proceed",
};

const declaring = (by: RunRef | undefined): ChangeCommand => ({
  _tag: "Declare",
  changeId: CHANGE,
  agentId: AGENT,
  ...(by === undefined ? {} : { run: by }),
  origin: "agent",
  goal: "cache the session",
  footprint: [],
  premises: [],
  leaseId: makeId("lse", ulid(1)),
  preflight,
});

const adopting = (by: RunRef | undefined, n: number): ChangeCommand => ({
  _tag: "Adopt",
  agentId: AGENT,
  ...(by === undefined ? {} : { run: by }),
  leaseId: makeId("lse", ulid(n)),
  briefRef: "brief",
});

/** Decides each command in turn, each a lease's lifetime after the last, and folds what it commits. */
function play(commands: readonly ChangeCommand[]) {
  let state: Change | undefined;
  const log: ChangeEvent[] = [];
  const committed: { readonly at: Instant; readonly payload: ChangeEvent }[] = [];
  commands.forEach((command, i) => {
    const at = Instant(T0 + i * (LEASE_TTL_MS + 1));
    const decided = decideChange(state, command, { now: at, changeId: CHANGE });
    if (Result.isFailure(decided)) throw new Error(`refused: ${decided.failure._tag}`);
    for (const payload of decided.success) {
      state = evolveChange(state, { at, payload });
      log.push(payload);
      committed.push({ at, payload });
    }
  });
  return { state, log, committed };
}

const named = (log: readonly ChangeEvent[], tag: ChangeEvent["_tag"]) =>
  log.filter((event) => event._tag === tag);

describe("the run that holds a change", () => {
  it("[run.change] a declared change says which run declared it, on its event and in its state, and one declared by no run says none", () => {
    const { state, log } = play([declaring(RUN_C)]);
    expect(named(log, "IntentDeclared")).toMatchObject([{ agentId: AGENT, run: RUN_C }]);
    expect(state).toMatchObject({ agentId: AGENT, run: RUN_C });
    const unlabelled = play([declaring(UNLABELLED)]);
    expect(unlabelled.state?.run).toEqual(UNLABELLED);
    const none = play([declaring(undefined)]);
    expect(named(none.log, "IntentDeclared").map((event) => "run" in event)).toEqual([false]);
    expect(none.state !== undefined && "run" in none.state).toBe(false);
  });

  it("[run.change] an adopted change is held by the adopter's run: another run's, or none when the adopter names none, never the run that held it before", () => {
    const moved = play([declaring(RUN_C), adopting(RUN_B, 2)]);
    expect(named(moved.log, "ChangeAdopted")).toMatchObject([{ agentId: AGENT, run: RUN_B }]);
    expect(moved.state?.run).toEqual(RUN_B);
    const dropped = play([declaring(RUN_C), adopting(undefined, 2)]);
    expect(named(dropped.log, "ChangeAdopted").map((event) => "run" in event)).toEqual([false]);
    expect(dropped.state !== undefined && "run" in dropped.state).toBe(false);
    const taken = play([declaring(undefined), adopting(RUN_B, 2), adopting(RUN_C, 3)]);
    expect(taken.state?.run).toEqual(RUN_C);
  });

  it("[run.change] the run survives the wire: a change replayed from its encoded events is held by the same run", () => {
    const { state, committed } = play([declaring(RUN_C), adopting(RUN_B, 2)]);
    const encode = Schema.encodeSync(ChangeEvent);
    const decode = Schema.decodeUnknownSync(ChangeEvent);
    const replayed = replayChange(
      committed.map(({ at, payload }) => ({
        at,
        payload: decode(JSON.parse(JSON.stringify(encode(payload)))),
      })),
    );
    expect(replayed).toEqual(state);
    expect(replayed?.run).toEqual(RUN_B);
  });
});
