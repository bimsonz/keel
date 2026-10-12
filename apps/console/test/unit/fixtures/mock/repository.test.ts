import { describe, expect, it, vi } from "vitest";
import { createMockRepository } from "../../../fixtures/mock/repository.ts";
import { generateS1 } from "../../../fixtures/mock/s1.ts";
import { generateS2 } from "../../../fixtures/mock/s2.ts";
import { generateSwarm } from "../../../fixtures/mock/swarm.ts";
import type { GeneratedLog } from "../../../fixtures/mock/builder.ts";
import type { RepoCommit } from "../../../../src/contract/keel/index.ts";
import type { RepoAt } from "../../../../src/source/repository.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const HEAD_0 = "4b1d9e0c7a2f5381966be0d4c3a7f1e2b8d05a46";

/** A fixture's log, its repository, Keel's id for its project, and the number Keel gave each change. */
function repositoryOf(log: GeneratedLog) {
  const repo = createMockRepository(() => log);
  const id =
    log.events.flatMap((event) =>
      event.type === "ProjectCreated" ? [event.payload.projectId] : [],
    )[0] ?? "";
  const labels = new Map(
    log.events.flatMap((event): [string, string][] =>
      event.type === "IntentDeclared" ? [[event.payload.changeId, event.label ?? ""]] : [],
    ),
  );
  /** What each commit landed, by Keel's number for the change it carries. */
  const landed = (commits: RepoCommit[]): (string | null)[] =>
    commits.map((commit) =>
      commit.changeId === undefined ? null : (labels.get(commit.changeId) ?? commit.changeId),
    );
  return { repo, id, landed };
}

describe("the repository a fixture's story is about", () => {
  it("tells trunk's history from the log as Keel's does: one commit to a change, newest first, each carrying its change", async () => {
    const log = generateS1(42, "invalidate");
    const { repo, id, landed } = repositoryOf(log);
    const { items, nextCursor } = await repo.getCommits(id, {});
    expect(items.map((commit) => commit.message)).toEqual([
      "Speed up permission checks",
      "Owners can revoke collaborators, effective immediately",
      "Start of trunk",
    ]);
    expect(landed(items)).toEqual(["#1", "#2", null]);
    // The whole of it in one page: Keel gives a cursor only where there is more.
    expect(nextCursor).toBeUndefined();
    // Each commit is the head trunk advanced to, and stands on the one before.
    const advances = log.events.filter((event) => event.type === "TrunkAdvanced");
    expect(items.slice(0, 2).map((commit) => commit.sha)).toEqual(
      advances.map((event) => event.payload.to).toReversed(),
    );
    expect(items.map((commit) => commit.parents[0])).toEqual([items[1]?.sha, HEAD_0, undefined]);
    // When a commit landed is its committer's time: the advance's own.
    expect(items.slice(0, 2).map((commit) => commit.committer.at)).toEqual(
      advances.map((event) => event.at).toReversed(),
    );
  });

  it("serves the tree as it stood at each commit, and refuses by Keel's own codes", async () => {
    const log = generateS1(42, "invalidate");
    const { repo, id } = repositoryOf(log);
    const names = async (ref: string | undefined, path: string): Promise<string[]> =>
      (await repo.getTree(id, { ...(ref === undefined ? {} : { ref }), path })).entries
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
    // A tree says the commit it was read at, and where each entry is from the root.
    const tree = await repo.getTree(id, { path: "src/authz" });
    expect(tree.commit).toBe((await repo.getCommits(id, {})).items[0]?.sha);
    expect(tree.entries.map((entry) => entry.path)).toContain("src/authz/cache.ts");
    await expect(repo.getTree(id, { path: "no/such" })).rejects.toMatchObject({
      code: "repo.path_not_found",
    });
    // A file's path is not a directory: the same answer, which is how a reader knows to ask for the file.
    await expect(repo.getTree(id, { path: "src/authz/check.ts" })).rejects.toMatchObject({
      code: "repo.path_not_found",
    });
    await expect(repo.getTree(id, { ref: "not-a-commit", path: "" })).rejects.toMatchObject({
      code: "repo.ref_not_found",
    });
    // Another project's id is no project, as a private one is.
    await expect(repo.getTree("prj_OTHER", { path: "" })).rejects.toMatchObject({
      code: "resource.not_found",
    });
  });

  it("serves a file as it stood at a commit, and a commit with what its change put there", async () => {
    const log = generateS1(42, "invalidate");
    const { repo, id, landed } = repositoryOf(log);
    const before = await repo.getBlob(id, { ref: HEAD_0, path: "src/authz/check.ts" });
    const after = await repo.getBlob(id, { path: "src/authz/check.ts" });
    expect(before.content).toContain("loadRoles(req.user.id");
    expect(after.content).toContain("permissionCache.rolesFor");
    expect(after).toMatchObject({
      binary: false,
      truncated: false,
      size: new TextEncoder().encode(after.content ?? "").length,
    });
    expect(before.commit).toBe(HEAD_0);
    const [second, first] = (await repo.getCommits(id, {})).items;
    expect(
      (await repo.getCommit(id, first?.sha ?? "")).files.map((file) => [file.path, file.status]),
    ).toEqual([
      ["src/collaborators/revoke.ts", "added"],
      ["src/collaborators/routes.ts", "modified"],
    ]);
    const landedB = await repo.getCommit(id, second?.sha ?? "");
    expect(landed([landedB.commit])).toEqual(["#1"]);
    expect(landedB.base).toBe(first?.sha);
    expect(landedB.files.map((file) => [file.path, file.status])).toEqual([
      ["src/authz/cache.ts", "added"],
      ["src/authz/check.ts", "modified"],
      ["src/collaborators/revoke.ts", "modified"],
    ]);
    // A diff's before is the file at the parent commit.
    expect(landedB.files[1]?.before).toBe(before.content);
  });

  it("follows the ruling: what lands, and in what order, is what the log says", async () => {
    const stale = repositoryOf(generateS1(42, "allow-stale"));
    const none = repositoryOf(generateS1(42, "no-cache"));
    expect(stale.landed((await stale.repo.getCommits(stale.id, {})).items)).toEqual([
      "#2",
      "#1",
      null,
    ]);
    // Under "never cache" only the revocation lands, and trunk never gets a cache.
    expect(none.landed((await none.repo.getCommits(none.id, {})).items)).toEqual(["#2", null]);
    await expect(none.repo.getBlob(none.id, { path: "src/authz/cache.ts" })).rejects.toMatchObject({
      code: "repo.path_not_found",
    });
    // Before anything has landed there is the start of trunk and nothing else.
    const bare = repositoryOf(generateS1(42));
    expect((await bare.repo.getCommits(bare.id, {})).items.map((commit) => commit.message)).toEqual(
      ["Start of trunk"],
    );
  });

  it("says why a line is as it is, from what the log knew by that commit", async () => {
    const log = generateS1(42, "invalidate");
    const { repo } = repositoryOf(log);
    const notesAt = async (at: RepoAt) => (await repo.getNotes?.(at))?.notes ?? [];
    const told = async (ref: string | undefined, path: string): Promise<string[]> =>
      (await notesAt({ ...(ref === undefined ? {} : { ref }), path })).map(
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
      (await notesAt({ path: "src/collaborators/revoke.ts" }))
        .map((note) => [note.from, note.subject])
        .at(0),
    ).toEqual([11, "authz.permission-evaluation"]);
    expect(await told(undefined, "README.md")).toEqual([]);
  });

  it("pages history as Keel does, and carries on from scenario 1 nine days later", async () => {
    const { repo, id, landed } = repositoryOf(generateS2(42));
    const first = await repo.getCommits(id, { limit: 2 });
    expect(first.nextCursor).toBeDefined();
    const rest = await repo.getCommits(id, {
      limit: 2,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    const last = await repo.getCommits(id, {
      limit: 2,
      ...(rest.nextCursor === undefined ? {} : { cursor: rest.nextCursor }),
    });
    expect(landed([...first.items, ...rest.items, ...last.items])).toEqual([
      "#1204",
      null,
      "#1",
      "#2",
      null,
    ]);
    expect(first.items[1]?.message).toBe("Advances not told in this log");
    // The last page says there is no more, by having no cursor.
    expect(last.nextCursor).toBeUndefined();
  });

  it("is not there for a story that has no repository", async () => {
    const repo = createMockRepository(() => generateSwarm(42, { agents: 12, seconds: 40 }));
    await expect(repo.getTree("prj_ANY", { path: "" })).rejects.toThrow(
      "this fixture has no repository",
    );
  });
});
