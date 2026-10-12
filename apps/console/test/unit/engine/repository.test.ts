import { describe, expect, it, vi } from "vitest";
import { createHttpSource } from "../../../src/source/http.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import type { Player } from "../../../src/engine/player.ts";
import {
  type BrowserEntry,
  type RepoAddress,
  type RepositoryState,
  repositoryOf,
} from "../../../src/engine/repository.ts";
import { World } from "../../../src/engine/world.ts";
import { showing } from "../showing.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const HEAD_0 = "4b1d9e0c7a2f5381966be0d4c3a7f1e2b8d05a46";
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

async function playerAt(
  scenario: "s1" | "swarm",
  seconds: number,
  ruling?: string,
): Promise<Player> {
  const player = showing(
    createMockSource({
      scenario,
      seed: 42,
      ...(scenario === "swarm" ? { agents: 12, seconds: 40 } : {}),
      ...(ruling === undefined ? {} : { ruling }),
    }),
  );
  await player.load();
  player.seek(seconds * 1000);
  return player;
}

/** What the view shows at an address, once everything it asks Keel for has been answered. */
async function shown(player: Player, address: RepoAddress): Promise<RepositoryState> {
  // As the page does: ask, and ask again each time something arrives, until nothing more is wanted.
  for (let round = 0; round < 4; round += 1) {
    player.repository.want(address, player.world.trunk.head);
    // oxlint-disable-next-line no-await-in-loop -- each round waits for what the last one asked for
    await settled();
  }
  return repositoryOf(player.world, player.repository, address);
}

/** Something to wait on, and the way to let it go. */
function gate(): { held: Promise<void>; release: () => void } {
  const out = { held: Promise.resolve(), release: (): void => undefined };
  out.held = new Promise<void>((resolve) => {
    out.release = resolve;
  });
  return out;
}

/** A Keel with an empty log, and nothing else. */
const emptyLog = (): Promise<Response> =>
  Promise.resolve(Response.json({ items: [], nextCursor: "0" }));

/** The list of files beside the code, a line to an entry: indented by depth, a directory with whether it is open, and the entry being read marked. */
const drawn = (browser: BrowserEntry[] | undefined): string[] =>
  (browser ?? []).map(
    (entry) =>
      `${"  ".repeat(entry.depth)}${entry.kind === "tree" ? (entry.open === true ? "v " : "> ") : ""}${entry.name}${entry.current ? " <" : ""}`,
  );

const ready = (state: RepositoryState): Extract<RepositoryState, { status: "ready" }> => {
  if (state.status !== "ready") throw new Error(`the repository is ${state.status}`);
  return state;
};

/** What Keel is asked about a path itself when an address is opened cold, and what the view then shows there. */
const reads = async (address: RepoAddress): Promise<{ asked: string[]; kind: string }> => {
  const source = createMockSource({ scenario: "s1", seed: 42 });
  const asked: string[] = [];
  const counting: typeof source = {
    ...source,
    getTree: (id, at) => (asked.push(`tree ${at.path}`), source.getTree(id, at)),
    getBlob: (id, at) => (asked.push(`blob ${at.path}`), source.getBlob(id, at)),
  };
  const player = showing(counting);
  await player.load();
  player.seek(700_000);
  const state = await shown(player, address);
  // Only the reads of the path itself: the directories on the way to it are read beside it either way.
  return {
    asked: asked.filter((read) => read.endsWith(` ${address.path}`)),
    kind: ready(state).view.kind,
  };
};

describe("the repository view", () => {
  it("opens on the project: its name, where to clone it, trunk's head, and the root with its README beneath", async () => {
    const player = await playerAt("s1", 700);
    const state = ready(await shown(player, { view: "code", path: "" }));
    expect(state.project).toEqual({
      name: "demo",
      visibility: "public",
      cloneUrl: "https://keel.town/demo.git",
    });
    expect(state.ref).toEqual({ sha: player.world.trunk.head, head: true });
    expect(state.crumbs).toEqual([{ name: "demo", path: "" }]);
    // Directories first, then files, each by name.
    expect(
      state.view.kind === "tree" &&
        state.view.entries.map((entry) => `${entry.kind} ${entry.path}`),
    ).toEqual(["tree src", "blob package.json", "blob README.md"]);
    expect(state.view.kind === "tree" && state.view.readme?.content.startsWith("# demo")).toBe(
      true,
    );
  });

  it("shows a file with the reasons beside its lines, and the way back up", async () => {
    const player = await playerAt("s1", 700);
    const state = ready(await shown(player, { view: "code", path: "src/authz/cache.ts" }));
    expect(state.crumbs.map((crumb) => [crumb.name, crumb.path])).toEqual([
      ["demo", ""],
      ["src", "src"],
      ["authz", "src/authz"],
      ["cache.ts", "src/authz/cache.ts"],
    ]);
    const { view } = state;
    expect(view).toMatchObject({
      kind: "file",
      path: "src/authz/cache.ts",
      lines: 30,
      binary: false,
      truncated: false,
    });
    expect(
      view.kind === "file" &&
        view.notes.map(
          (note) => `${note.from} ${note.kind} ${note.label ?? note.holder?.label ?? ""}`,
        ),
    ).toEqual(["5 decision D-1", "5 guard G-1", "5 tenet T-1", "5 premise #1", "5 premise #2"]);
  });

  it("reads at trunk's head as the log has it: before anything lands there is no cache to show", async () => {
    const player = await playerAt("s1", 400);
    expect(player.world.trunk.head).toBe(HEAD_0);
    const authz = ready(await shown(player, { view: "code", path: "src/authz" }));
    expect(authz.ref).toEqual({ sha: HEAD_0, head: true });
    expect(authz.view.kind === "tree" && authz.view.entries.map((entry) => entry.name)).toEqual([
      "actions.ts",
      "check.ts",
      "roles.ts",
    ]);
    const cache = ready(await shown(player, { view: "code", path: "src/authz/cache.ts" }));
    expect(cache.view).toEqual({ kind: "absent", what: "src/authz/cache.ts" });
  });

  it("reads at a commit when one is named, and says it is not the head", async () => {
    const player = await playerAt("s1", 700);
    const state = ready(
      await shown(player, { view: "code", path: "src/collaborators", ref: HEAD_0 }),
    );
    expect(state.ref).toEqual({ sha: HEAD_0, head: false });
    expect(state.view.kind === "tree" && state.view.entries.map((entry) => entry.name)).toEqual([
      "routes.ts",
    ]);
  });

  it("[repository.history] tells history newest first, each commit with the change it landed and trunk's height then, and opens a commit on its diff", async () => {
    const player = await playerAt("s1", 700);
    const history = ready(await shown(player, { view: "history", path: "" }));
    const commits = history.view.kind === "history" ? history.view.commits : [];
    expect(
      commits.map((commit) => [
        commit.height,
        commit.message,
        commit.changes.map((change) => `${change.label}${change.known ? "" : "?"}`),
        commit.unverified,
      ]),
    ).toEqual([
      [2, "Speed up permission checks", ["#1"], false],
      [1, "Owners can revoke collaborators, effective immediately", ["#2"], false],
      [0, "Start of trunk", [], false],
    ]);
    const opened = ready(
      await shown(player, { view: "history", path: "", commit: commits[0]?.sha ?? "" }),
    );
    expect(opened.view).toMatchObject({
      kind: "commit",
      commit: { message: "Speed up permission checks", height: 2 },
    });
    expect(opened.view.kind === "commit" && opened.view.files.map((file) => file.path)).toEqual([
      "src/authz/cache.ts",
      "src/authz/check.ts",
      "src/collaborators/revoke.ts",
    ]);
    expect(
      opened.view.kind === "commit" && [opened.view.additions > 0, opened.view.deletions > 0],
    ).toEqual([true, true]);
    const nowhere = ready(await shown(player, { view: "history", path: "", commit: "0000000000" }));
    expect(nowhere.view).toEqual({ kind: "absent", what: "commit 0000000" });
  });

  it("offers a commit's change as a way to its page only when this console's log has that change", async () => {
    const player = await playerAt("s1", 700);
    const address: RepoAddress = { view: "history", path: "" };
    await shown(player, address);
    // A console that began reading after the changes were declared: it has trunk's head, and neither change.
    const late = new World();
    for (const event of (await player.source.readEvents({ limit: 500 })).items) {
      if (event.type === "TrunkInitialized" || event.type === "TrunkAdvanced") late.apply(event, 0);
    }
    const told = (world: World): string[][] => {
      const { view } = ready(repositoryOf(world, player.repository, address));
      return view.kind === "history"
        ? view.commits.map((commit) =>
            commit.changes.map(
              // A change this console's log does not have has no number here: Keel's history names it by id.
              (change) => (change.known ? `${change.label} known` : "not in this log"),
            ),
          )
        : [];
    };
    expect(told(player.world)).toEqual([["#1 known"], ["#2 known"], []]);
    expect(told(late)).toEqual([["not in this log"], ["not in this log"], []]);
  });

  it("says where trunk is on the code's own page: its latest commit, what that landed, and how many there are", async () => {
    const player = await playerAt("s1", 700);
    const state = ready(await shown(player, { view: "code", path: "" }));
    expect(state.latest).toMatchObject({
      sha: player.world.trunk.head,
      message: "Speed up permission checks",
      changes: [{ label: "#1", known: true }],
    });
    expect(state.commits).toEqual({ count: 3, more: false });
    expect(state.green).toBe(true);
    // At an older commit, the latest is that commit, and what came after is not counted.
    const first = ready(await shown(player, { view: "code", path: "", ref: HEAD_0 }));
    expect(first.latest).toMatchObject({ sha: HEAD_0, message: "Start of trunk", changes: [] });
    expect(first.commits).toEqual({ count: 1, more: false });
  });

  it("lists the files beside a file: every directory on the way to it open, the rest closed, and the file marked", async () => {
    const player = await playerAt("s1", 700);
    const state = ready(await shown(player, { view: "code", path: "src/authz/cache.ts" }));
    expect(drawn(state.browser)).toEqual([
      "v src",
      "  v authz",
      "    actions.ts",
      "    cache.ts <",
      "    check.ts",
      "    roles.ts",
      "  > collaborators",
      "  http.ts",
      "package.json",
      "README.md",
    ]);
    // A directory below the root has the same list beside it, with itself marked and open.
    const directory = ready(await shown(player, { view: "code", path: "src/authz" }));
    expect(drawn(directory.browser).slice(0, 3)).toEqual([
      "v src",
      "  v authz <",
      "    actions.ts",
    ]);
    // The root is the whole list already, so nothing stands beside it.
    expect(ready(await shown(player, { view: "code", path: "" })).browser).toBeUndefined();
    // As the files stood at an older commit, the list is that commit's: the cache had not landed.
    const before = ready(
      await shown(player, { view: "code", path: "src/authz/check.ts", ref: HEAD_0 }),
    );
    expect(drawn(before.browser).slice(1, 5)).toEqual([
      "  v authz",
      "    actions.ts",
      "    check.ts <",
      "    roles.ts",
    ]);
  });

  it("opens a directory beside the file when a reader asks, and closes one on the way to it", async () => {
    const player = await playerAt("s1", 700);
    const address: RepoAddress = { view: "code", path: "src/authz/cache.ts" };
    const browsing = { opened: new Set(["src/collaborators"]), closed: new Set(["src/authz"]) };
    // Opened, and Keel not yet asked what is in it: it is open at once, and says it is being read.
    await shown(player, address);
    const opened = ready(
      repositoryOf(player.world, player.repository, address, browsing),
    ).browser?.find((entry) => entry.path === "src/collaborators");
    expect(opened).toMatchObject({ open: true, reading: true });
    for (let round = 0; round < 4; round += 1) {
      player.repository.want(address, player.world.trunk.head, browsing.opened);
      // oxlint-disable-next-line no-await-in-loop -- each round waits for what the last one asked for
      await settled();
    }
    const state = ready(repositoryOf(player.world, player.repository, address, browsing));
    expect(drawn(state.browser).slice(0, 4)).toEqual([
      "v src",
      "  > authz",
      "  v collaborators",
      "    revoke.ts",
    ]);
    // What is in a closed directory is not listed, though the file being read is in it.
    expect(drawn(state.browser).some((line) => line.includes("cache.ts"))).toBe(false);
  });

  it("never has a file to draw before the notes that belong beside its lines", async () => {
    const source = createMockSource({ scenario: "s1", seed: 42 });
    const { held, release } = gate();
    // Keel answers with the file at once, and with its notes only when let go.
    const slow: typeof source = {
      ...source,
      getNotes: async (at) => {
        await held;
        const notes = await source.getNotes?.(at);
        if (notes === undefined) throw new Error("this source has no notes");
        return notes;
      },
    };
    const player = showing(slow);
    await player.load();
    player.seek(700_000);
    const address: RepoAddress = { view: "code", path: "src/authz/cache.ts" };
    player.repository.want(address, player.world.trunk.head);
    await settled();
    // The file has arrived and its notes have not: the page is still waiting, not drawing a file without them.
    expect(ready(repositoryOf(player.world, player.repository, address)).view).toEqual({
      kind: "loading",
    });
    release();
    await settled();
    const { view } = ready(repositoryOf(player.world, player.repository, address));
    expect(view.kind === "file" && view.notes.length).toBe(5);
  });

  it("asks Keel once for each thing, however often the page asks", async () => {
    const source = createMockSource({ scenario: "s1", seed: 42 });
    const asked: string[] = [];
    const counting: typeof source = {
      ...source,
      getTree: (id, at) => (asked.push(`tree ${at.path}`), source.getTree(id, at)),
      getBlob: (id, at) => (asked.push(`blob ${at.path}`), source.getBlob(id, at)),
      getCommits: (id, request) => (asked.push("commits"), source.getCommits(id, request)),
    };
    const player = showing(counting);
    await player.load();
    player.seek(700_000);
    await shown(player, { view: "code", path: "" });
    await shown(player, { view: "code", path: "" });
    await shown(player, { view: "code", path: "src/authz/check.ts" });
    await shown(player, { view: "code", path: "src/authz/check.ts" });
    // A path is tried as a directory first, and only then as a file. The directories on the way to it are read
    // once each, for the list of files beside it; the root was read already, and is not asked for again.
    expect(asked).toEqual([
      "commits",
      "tree ",
      "blob README.md",
      "tree src/authz/check.ts",
      "tree src",
      "tree src/authz",
      "blob src/authz/check.ts",
    ]);
  });

  it("[repository.file-first] asks for what the address says the path is, and for the other kind only when Keel refuses that", async () => {
    // A link to a file: one read, and no refused directory read before it.
    expect(await reads({ view: "code", path: "src/authz/check.ts", kind: "blob" })).toEqual({
      asked: ["blob src/authz/check.ts"],
      kind: "file",
    });
    // A link to a directory: one read.
    expect(await reads({ view: "code", path: "src/authz", kind: "tree" })).toEqual({
      asked: ["tree src/authz"],
      kind: "tree",
    });
    // An address that is wrong about what is there still shows it: Keel refuses, and the other kind is read.
    expect(await reads({ view: "code", path: "src/authz/check.ts", kind: "tree" })).toEqual({
      asked: ["tree src/authz/check.ts", "blob src/authz/check.ts"],
      kind: "file",
    });
    expect(await reads({ view: "code", path: "src/authz", kind: "blob" })).toEqual({
      asked: ["blob src/authz", "tree src/authz"],
      kind: "tree",
    });
  });

  it("[repository.unknown] says what it cannot show: a project it cannot look up, and one there is no code for", async () => {
    // A story with no repository: every read of it fails, and nothing is drawn in its place.
    const swarm = await playerAt("swarm", 30);
    expect(await shown(swarm, { view: "code", path: "" })).toEqual({ status: "refused" });
    // A reader Keel's log has named no project to has only the name in the address, and Keel reads a
    // repository by the project's id: nothing is asked, and the page says which of the two it is.
    const asked: string[] = [];
    const live = showing(
      await createHttpSource({
        fetch: (input) => {
          asked.push(typeof input === "string" ? input : "");
          return emptyLog();
        },
      }),
    );
    await live.load();
    expect(await shown(live, { view: "code", path: "" })).toEqual({ status: "unknown" });
    expect(asked.filter((url) => url.includes("/repo/"))).toEqual([]);
  });
});
