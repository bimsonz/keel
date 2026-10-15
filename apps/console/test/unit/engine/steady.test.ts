import { describe, expect, it } from "vitest";
import { inOrg } from "../../../src/account/accounts.ts";
import { filtersOfChange, isBounced } from "../../../src/engine/lists.ts";
import { RepositoryReader, headToRead } from "../../../src/engine/repository.ts";
import { World } from "../../../src/engine/world.ts";
import type { KeelRepository } from "../../../src/source/repository.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createRng } from "../../fixtures/prng.ts";

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("the code while the log is still read", () => {
  it("[repository.head-while-reading] reads at Keel's head until the log is read, never again at each head the log passes, and follows the log's after", async () => {
    const keels = "6824ced0000000000000000000000000000000000";
    const asked: string[] = [];
    const source: KeelRepository = {
      getTree: async (_project, at) => {
        asked.push(`tree ${at.ref ?? "head"}`);
        return { commit: at.ref ?? keels, path: at.path, entries: [] };
      },
      getBlob: () => Promise.reject(new Error("no file here")),
      getCommits: async (_project, request) => {
        asked.push(`commits ${request.ref ?? "head"}`);
        return { items: [] };
      },
      getCommit: () => Promise.reject(new Error("no commit here")),
    };
    const reader = new RepositoryReader(
      source,
      () => undefined,
      () => ({ id: "prj_1", name: "swarm" }),
    );
    const world = new World();
    const address = { view: "code", path: "" } as const;
    // The log is read a page at a time, and the head it has folded to moves on with each, to Keel's at its end.
    for (const head of ["84c3960", "14cc13a", "06782dc", keels]) {
      world.trunk.head = head;
      reader.want(address, headToRead({ loaded: false, world }));
      // oxlint-disable-next-line no-await-in-loop -- each page of the log is folded before the next arrives
      await settled();
    }
    reader.want(address, headToRead({ loaded: true, world }));
    await settled();
    expect(asked).toEqual(["commits head", "tree head"]);
    // Once the log is read, a head it moves on to is read.
    world.trunk.head = "9f0c1d2";
    reader.want(address, headToRead({ loaded: true, world }));
    await settled();
    expect(asked.slice(2)).toEqual(["commits 9f0c1d2", "tree 9f0c1d2"]);
  });
});

/** A change declared, submitted and bounced, then whatever `after` does to it. */
function bounced(after: (b: ScriptBuilder, changeId: string) => void): World {
  const b = new ScriptBuilder("2026-10-15T05:00:00.000Z", createRng(7));
  const changeId = "chg_000000000000000000000BOUNCE";
  b.at(1).emit({
    type: "IntentDeclared",
    entity: { kind: "change", id: changeId },
    label: "#24",
    payload: {
      changeId,
      agentId: "agt_1",
      origin: "agent",
      revision: 1,
      goal: "Test checkColor",
      footprint: [],
      premises: [],
      leaseId: "lse_1",
    },
  });
  b.at(2).emit({
    type: "ChangeSubmitted",
    entity: { kind: "change", id: changeId },
    payload: { changeId, revision: 1, commitSha: "a".repeat(40), workspaceId: "ws_1" },
  });
  b.at(3).emit({
    type: "ChangeBounced",
    entity: { kind: "change", id: changeId },
    payload: { changeId, verdictId: "vrd_1", reasons: ["keel.test: fail"] },
  });
  after(b, changeId);
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

const lapse = (b: ScriptBuilder, changeId: string, at: number): void => {
  b.at(at).emit({
    type: "ChangeParked",
    entity: { kind: "change", id: changeId },
    payload: { changeId, reason: "lease-lapsed" },
  });
};

describe("what bounced means", () => {
  it("[lists.bounced-lapsed] counts a change as bounced from its bounce until it moves on, its agent gone or not, as the pipeline does", () => {
    // Bounced, then its agent's lease lapsed: Keel parks it, and it is a bounced change still.
    const left = bounced((b, id) => lapse(b, id, 4));
    const [lapsed] = left.changes.values();
    expect(lapsed?.state).toBe("parked");
    expect(filtersOfChange(lapsed!)).toEqual(["open", "bounced"]);
    expect(isBounced(lapsed!)).toBe(true);
    expect(left.flow.changes.get(lapsed!.id)?.stage).toBe("bounced");

    // Adopted after that, and lapsed again: it moved on, and is open and nothing narrower.
    const adopted = bounced((b, id) => {
      lapse(b, id, 4);
      b.at(5).emit({
        type: "ChangeAdopted",
        entity: { kind: "change", id },
        payload: {
          changeId: id,
          previousAgentId: "agt_1",
          agentId: "agt_2",
          leaseId: "lse_2",
          briefRef: "brief",
        },
      });
      lapse(b, id, 6);
    });
    const [moved] = adopted.changes.values();
    expect(filtersOfChange(moved!)).toEqual(["open"]);
    expect(isBounced(moved!)).toBe(false);
    expect(adopted.flow.changes.get(moved!.id)?.stage).not.toBe("bounced");
  });
});

describe("trunk before anything lands", () => {
  it("[flow.trunk-start] has its first commit at height none, so a new project's trunk is named, not a dash", () => {
    const b = new ScriptBuilder("2026-10-15T05:00:00.000Z", createRng(3));
    b.at(1).emit({
      type: "TrunkInitialized",
      entity: { kind: "project", id: "prj_1" },
      payload: { projectId: "prj_1", head: "691f12c".padEnd(40, "0"), by: "usr_1" },
    });
    const world = new World();
    const log = b.build();
    log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
    expect(world.flow.commits.map((commit) => [commit.height, commit.sha.slice(0, 7)])).toEqual([
      [0, "691f12c"],
    ]);
  });
});

describe("a handle as an org", () => {
  it("[accounts.in-org] reads a handle as an org only where Keel lists the reader in it, and waits for that list", () => {
    const ada = { handle: "ada" };
    const orgs = [{ handle: "rv-walk-a-org" }];
    expect(inOrg("rv-walk-a-org", ada, orgs)).toBe(true);
    expect(inOrg("RV-Walk-A-Org", ada, orgs)).toBe(true);
    // A person's handle, an agent's and an org the reader is not in are not read as an org.
    expect(inOrg("ada", ada, orgs)).toBe(false);
    expect(inOrg("agent-0ge70tbptnxctb6y", ada, orgs)).toBe(false);
    expect(inOrg("nope", ada, orgs)).toBe(false);
    // Until Keel has listed the reader's orgs, it is not known; a person with no handle yet is in none.
    expect(inOrg("rv-walk-a-org", ada, null)).toBeUndefined();
    expect(inOrg("rv-walk-a-org", {}, null)).toBe(false);
  });
});
