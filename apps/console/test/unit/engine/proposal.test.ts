import { describe, expect, it } from "vitest";
import { changePageOf } from "../../../src/engine/select.ts";
import { World } from "../../../src/engine/world.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createRng } from "../../fixtures/prng.ts";

const NO_RESOURCES = {
  probes: new Map(),
  diffs: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set<string>(),
};

const PROPOSAL = "chg_000000000000000000PR0P0SAL";
const FORK = "prj_01J9FFFFFFFFFFFFFFFFFFFFFF";
const FIRST = "a".repeat(40);
const SECOND = "b".repeat(40);
const ANN = "user:usr_01J9PPPPPPPPPPPPPPPPPPPPPP";
const MAY = "user:usr_01J9MMMMMMMMMMMMMMMMMMMMMM";
const FIRST_PATHS = [{ path: "src/push.ts", op: "edit" as const }];
const MOVED_PATHS = [
  { path: "src/push.ts", op: "edit" as const },
  { path: "test/push.test.ts", op: "create" as const },
];

/** A proposal's log as its Change object commits it, up to `upTo` steps: proposed, compiled and parked, asked for changes, moved, approved. */
function proposed(upTo: number): World {
  const b = new ScriptBuilder("2026-10-22T04:00:00.000Z", createRng(7));
  const entity = { kind: "change" as const, id: PROPOSAL };
  const steps = [
    () => {
      b.at(1).emit({
        type: "IntentDeclared",
        entity,
        payload: {
          changeId: PROPOSAL,
          origin: "proposal",
          revision: 1,
          goal: "Retry a refused push",
          footprint: FIRST_PATHS,
          premises: [],
        },
      });
      b.at(1).emit({
        type: "ChangeProposed",
        entity,
        payload: { changeId: PROPOSAL, fork: FORK, commit: FIRST, proposer: ANN },
      });
    },
    () => {
      b.at(2).emit({
        type: "PlanCompiled",
        entity,
        payload: {
          changeId: PROPOSAL,
          revision: 1,
          planHash: `sha256:${"0".repeat(64)}`,
          steps: 2,
          costEstimate: 0,
          ruledPaths: [".keel/flow.json"],
        },
      });
      b.at(2).emit({ type: "ChangeQueued", entity, payload: { changeId: PROPOSAL, laneId: "l" } });
      b.at(2).emit({
        type: "ChangeParked",
        entity,
        payload: { changeId: PROPOSAL, reason: "awaiting-approval" },
      });
    },
    () =>
      b.at(3).emit({
        type: "ProposalChangesRequested",
        entity,
        payload: { changeId: PROPOSAL, commit: FIRST, by: MAY, comment: "Add a test" },
      }),
    () =>
      b.at(4).emit({
        type: "ProposalUpdated",
        entity,
        payload: { changeId: PROPOSAL, commit: SECOND, footprint: MOVED_PATHS },
      }),
    () =>
      b.at(5).emit({
        type: "ProposalApproved",
        entity,
        payload: { changeId: PROPOSAL, commit: SECOND, by: MAY },
      }),
  ];
  for (const step of steps.slice(0, upTo)) step();
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

describe("a proposal in the console's world", () => {
  it("[world.proposal] a proposal is no agent's: it names its fork, commit and proposer, and parks for approval with the paths to rule on", () => {
    const change = proposed(2).changes.get(PROPOSAL);
    expect(change?.agentId).toBeUndefined();
    expect(change).toMatchObject({
      state: "parked",
      parkedOn: "awaiting-approval",
      proposal: { fork: FORK, commit: FIRST, proposer: ANN },
      ruledPaths: [".keel/flow.json"],
    });
    expect(changePageOf(proposed(2), PROPOSAL, NO_RESOURCES)?.proposal).toMatchObject({
      commit: FIRST,
      proposerName: "usr_01J9PPPPPPPPPPPPPPPPPPPPPP",
      ruledPaths: [".keel/flow.json"],
    });
  });

  it("[world.proposal-moves] a request for changes is kept, another commit clears any approval and waits again, and an approval takes it back to the queue at its commit", () => {
    expect(proposed(3).changes.get(PROPOSAL)?.proposal?.requested).toMatchObject({
      by: MAY,
      comment: "Add a test",
      commit: FIRST,
    });
    const moved = proposed(4).changes.get(PROPOSAL);
    expect(moved).toMatchObject({ state: "working", proposal: { commit: SECOND } });
    expect(moved?.parkedOn).toBeUndefined();
    const approved = proposed(5).changes.get(PROPOSAL);
    expect(approved?.proposal?.approved).toBe(SECOND);
  });

  it("[world.proposal-moved-footprint] a proposal moved to another commit shows that commit's footprint, on its page too", () => {
    expect(proposed(3).changes.get(PROPOSAL)?.footprint).toEqual(FIRST_PATHS);
    expect(proposed(4).changes.get(PROPOSAL)?.footprint).toEqual(MOVED_PATHS);
    expect(changePageOf(proposed(4), PROPOSAL, NO_RESOURCES)?.intent.footprint).toEqual(
      MOVED_PATHS,
    );
  });
});
