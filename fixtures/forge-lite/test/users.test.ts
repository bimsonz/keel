import { describe, expect, it } from "vitest";
import type { UserView } from "../src/http/views.ts";
import { PASSWORD, harness, json, problem } from "./support/harness.ts";

describe("users", () => {
  it("signs up a user without echoing the password", async () => {
    const h = harness();
    const res = await h.request("POST", "/users", {
      body: { username: "alice", password: PASSWORD, name: "Alice Liddell" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/users/alice");
    const body = await json<Record<string, unknown>>(res);
    expect(body).toEqual({
      id: "usr_1",
      username: "alice",
      name: "Alice Liddell",
      createdAt: "2026-01-01T09:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
  });

  it("refuses a username that is already taken", async () => {
    const h = harness();
    await h.signUp("alice");
    const res = await h.request("POST", "/users", { body: { username: "alice", password: PASSWORD } });
    expect((await problem(res, 409)).type).toBe("/problems/username-taken");
  });

  it.each([
    { username: "", why: "empty" },
    { username: "Alice", why: "uppercase" },
    { username: "-alice", why: "leading hyphen" },
    { username: "a".repeat(40), why: "40 characters" },
  ])("rejects the username '$username' ($why)", async ({ username }) => {
    const h = harness();
    const res = await h.request("POST", "/users", { body: { username, password: PASSWORD } });
    expect((await problem(res, 422)).detail).toMatch(/^username must be/);
  });

  it("rejects a password shorter than ten characters", async () => {
    const h = harness();
    const res = await h.request("POST", "/users", { body: { username: "alice", password: "hunter2" } });
    expect((await problem(res, 422)).detail).toBe("password must be at least 10 characters");
  });

  it("requires a password", async () => {
    const h = harness();
    const res = await h.request("POST", "/users", { body: { username: "alice" } });
    expect((await problem(res, 422)).detail).toBe("password is required and must be a string");
  });

  it("rejects a body that is not JSON", async () => {
    const h = harness();
    const res = await h.request("POST", "/users", { body: "{username: alice" });
    expect((await problem(res, 400)).type).toBe("/problems/malformed-body");
  });

  it("rejects a JSON body that is not an object", async () => {
    const h = harness();
    const res = await h.request("POST", "/users", { body: '["alice"]' });
    expect((await problem(res, 400)).detail).toBe("request body must be a JSON object");
  });

  it("shows a public profile", async () => {
    const h = harness();
    await h.signUp("alice");
    const res = await h.anonymous.get("/users/alice");
    expect(res.status).toBe(200);
    expect(await json<UserView>(res)).toMatchObject({ id: "usr_1", username: "alice" });
  });

  it("answers 404 for an unknown user", async () => {
    const h = harness();
    expect((await problem(await h.anonymous.get("/users/nobody"), 404)).detail).toBe("user nobody not found");
  });

  it("returns the signed-in user from /user", async () => {
    const h = harness();
    const alice = await h.user("alice");
    expect(await json<UserView>(await alice.get("/user"))).toMatchObject({ username: "alice" });
  });

  it("asks anonymous callers of /user to authenticate", async () => {
    const h = harness();
    const res = await h.anonymous.get("/user");
    await problem(res, 401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="forge-lite"');
  });
});
