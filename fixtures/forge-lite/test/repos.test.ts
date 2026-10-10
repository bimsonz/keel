import { describe, expect, it } from "vitest";
import type { RepoView } from "../src/http/views.ts";
import { harness, json, problem } from "./support/harness.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function names(res: Response): Promise<string[]> {
  return (await json<RepoView[]>(res)).map((repo) => repo.name);
}

describe("repositories", () => {
  it("creates a private repository by default", async () => {
    const h = harness();
    const alice = await h.user("alice");
    const res = await alice.post("/repos", { name: "forge", description: "A small forge" });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/repos/alice/forge");
    expect(await json<RepoView>(res)).toEqual({
      id: "repo_1",
      owner: "alice",
      name: "forge",
      fullName: "alice/forge",
      description: "A small forge",
      visibility: "private",
      defaultBranch: "main",
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T09:00:00.000Z",
      viewerRole: "owner",
    });
  });

  it("requires a signed-in user to create a repository", async () => {
    const h = harness();
    const body = await problem(await h.anonymous.post("/repos", { name: "forge" }), 401);
    expect(body.detail).toBe("this endpoint requires a bearer token");
  });

  it("refuses a second repository with the same name for the same owner", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    expect((await problem(await alice.post("/repos", { name: "forge" }), 409)).type).toBe("/problems/repo-exists");
  });

  it("allows the same name under different owners", async () => {
    const h = harness();
    await h.createRepo(await h.user("alice"), "forge");
    expect((await (await h.user("bob")).post("/repos", { name: "forge" })).status).toBe(201);
  });

  it.each(["..", "Forge", "forge.git", "x".repeat(101)])(
    "rejects the repository name '%s'",
    async (name) => {
      const h = harness();
      const alice = await h.user("alice");
      expect((await problem(await alice.post("/repos", { name }), 422)).detail).toMatch(/^name must be/);
    },
  );

  it("rejects an unknown visibility", async () => {
    const h = harness();
    const alice = await h.user("alice");
    const res = await alice.post("/repos", { name: "forge", visibility: "internal" });
    expect((await problem(res, 422)).detail).toBe("visibility must be 'public' or 'private'");
  });

  it("answers 404 for a repository that does not exist", async () => {
    const h = harness();
    await h.signUp("alice");
    const body = await problem(await h.anonymous.get("/repos/alice/nothing"), 404);
    expect(body.detail).toBe("repository alice/nothing not found");
  });

  it("updates settings and stamps updatedAt from the clock", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    h.clock.advance(60_000);
    const res = await alice.patch("/repos/alice/forge", { description: "Now with refs", defaultBranch: "trunk" });
    expect(await json<RepoView>(res)).toMatchObject({
      description: "Now with refs",
      defaultBranch: "trunk",
      updatedAt: "2026-01-01T09:01:00.000Z",
    });
  });

  it("opens a private repository to anonymous readers once it is made public", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge", "private");
    await problem(await h.anonymous.get("/repos/alice/forge"), 404);
    expect((await alice.put("/repos/alice/forge/visibility", { visibility: "public" })).status).toBe(200);
    expect((await h.anonymous.get("/repos/alice/forge")).status).toBe(200);
  });

  it("transfers a repository to a new owner", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.signUp("bob");
    await h.createRepo(alice, "forge", "public");
    const res = await alice.post("/repos/alice/forge/transfer", { newOwner: "bob" });
    expect(res.status).toBe(200);
    expect(await json<RepoView>(res)).toMatchObject({ id: "repo_1", fullName: "bob/forge", viewerRole: null });
    await problem(await h.anonymous.get("/repos/alice/forge"), 404);
    expect((await h.anonymous.get("/repos/bob/forge")).status).toBe(200);
  });

  it("takes all access away from the previous owner of a transferred private repository", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.signUp("bob");
    await h.createRepo(alice, "forge", "private");
    expect((await alice.post("/repos/alice/forge/transfer", { newOwner: "bob" })).status).toBe(200);
    await problem(await alice.get("/repos/bob/forge"), 404);
  });

  it("refuses to transfer to a user who does not exist", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    const res = await alice.post("/repos/alice/forge/transfer", { newOwner: "nobody" });
    expect((await problem(res, 422)).detail).toBe("newOwner nobody does not exist");
  });

  it("refuses to transfer onto a repository the new owner already has", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    await h.createRepo(await h.user("bob"), "forge");
    const res = await alice.post("/repos/alice/forge/transfer", { newOwner: "bob" });
    expect((await problem(res, 409)).detail).toBe("repository bob/forge already exists");
  });

  it("deletes a repository", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    expect((await alice.delete("/repos/alice/forge")).status).toBe(204);
    await problem(await alice.get("/repos/alice/forge"), 404);
  });

  it("creates and then fast-forwards a branch", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    expect((await alice.put("/repos/alice/forge/refs/heads/main", { sha: SHA_A })).status).toBe(201);
    expect((await alice.put("/repos/alice/forge/refs/heads/main", { sha: SHA_B })).status).toBe(200);
    expect(await json<unknown>(await alice.get("/repos/alice/forge/refs"))).toEqual([
      { name: "refs/heads/main", sha: SHA_B },
    ]);
  });

  it("rejects a ref update whose sha is not a full object id", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    const res = await alice.put("/repos/alice/forge/refs/heads/main", { sha: "abc123" });
    expect((await problem(res, 422)).detail).toBe("sha must be 40 lowercase hexadecimal characters");
  });

  it("saves labels with a default colour", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    expect((await alice.put("/repos/alice/forge/labels/bug", { color: "d73a4a" })).status).toBe(201);
    expect((await alice.put("/repos/alice/forge/labels/question", {})).status).toBe(201);
    expect(await json<unknown>(await alice.get("/repos/alice/forge/labels"))).toEqual([
      { name: "bug", color: "d73a4a" },
      { name: "question", color: "ededed" },
    ]);
  });

  it("lists a user's repositories as the caller is allowed to see them", async () => {
    const h = harness();
    const alice = await h.user("alice");
    const bob = await h.user("bob");
    await h.createRepo(alice, "notes", "private");
    await h.createRepo(alice, "forge", "public");
    await h.createRepo(alice, "secret", "private");
    await h.addCollaborator(alice, "notes", "bob", "read");
    expect(await names(await alice.get("/users/alice/repos"))).toEqual(["forge", "notes", "secret"]);
    expect(await names(await bob.get("/users/alice/repos"))).toEqual(["forge", "notes"]);
    expect(await names(await h.anonymous.get("/users/alice/repos"))).toEqual(["forge"]);
  });
});
