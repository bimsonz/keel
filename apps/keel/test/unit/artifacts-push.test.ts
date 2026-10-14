import { ownerOfRepo, workspaceRepoName } from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import { makeId } from "@keeltown/core/kernel";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { translateArtifactsPush } from "../../src/adapters/driving/queue/artifacts-events.ts";

const push = (repoName: string, ref: string, after: string) => ({
  id: "instance-1",
  type: "cf.artifacts.repo.pushed",
  source: { namespace: "keel-ws-00", repoName },
  payload: { ref, before: "a".repeat(40), after, commits: [] },
});

const PROJECT = makeId("prj", "01JZ8PX3K2M5N7Q9R1S3T5V7W0");
const WORKSPACE_ID = makeId("wsp", "01JZ8PX3K2M5N7Q9R1S3T5V7W9");
const WORKSPACE = workspaceRepoName(PROJECT, WORKSPACE_ID);
const SHA = "b".repeat(40);

/** A ULID: 26 characters of Crockford base32. */
const ulid = fc.string({
  unit: fc.constantFrom(..."0123456789ABCDEFGHJKMNPQRSTVWXYZ".split("")),
  minLength: 26,
  maxLength: 26,
});

describe("naming workspace repos", () => {
  it("[push.names] a workspace's repo name gives back its project and id; no other repo of the project names one, nor a name of another kind", () => {
    fc.assert(
      fc.property(ulid, ulid, (p, w) => {
        const projectId = makeId("prj", p);
        const workspaceId = makeId("wsp", w);
        const name = workspaceRepoName(projectId, workspaceId);
        expect(name).toBe(`${projectRepos(projectId).trunk.name}-ws-${w.toLowerCase()}`);
        // Artifacts' rule: a letter or digit first, then letters, digits, `.`, `_` and `-`.
        expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
        expect(ownerOfRepo(name)).toEqual({ kind: "workspace", projectId, id: workspaceId });
        expect(ownerOfRepo(name.replace("-ws-", "-sk-"))).toBeUndefined();
        const repos = projectRepos(projectId);
        for (const other of [repos.trunk.name, repos.staging.name, repos.mirror.name])
          expect(ownerOfRepo(other)).toBeUndefined();
        expect(ownerOfRepo(`ws-${w}`)).toBeUndefined();
        expect(ownerOfRepo(name.toUpperCase())).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});

describe("translating Artifacts pushes", () => {
  it("[push.translate] turns a branch update in a workspace into a push for its project's pool", () => {
    expect(translateArtifactsPush(push(WORKSPACE, "refs/heads/main", SHA))).toEqual({
      projectId: PROJECT,
      push: { workspaceId: WORKSPACE_ID, ref: "refs/heads/main", sha: SHA },
    });
  });

  it("[push.translate-live] translates the event Artifacts delivered on staging (11 Oct), whose source has no type", () => {
    const delivered = {
      id: "ecd3959b-0682-4108-893b-efedb0ad9a78",
      type: "cf.artifacts.repo.pushed",
      source: {
        namespace: "keel-ws-00",
        repoName: "prj-7sv3nje38725n70c8qgj3dsawv-ws-01m4nxkwvxy532xtv0nex9nqr1",
      },
      payload: {
        ref: "refs/heads/main",
        before: "6c7417f067ff9c7048e93a2d116fbf04fcc1f67f",
        after: "c8f41b1b7c1e0a87f1742995e4267ab62580cbd9",
        commits: [
          {
            id: "c8f41b1b7c1e0a87f1742995e4267ab62580cbd9",
            message: "r1: second",
            messageTruncated: false,
            timestamp: "2026-10-11T16:44:45.000Z",
            author: { name: "c14-second", email: "c14-second@agents.keel.invalid" },
            committer: { name: "c14-second", email: "c14-second@agents.keel.invalid" },
            parents: ["6c7417f067ff9c7048e93a2d116fbf04fcc1f67f"],
          },
        ],
        totalCommitsCount: 1,
        commitsTruncated: false,
      },
    };
    expect(translateArtifactsPush(delivered)).toEqual({
      projectId: makeId("prj", "7SV3NJE38725N70C8QGJ3DSAWV"),
      push: {
        workspaceId: makeId("wsp", "01M4NXKWVXY532XTV0NEX9NQR1"),
        ref: "refs/heads/main",
        sha: "c8f41b1b7c1e0a87f1742995e4267ab62580cbd9",
      },
    });
  });

  it.each([
    ["a tag", push(WORKSPACE, "refs/tags/v1", SHA)],
    ["a git note", push(WORKSPACE, "refs/notes/mfp", SHA)],
    ["a branch deletion", push(WORKSPACE, "refs/heads/main", "0".repeat(40))],
    ["Keel's own trunk ref in the workspace", push(WORKSPACE, "refs/heads/keel/trunk", SHA)],
    ["the project's mirror", push(projectRepos(PROJECT).mirror.name, "refs/heads/main", SHA)],
    ["a name of another kind", push(WORKSPACE.replace("-ws-", "-sk-"), "refs/heads/main", SHA)],
    [
      "a workspace named before the project prefix",
      push("ws-01jz8px3k2m5n7q9r1s3t5v7w9", "refs/heads/main", SHA),
    ],
    [
      "another event type",
      { ...push(WORKSPACE, "refs/heads/main", SHA), type: "cf.artifacts.repo.cloned" },
    ],
    ["something unreadable", { hello: "world" }],
  ])("[push.translate] drops %s", (_what, event) => {
    expect(translateArtifactsPush(event)).toBeNull();
  });
});
