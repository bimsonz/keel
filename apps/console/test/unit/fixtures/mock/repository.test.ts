import { describe, expect, it, vi } from "vitest";
import { createMockRepository } from "../../../fixtures/mock/repository.ts";
import { generateS1 } from "../../../fixtures/mock/s1.ts";
import { generateS2 } from "../../../fixtures/mock/s2.ts";
import { generateSwarm } from "../../../fixtures/mock/swarm.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const HEAD_0 = "4b1d9e0c7a2f5381966be0d4c3a7f1e2b8d05a46";

describe("the repository a fixture's story is about", () => {
  it("tells trunk's history from the log: one commit for each advance, newest first, each with the changes it landed", async () => {
    const log = generateS1(42, "invalidate");
    const repo = createMockRepository(() => log);
    const { items } = await repo.getCommits({});
    expect(
      items.map((commit) => [
        commit.height,
        commit.message,
        commit.changes.map((change) => change.label),
      ]),
    ).toEqual([
      [2, "Speed up permission checks", ["#1"]],
      [1, "Owners can revoke collaborators, effective immediately", ["#2"]],
      [0, "Start of trunk", []],
    ]);
    // Each commit is the head trunk advanced to, and stands on the one before.
    const advances = log.events.filter((event) => event.type === "TrunkAdvanced");
    expect(items.slice(0, 2).map((commit) => commit.sha)).toEqual(
      advances.map((event) => event.payload.to).toReversed(),
    );
    expect(items.map((commit) => commit.parents[0])).toEqual([items[1]?.sha, HEAD_0, undefined]);
    expect((await repo.getProject()).head).toBe(items[0]?.sha);
  });

  it("serves the tree as it stood at each commit", async () => {
    const log = generateS1(42, "invalidate");
    const repo = createMockRepository(() => log);
    const names = async (ref: string | undefined, path: string): Promise<string[]> =>
      (await repo.getTree({ ...(ref === undefined ? {} : { ref }), path })).entries
        .map((entry) => `${entry.name}${entry.kind === "tree" ? "/" : ""}`)
        .toSorted();
    expect(await names(HEAD_0, "")).toEqual(["README.md", "package.json", "src/"]);
    expect(await names(HEAD_0, "src/authz")).toEqual(["actions.ts", "check.ts", "roles.ts"]);
    expect(await names(HEAD_0, "src/collaborators")).toEqual(["routes.ts"]);
    // At the head: the revocation route, and the cache.
    expect(await names(undefined, "src/authz")).toEqual([
      "actions.ts",
      "cache.ts",
      "check.ts",
      "roles.ts",
    ]);
    expect(await names(undefined, "src/collaborators")).toEqual(["revoke.ts", "routes.ts"]);
    await expect(repo.getTree({ path: "no/such" })).rejects.toThrow("no directory");
    await expect(repo.getTree({ ref: "not-a-commit", path: "" })).rejects.toThrow("no commit");
  });

  it("serves a file as it stood at a commit, and a commit's diff as what its changes put there", async () => {
    const log = generateS1(42, "invalidate");
    const repo = createMockRepository(() => log);
    const before = await repo.getBlob({ ref: HEAD_0, path: "src/authz/check.ts" });
    const after = await repo.getBlob({ path: "src/authz/check.ts" });
    expect(before.content).toContain("loadRoles(req.user.id");
    expect(after.content).toContain("permissionCache.rolesFor");
    expect(after).toMatchObject({
      binary: false,
      truncated: false,
      size: new TextEncoder().encode(after.content ?? "").length,
    });
    const [second, first] = (await repo.getCommits({})).items;
    expect(
      (await repo.getCommitDiff(first?.sha ?? "")).files.map((file) => [file.path, file.status]),
    ).toEqual([
      ["src/collaborators/revoke.ts", "added"],
      ["src/collaborators/routes.ts", "modified"],
    ]);
    const landedB = await repo.getCommitDiff(second?.sha ?? "");
    expect(landedB.commit.changes.map((change) => change.label)).toEqual(["#1"]);
    expect(landedB.files.map((file) => [file.path, file.status])).toEqual([
      ["src/authz/cache.ts", "added"],
      ["src/authz/check.ts", "modified"],
      ["src/collaborators/revoke.ts", "modified"],
    ]);
    // A diff's before is the file at the parent commit.
    expect(landedB.files[1]?.before).toBe(before.content);
  });

  it("follows the ruling: what lands, and in what order, is what the log says", async () => {
    const stale = createMockRepository(() => generateS1(42, "allow-stale"));
    const none = createMockRepository(() => generateS1(42, "no-cache"));
    expect(
      (await stale.getCommits({})).items.map((commit) =>
        commit.changes.map((change) => change.label),
      ),
    ).toEqual([["#2"], ["#1"], []]);
    // Under "never cache" only the revocation lands, and trunk never gets a cache.
    expect(
      (await none.getCommits({})).items.map((commit) =>
        commit.changes.map((change) => change.label),
      ),
    ).toEqual([["#2"], []]);
    await expect(none.getBlob({ path: "src/authz/cache.ts" })).rejects.toThrow("no file");
    // Before anything has landed there is the start of trunk and nothing else.
    expect(
      (await createMockRepository(() => generateS1(42)).getCommits({})).items.map(
        (commit) => commit.message,
      ),
    ).toEqual(["Start of trunk"]);
  });

  it("says why a line is as it is, from what the log knew by that commit", async () => {
    const log = generateS1(42, "invalidate");
    const repo = createMockRepository(() => log);
    const told = async (ref: string | undefined, path: string): Promise<string[]> =>
      (await repo.getNotes({ ...(ref === undefined ? {} : { ref }), path })).notes.map(
        (note) =>
          `${note.from} ${note.kind} ${note.label ?? note.holder?.label ?? ""}: ${note.summary}`,
      );
    // At the start nobody had declared anything about it.
    expect(await told(HEAD_0, "src/authz/check.ts")).toEqual([]);
    expect(await told(undefined, "src/authz/cache.ts")).toEqual([
      "5 decision D-1: Cache allowed if revocation invalidates it",
      "5 guard G-1: guards this since conflict C-1 was proven",
      "5 tenet T-1: trunk holds freshness per-request",
      "5 premise #1: relies on invariant is unchanged",
      "5 premise #2: relies on freshness at most per-request",
    ]);
    // The line that drops the cache on revocation is about the same subject.
    expect(
      (await repo.getNotes({ path: "src/collaborators/revoke.ts" })).notes
        .map((note) => [note.from, note.subject])
        .at(0),
    ).toEqual([11, "authz.permission-evaluation"]);
    expect(await told(undefined, "README.md")).toEqual([]);
  });

  it("pages history, and carries on from scenario 1 nine days later", async () => {
    const repo = createMockRepository(() => generateS2(42));
    const first = await repo.getCommits({ limit: 2 });
    const rest = await repo.getCommits({ limit: 2, cursor: first.nextCursor });
    expect([...first.items, ...rest.items].map((commit) => commit.height)).toEqual([
      1144, 1143, 2, 1,
    ]);
    expect(first.items[1]).toMatchObject({ message: "Advances not told in this log", changes: [] });
    expect(first.items[0]?.changes.map((change) => change.label)).toEqual(["#1204"]);
  });

  it("is not there for a story that has no repository", async () => {
    const repo = createMockRepository(() => generateSwarm(42, { agents: 12, seconds: 40 }));
    await expect(repo.getProject()).rejects.toThrow("this fixture has no repository");
    await expect(repo.getTree({ path: "" })).rejects.toThrow("this fixture has no repository");
  });
});
