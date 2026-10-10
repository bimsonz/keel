import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "../src/auth/sessions.ts";
import type { SessionView, UserView } from "../src/http/views.ts";
import { PASSWORD, harness, json, problem } from "./support/harness.ts";

describe("sessions", () => {
  it("logs in with a bearer token that expires after the session lifetime", async () => {
    const h = harness();
    await h.signUp("alice");
    const res = await h.request("POST", "/sessions", { body: { username: "alice", password: PASSWORD } });
    expect(res.status).toBe(201);
    const body = await json<{ token: string; session: SessionView; user: UserView }>(res);
    expect(body.token).toBe("secret_2");
    expect(body.session).toEqual({
      id: "ses_1",
      userId: "usr_1",
      createdAt: "2026-01-01T09:00:00.000Z",
      expiresAt: "2026-01-01T21:00:00.000Z",
    });
    expect(body.user.username).toBe("alice");
  });

  it("refuses a wrong password and an unknown user with the same answer", async () => {
    const h = harness();
    await h.signUp("alice");
    const wrong = await problem(
      await h.request("POST", "/sessions", { body: { username: "alice", password: "not the password" } }),
      401,
    );
    const unknown = await problem(
      await h.request("POST", "/sessions", { body: { username: "nobody", password: PASSWORD } }),
      401,
    );
    expect(wrong).toEqual(unknown);
    expect(wrong.type).toBe("/problems/invalid-credentials");
  });

  it("describes the current session", async () => {
    const h = harness();
    const alice = await h.user("alice");
    expect(await json<SessionView>(await alice.get("/sessions/current"))).toMatchObject({
      id: "ses_1",
      userId: "usr_1",
    });
  });

  it("logs out, after which the token no longer works", async () => {
    const h = harness();
    const alice = await h.user("alice");
    expect((await alice.delete("/sessions/current")).status).toBe(204);
    expect((await problem(await alice.get("/user"), 401)).detail).toBe("the bearer token is not valid");
  });

  it("keeps other sessions alive when one logs out", async () => {
    const h = harness();
    const laptop = await h.user("alice");
    const phone = h.client(await h.login("alice"), "alice");
    expect((await laptop.delete("/sessions/current")).status).toBe(204);
    expect((await phone.get("/user")).status).toBe(200);
  });

  it("still accepts a session one millisecond before it expires", async () => {
    const h = harness();
    const alice = await h.user("alice");
    h.clock.advance(SESSION_TTL_MS - 1);
    expect((await alice.get("/user")).status).toBe(200);
  });

  it("rejects a session once its lifetime has passed", async () => {
    const h = harness();
    const alice = await h.user("alice");
    h.clock.advance(SESSION_TTL_MS);
    const body = await problem(await alice.get("/user"), 401);
    expect(body.type).toBe("/problems/session-expired");
  });

  it("rejects an expired session even on routes that allow anonymous callers", async () => {
    const h = harness();
    const alice = await h.user("alice");
    h.clock.advance(SESSION_TTL_MS + 1);
    expect((await problem(await alice.get("/users/alice"), 401)).type).toBe("/problems/session-expired");
  });

  it("rejects an unknown token", async () => {
    const h = harness();
    await h.signUp("alice");
    expect((await problem(await h.client("forged-token").get("/user"), 401)).detail).toBe(
      "the bearer token is not valid",
    );
  });

  it("rejects an authorization header that is not a bearer token", async () => {
    const h = harness();
    const res = await h.request("GET", "/user", { headers: { authorization: "Basic YWxpY2U6aHVudGVyMg==" } });
    expect((await problem(res, 401)).detail).toBe("authorization header must be 'Bearer <token>'");
  });
});
