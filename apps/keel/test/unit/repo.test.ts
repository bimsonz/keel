// The repo read API through the handler object: who may read a project's
// code, and what each read answers, over in-memory trunks.
import { projectRepos } from "@keeltown/core/application/integration";
import type { Principal } from "@keeltown/core/domain/identity";
import { AgentId, CommitSha, Instant, ProjectId } from "@keeltown/core/kernel";
import { CodeHost, type ProjectSettings } from "@keeltown/core/ports";
import {
  type FixtureFiles,
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeChangesMemory,
  makeClockMemory,
  makeCodeHostMemory,
  makeEnrolmentsMemory,
  makeSessionsMemory,
  makeStandingsMemory,
  makeEventFeedMemory,
  makeIdsMemory,
  makeInboxMemory,
  makeMembershipsMemory,
  makeOrgsMemory,
  makeProjectOrgsMemory,
  makeProjectsMemory,
  makeProbeLedgerMemory,
  makeProbeStoreMemory,
  makeProjectViewsMemory,
  makeTokenIssuerMemory,
  makeUsersMemory,
  sampleOrgId,
  sampleSponsorId,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";
import { commitsOk } from "../../src/adapters/driving/http/repo.ts";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";

const project = Schema.decodeUnknownSync(ProjectId);
const PRIVATE = project("prj_25R7GR504NN2N2MB7JTCFBPPQ8");
const ELSEWHERE = project("prj_0SYSTEM0000000000000000000");
const HISTORY = project("prj_3QV5XQYT97AZ542QMTCPSQYENF");
const DIFFS = project("prj_7FTAT7FJWMEMMJZWGW3D51XX97");
const MAIN = "refs/heads/main";

const clock = makeClockMemory().layer;
const directory = makeAgentDirectoryMemory().layer;
const inbox = makeInboxMemory();
const codeHost = makeCodeHostMemory();
const projects = makeProjectsMemory();
const places = makeProjectOrgsMemory();
const rows = makeBetterAuthMemory({ orgs: [{ id: sampleOrgId, slug: "forge" }] });
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    directory,
    projects.layer,
    makeEnrolmentsMemory().layer.pipe(Layer.provide(directory)),
    makeSessionsMemory().layer.pipe(Layer.provide(directory)),
    makeStandingsMemory().layer.pipe(Layer.provide(directory)),
    makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
    clock,
    makeIdsMemory().layer,
    makeChangesMemory().layer,
    inbox.layer,
    inbox.notifier,
    makeEventFeedMemory().layer,
    makeProjectViewsMemory().layer,
    makeProbeStoreMemory().layer,
    makeProbeLedgerMemory().world,
    codeHost.layer,
    makeUsersMemory(rows).layer,
    makeMembershipsMemory(rows).layer,
    makeOrgsMemory(rows).layer,
    places.layer,
  ),
);
afterAll(() => runtime.dispose());
const handlers = makeHandlers(makeRunner(runtime), { emailCode: false, github: false });

const settings = (visibility: "private" | "public"): ProjectSettings => ({
  protectedPaths: [],
  maxBatchSize: 1,
  verification: "required",
  visibility,
});
for (const [projectId, visibility] of [
  [PRIVATE, "private"],
  [HISTORY, "public"],
  [DIFFS, "private"],
] as const) {
  projects.setSettings(projectId, settings(visibility));
  places.places.set(projectId, { projectId, org: sampleOrgId, name: projectId.toLowerCase() });
}

/** Commits `files` as the whole tree on a project's trunk `main`, creating the trunk first. */
async function commit(projectId: ProjectId, files: FixtureFiles): Promise<string> {
  const trunk = projectRepos(projectId).trunk;
  return Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* CodeHost;
      yield* host.create(trunk).pipe(Effect.catchTag("RepoAlreadyExists", () => Effect.void));
      return yield* codeHost.fixture.commit(trunk, MAIN, files);
    }).pipe(Effect.provide(codeHost.layer)),
  );
}

const caller = (principal: Principal): Caller => ({
  requestId: "req-repo",
  principal,
  signal: new AbortController().signal,
});
const anonymous = caller({ _tag: "Anonymous" });
/** An agent of `projectId`, placed in the project's org and sponsored by a member there. */
const agentOf = (projectId: ProjectId) =>
  caller({
    _tag: "Agent",
    agentId: Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
    org: sampleOrgId,
    projectId,
    scopes: ["agent:read", "agent:work"],
    sponsor: { userId: sampleSponsorId, role: "member", suspended: false },
  });
/** A member of the org that holds every project here: it reads them all, the private ones too. */
const member = caller({
  _tag: "User",
  userId: sampleSponsorId,
  handle: "forge-member",
  suspended: false,
  memberships: [{ org: sampleOrgId, role: "member" }],
});

const bodyOf = async <B>(answer: unknown): Promise<B> => {
  const result: unknown = await answer;
  return Reflect.get(Object(result), "body");
};

const FILES: FixtureFiles = {
  "README.md": "# forge-lite\n",
  "src/index.ts": "export const one = 1;\n",
  "src/deep/x.ts": "export const x = 1;\n",
  "bin.dat": new Uint8Array([1, 0, 2]),
  link: { mode: "120000", data: "README.md" },
  vendor: { mode: "160000", data: "1".repeat(40) },
};

describe("the repo read API", () => {
  it("[repo.tree] a directory at a branch, a full ref or a commit, its entries typed; a file's path or an unknown ref is a 404 naming which", async () => {
    const head = await commit(PRIVATE, FILES);
    const reader = agentOf(PRIVATE);
    const root = await bodyOf<{ commit: string; entries: { name: string; kind: string }[] }>(
      handlers.Repo_getTree(reader, { projectId: PRIVATE }),
    );
    expect(root.commit).toBe(head);
    expect(root.entries.map((e) => [e.name, e.kind])).toEqual([
      ["README.md", "blob"],
      ["bin.dat", "blob"],
      ["link", "symlink"],
      ["src", "tree"],
      ["vendor", "submodule"],
    ]);
    for (const ref of ["main", MAIN, head]) {
      const src = await bodyOf<{ commit: string; entries: { path: string }[] }>(
        handlers.Repo_getTree(reader, { projectId: PRIVATE, ref, path: "src" }),
      );
      expect([src.commit, src.entries.map((e) => e.path)]).toEqual([
        head,
        ["src/deep", "src/index.ts"],
      ]);
    }
    const asFile = await handlers.Repo_getTree(reader, { projectId: PRIVATE, path: "README.md" });
    expect([asFile.status, (await bodyOf<{ code: string }>(asFile)).code]).toEqual([
      404,
      "repo.path_not_found",
    ]);
    for (const ref of ["nope", "0".repeat(40)]) {
      const unknown = await handlers.Repo_getTree(reader, { projectId: PRIVATE, ref });
      expect([unknown.status, (await bodyOf<{ code: string }>(unknown)).code]).toEqual([
        404,
        "repo.ref_not_found",
      ]);
    }
  });

  it("[repo.blob] a file's text inline; a binary file or one over 1 MiB has none; a directory is not a file", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    await commit(PRIVATE, { ...FILES, "big.txt": big });
    const reader = agentOf(PRIVATE);
    const blob = (path: string) => handlers.Repo_getBlob(reader, { projectId: PRIVATE, path });
    expect(await bodyOf(blob("src/index.ts"))).toMatchObject({
      path: "src/index.ts",
      mode: "100644",
      size: 22,
      binary: false,
      truncated: false,
      content: "export const one = 1;\n",
    });
    const binary = await bodyOf<Record<string, unknown>>(blob("bin.dat"));
    expect(binary).toMatchObject({ size: 3, binary: true, truncated: false });
    expect(binary).not.toHaveProperty("content");
    const truncated = await bodyOf<Record<string, unknown>>(blob("big.txt"));
    expect(truncated).toMatchObject({ size: big.length, binary: false, truncated: true });
    expect(truncated).not.toHaveProperty("content");
    expect(await bodyOf(blob("link"))).toMatchObject({ mode: "120000", content: "README.md" });
    for (const path of ["src", "src/nope.ts", "nope/x.ts", "vendor", ""])
      expect(await bodyOf(blob(path))).toMatchObject({ code: "repo.path_not_found" });
  });

  it("[repo.commits-cursor] pages of history meet end to end, newest first, each starting where the last one's cursor says", async () => {
    const chain: string[] = [];
    for (let i = 0; i < 5; i += 1) chain.unshift(await commit(HISTORY, { f: `${i}\n` }));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await bodyOf<{ items: { sha: string }[]; nextCursor?: string }>(
        handlers.Repo_listCommits(anonymous, {
          projectId: HISTORY,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      seen.push(...page.items.map((c) => c.sha));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(seen).toEqual(chain);
    expect(pages).toBe(3);
    // Trunk moving on does not move a page: the cursor names a commit.
    const first = await bodyOf<{ nextCursor: string }>(
      handlers.Repo_listCommits(anonymous, { projectId: HISTORY, limit: 2 }),
    );
    await commit(HISTORY, { f: "moved\n" });
    const second = await bodyOf<{ items: { sha: string }[] }>(
      handlers.Repo_listCommits(anonymous, {
        projectId: HISTORY,
        limit: 2,
        cursor: first.nextCursor,
      }),
    );
    expect(second.items.map((c) => c.sha)).toEqual(chain.slice(2, 4));
    const bad = await handlers.Repo_listCommits(anonymous, { projectId: HISTORY, cursor: "7" });
    expect(bad.status).toBe(400);
  });

  it("[repo.diff] a commit's files against its first parent with their text; a root commit adds every file", async () => {
    const reader = member;
    const before = await commit(DIFFS, { "a.txt": "one\n", "gone.txt": "bye\n", "d/x": "x\n" });
    const after = await commit(DIFFS, { "a.txt": "two\n", "new.txt": "hi\n", "d/x": "x\n" });
    const rooted = await bodyOf<{ base?: string; files: unknown[] }>(
      handlers.Repo_getCommit(reader, { projectId: DIFFS, sha: before }),
    );
    expect(rooted.base).toBeUndefined();
    expect(rooted.files).toEqual([
      expect.objectContaining({ path: "a.txt", status: "added", before: null, after: "one\n" }),
      expect.objectContaining({ path: "d/x", status: "added", before: null, after: "x\n" }),
      expect.objectContaining({ path: "gone.txt", status: "added", before: null, after: "bye\n" }),
    ]);
    const diff = await bodyOf<{
      commit: { sha: string; parents: string[] };
      base: string;
      files: unknown[];
    }>(handlers.Repo_getCommit(reader, { projectId: DIFFS, sha: after }));
    expect(diff.commit.sha).toBe(after);
    expect(diff.base).toBe(before);
    expect(diff.files).toEqual([
      expect.objectContaining({
        path: "a.txt",
        status: "modified",
        before: "one\n",
        after: "two\n",
      }),
      expect.objectContaining({
        path: "gone.txt",
        status: "deleted",
        before: "bye\n",
        after: null,
      }),
      expect.objectContaining({ path: "new.txt", status: "added", before: null, after: "hi\n" }),
    ]);
    const unknown = await handlers.Repo_getCommit(reader, {
      projectId: DIFFS,
      sha: "0".repeat(40),
    });
    expect(await bodyOf(unknown)).toMatchObject({ code: "repo.ref_not_found" });
    // A private project's code is its org's: another project's agent is refused, a visitor sees nothing.
    const foreign = await handlers.Repo_getCommit(agentOf(ELSEWHERE), {
      projectId: DIFFS,
      sha: after,
    });
    expect([foreign.status, await bodyOf(foreign)]).toEqual([
      403,
      expect.objectContaining({ code: "auth.forbidden", detail: "Refused: foreign-project." }),
    ]);
    const visitor = await handlers.Repo_getCommit(anonymous, { projectId: DIFFS, sha: after });
    expect([visitor.status, await bodyOf(visitor)]).toEqual([
      404,
      expect.objectContaining({ code: "resource.not_found" }),
    ]);
  });

  it("[repo.diff-caps] a side over 1 MiB, the files past 8 MiB in all, and every file past 300 come without text", async () => {
    const MB = 1_000_000;
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i += 1) files[`big/${i}.txt`] = String(i).repeat(MB);
    files["huge.txt"] = "h".repeat(1024 * 1024 + 1);
    for (let i = 0; i < 300; i += 1) files[`many/${String(i).padStart(3, "0")}.txt`] = `${i}\n`;
    await commit(PRIVATE, { seed: "s\n" });
    const sha = await commit(PRIVATE, files);
    const diff = await bodyOf<{
      files: { path: string; truncated: boolean; after: string | null }[];
    }>(handlers.Repo_getCommit(member, { projectId: PRIVATE, sha }));
    const byPath = new Map(diff.files.map((f) => [f.path, f]));
    const served = (path: string) => byPath.get(path)?.after !== null;
    expect([...Array(8).keys()].every((i) => served(`big/${i}.txt`))).toBe(true);
    expect(byPath.get("big/8.txt")).toMatchObject({ truncated: true, after: null });
    expect(byPath.get("huge.txt")).toMatchObject({ truncated: true, after: null });
    // In diff order the 300 small files follow big/ and huge.txt, so those past the 300th file have no text.
    const truncated = diff.files.slice(300);
    expect(truncated.length).toBeGreaterThan(0);
    expect(truncated.every((f) => f.truncated && f.after === null)).toBe(true);
    expect(served("many/000.txt")).toBe(true);
  });

  it("[repo.change-id] a commit names the change it landed from its Change-Id trailer, and nothing without one", () => {
    const who = { name: "a1", email: "a1@keel.invalid", at: Instant(Date.UTC(2026, 9, 11)) };
    const sha = Schema.decodeUnknownSync(CommitSha)("a".repeat(40));
    const landed = { sha, tree: "b".repeat(40), parents: [], author: who, committer: who };
    const page = commitsOk({
      commits: [
        { ...landed, message: "Add a note\n\nChange-Id: chg_01M4MRJ8ZWCRZG449AAEG0T77F" },
        { ...landed, message: "forge-lite: the S-0 fixture" },
      ],
    });
    expect(page.body.items.map((c) => c.changeId)).toEqual([
      "chg_01M4MRJ8ZWCRZG449AAEG0T77F",
      undefined,
    ]);
    expect(page.body.items[0]?.committer.at).toBe("2026-10-11T00:00:00.000Z");
    expect(page.body).not.toHaveProperty("nextCursor");
  });
});
