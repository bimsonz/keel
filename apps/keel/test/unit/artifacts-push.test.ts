import { describe, expect, it } from "vitest";
import { translateArtifactsPush } from "../../src/adapters/driving/queue/artifacts-events.ts";

const push = (repoName: string, ref: string, after: string) => ({
  id: "instance-1",
  type: "cf.artifacts.repo.pushed",
  source: { type: "artifacts.repo", namespace: "keel-ws-00", repoName },
  payload: { ref, before: "a".repeat(40), after, commits: [] },
});

const WORKSPACE = "ws-01JZ8PX3K2M5N7Q9R1S3T5V7W9";
const SHA = "b".repeat(40);

describe("translating Artifacts pushes", () => {
  it("turns a branch update in a workspace into WorkspacePushed", () => {
    expect(translateArtifactsPush(push(WORKSPACE, "refs/heads/main", SHA))).toEqual({
      _tag: "WorkspacePushed",
      workspaceId: "wsp_01JZ8PX3K2M5N7Q9R1S3T5V7W9",
      ref: "refs/heads/main",
      sha: SHA,
    });
  });

  it.each([
    ["a tag", push(WORKSPACE, "refs/tags/v1", SHA)],
    ["a git note", push(WORKSPACE, "refs/notes/mfp", SHA)],
    ["a branch deletion", push(WORKSPACE, "refs/heads/main", "0".repeat(40))],
    ["a repo that is not a workspace", push("mirror", "refs/heads/main", SHA)],
    [
      "another event type",
      { ...push(WORKSPACE, "refs/heads/main", SHA), type: "cf.artifacts.repo.cloned" },
    ],
    ["something unreadable", { hello: "world" }],
  ])("drops %s", (_what, event) => {
    expect(translateArtifactsPush(event)).toBeNull();
  });
});
