// gitcore's reader over an Artifacts repo handle: what the binding decodes
// becomes gitcore's commit, and a missing object is MissingObject.
import { MissingObject } from "@keeltown/gitcore";
import { describe, expect, it } from "vitest";
import { objectsOf } from "../../src/adapters/driven/artifacts/objects.ts";
import { FakeArtifacts } from "./fake-artifacts.ts";

const HEAD = "b".repeat(40);

/** A repo handle whose one commit was authored by Ada and committed by Keel, at different times. */
async function handle(): Promise<ArtifactsRepo> {
  const artifacts = new FakeArtifacts();
  await artifacts.create("prj-ws-1");
  const repo = await artifacts.get("prj-ws-1");
  return {
    ...repo,
    readCommit: async (hash) =>
      hash === HEAD
        ? {
            hash,
            treeHash: "c".repeat(40),
            message: "Retry the webhook on 503",
            author: { name: "Ada Lovelace", email: "ada@example.com" },
            committer: { name: "Keel", email: "keel@keel.invalid" },
            parents: ["a".repeat(40)],
            authoredAt: 1_712_345_678,
            committedAt: 1_791_709_200,
          }
        : null,
  };
}

describe("objectsOf", () => {
  it("[objects.author] reads a commit's tree, parents and author, never its committer", async () => {
    const reader = objectsOf(await handle());
    expect(await reader.readCommit(HEAD)).toEqual({
      tree: "c".repeat(40),
      parents: ["a".repeat(40)],
      author: { name: "Ada Lovelace", email: "ada@example.com", time: 1_712_345_678 },
    });
    await expect(reader.readCommit("d".repeat(40))).rejects.toBeInstanceOf(MissingObject);
  });
});
