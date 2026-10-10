import { describe, expect, it } from "vitest";
import type { CollaboratorView } from "../src/http/views.ts";
import { harness, json, problem } from "./support/harness.ts";

async function aliceWithForge(visibility: "public" | "private" = "private") {
  const h = harness();
  const alice = await h.user("alice");
  await h.createRepo(alice, "forge", visibility);
  return { h, alice };
}

describe("collaborators", () => {
  it("adds a collaborator, who then appears in the list", async () => {
    const { h, alice } = await aliceWithForge();
    await h.signUp("bob");
    const res = await alice.put("/repos/alice/forge/collaborators/bob", { role: "write" });
    expect(res.status).toBe(201);
    expect(await json<CollaboratorView>(res)).toEqual({
      username: "bob",
      role: "write",
      addedAt: "2026-01-01T09:00:00.000Z",
    });
    expect(await json<CollaboratorView[]>(await alice.get("/repos/alice/forge/collaborators"))).toEqual([
      { username: "bob", role: "write", addedAt: "2026-01-01T09:00:00.000Z" },
    ]);
  });

  it("refuses to add the same collaborator twice", async () => {
    const { h, alice } = await aliceWithForge();
    await h.signUp("bob");
    await h.addCollaborator(alice, "forge", "bob", "read");
    const res = await alice.put("/repos/alice/forge/collaborators/bob", { role: "admin" });
    expect((await problem(res, 409)).type).toBe("/problems/already-collaborator");
  });

  it("answers 404 when adding a user who does not exist", async () => {
    const { alice } = await aliceWithForge();
    const res = await alice.put("/repos/alice/forge/collaborators/nobody", { role: "read" });
    expect((await problem(res, 404)).detail).toBe("user nobody not found");
  });

  it("refuses to add the owner as a collaborator", async () => {
    const { alice } = await aliceWithForge();
    const res = await alice.put("/repos/alice/forge/collaborators/alice", { role: "admin" });
    expect((await problem(res, 422)).detail).toBe("the owner cannot be added as a collaborator");
  });

  it.each(["owner", "superuser"])("rejects the role '%s'", async (role) => {
    const { h, alice } = await aliceWithForge();
    await h.signUp("bob");
    const res = await alice.put("/repos/alice/forge/collaborators/bob", { role });
    expect((await problem(res, 422)).detail).toBe("role must be one of read, triage, write, maintain, admin");
  });

  it("gives a new collaborator access on their very next request", async () => {
    const { h, alice } = await aliceWithForge("private");
    const bob = await h.user("bob");
    await problem(await bob.get("/repos/alice/forge"), 404);
    await h.addCollaborator(alice, "forge", "bob", "read");
    expect((await bob.get("/repos/alice/forge")).status).toBe(200);
  });

  it("promotes a collaborator, effective on their next request", async () => {
    const { h, alice } = await aliceWithForge();
    const bob = await h.user("bob");
    await h.addCollaborator(alice, "forge", "bob", "read");
    expect((await bob.get("/repos/alice/forge")).status).toBe(200);
    await problem(await bob.put("/repos/alice/forge/refs/heads/main", { sha: "c".repeat(40) }), 403);

    const res = await alice.patch("/repos/alice/forge/collaborators/bob", { role: "write" });
    expect(await json<CollaboratorView>(res)).toMatchObject({ username: "bob", role: "write" });
    expect((await bob.put("/repos/alice/forge/refs/heads/main", { sha: "c".repeat(40) })).status).toBe(201);
  });

  it("refuses to lower a collaborator's role", async () => {
    const { h, alice } = await aliceWithForge();
    await h.signUp("bob");
    await h.addCollaborator(alice, "forge", "bob", "admin");
    const res = await alice.patch("/repos/alice/forge/collaborators/bob", { role: "read" });
    expect((await problem(res, 409)).type).toBe("/problems/role-downgrade");
  });

  it("answers 404 when changing the role of someone who is not a collaborator", async () => {
    const { h, alice } = await aliceWithForge();
    await h.signUp("bob");
    const res = await alice.patch("/repos/alice/forge/collaborators/bob", { role: "write" });
    expect((await problem(res, 404)).detail).toBe("bob is not a collaborator on this repository");
  });
});
