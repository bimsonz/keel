import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "../src/auth/sessions.ts";
import { EventBus, type DomainEvent } from "../src/events.ts";
import { START, harness } from "./support/harness.ts";

describe("events", () => {
  it("emits user.created on sign-up", async () => {
    const h = harness();
    await h.signUp("alice");
    expect(h.events).toEqual([{ type: "user.created", at: START, userId: "usr_1", username: "alice" }]);
  });

  it("emits session.created on login and session.ended on logout", async () => {
    const h = harness();
    const alice = await h.user("alice");
    h.clock.advance(1_000);
    await alice.delete("/sessions/current");
    expect(h.events.slice(1)).toEqual([
      { type: "session.created", at: START, sessionId: "ses_1", userId: "usr_1", expiresAt: START + SESSION_TTL_MS },
      { type: "session.ended", at: START + 1_000, sessionId: "ses_1", userId: "usr_1" },
    ]);
  });

  it("emits repo.created", async () => {
    const h = harness();
    await h.createRepo(await h.user("alice"), "forge", "public");
    expect(h.events.at(-1)).toEqual({
      type: "repo.created",
      at: START,
      repoId: "repo_1",
      ownerId: "usr_1",
      name: "forge",
      visibility: "public",
    });
  });

  it("emits collaborator.added and collaborator.role-changed with the acting user", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    await h.signUp("bob");
    await h.addCollaborator(alice, "forge", "bob", "read");
    await alice.patch("/repos/alice/forge/collaborators/bob", { role: "maintain" });
    expect(h.events.slice(-2)).toEqual([
      { type: "collaborator.added", at: START, repoId: "repo_1", userId: "usr_2", role: "read", addedBy: "usr_1" },
      {
        type: "collaborator.role-changed",
        at: START,
        repoId: "repo_1",
        userId: "usr_2",
        from: "read",
        to: "maintain",
        changedBy: "usr_1",
      },
    ]);
  });

  it("emits repo.visibility-changed, repo.transferred and repo.deleted", async () => {
    const h = harness();
    const alice = await h.user("alice");
    const bob = await h.user("bob");
    await h.createRepo(alice, "forge", "private");
    await alice.put("/repos/alice/forge/visibility", { visibility: "public" });
    await alice.post("/repos/alice/forge/transfer", { newOwner: "bob" });
    await bob.delete("/repos/bob/forge");
    expect(h.events.slice(-3).map((event) => event.type)).toEqual([
      "repo.visibility-changed",
      "repo.transferred",
      "repo.deleted",
    ]);
    expect(h.events.at(-2)).toMatchObject({ fromOwnerId: "usr_1", toOwnerId: "usr_2" });
  });

  it("emits ref.updated with the previous and new object ids", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    await alice.put("/repos/alice/forge/refs/heads/main", { sha: "a".repeat(40) });
    await alice.put("/repos/alice/forge/refs/heads/main", { sha: "b".repeat(40) });
    expect(h.events.slice(-2).map((event) => (event.type === "ref.updated" ? [event.from, event.to] : []))).toEqual([
      [null, "a".repeat(40)],
      ["a".repeat(40), "b".repeat(40)],
    ]);
  });

  it("emits nothing for a request that is refused", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    const before = h.events.length;
    await h.anonymous.delete("/repos/alice/forge");
    await alice.post("/repos", { name: "forge" });
    await alice.put("/repos/alice/forge/collaborators/nobody", { role: "read" });
    expect(h.events.length).toBe(before);
  });

  it("delivers events by type and stops after unsubscribing", () => {
    const bus = new EventBus();
    const seen: DomainEvent[] = [];
    const unsubscribe = bus.subscribe("user.created", (event) => seen.push(event));
    const created: DomainEvent = { type: "user.created", at: 1, userId: "usr_1", username: "alice" };
    bus.emit(created);
    bus.emit({ type: "session.ended", at: 2, sessionId: "ses_1", userId: "usr_1" });
    unsubscribe();
    bus.emit(created);
    expect(seen).toEqual([created]);
  });
});
