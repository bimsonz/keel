import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { ManualClock } from "../../src/clock.ts";
import { sequentialIds } from "../../src/ids.ts";
import { MemoryStore } from "../../src/store/memory.ts";

/**
 * Guard for the premise "permission evaluation freshness is at most
 * per-request": once an owner revokes a collaborator, the collaborator's very
 * next request is denied, including on a session that was already in use.
 *
 * Kept out of the main suite and run through scenarios/run-probe.mjs, which
 * turns the result into one of three outcomes:
 *
 *   pass  the revoked session is refused and the repository survives;
 *   fail  anything else;
 *   n/a   the revoke route does not exist, so there is no premise to check.
 *
 * "n/a" is signalled by throwing a marked error, never by returning early, so
 * a world without the route can never be mistaken for a pass.
 */

const NOT_APPLICABLE = "probe not applicable:";
const PASSWORD = "correct horse battery staple";
const REPO = "/repos/alice/forge";
const COLLABORATOR = `${REPO}/collaborators/bob`;

/** Hono's own answer when no route matches, as opposed to a 404 from a handler. */
async function isHonoDefaultNotFound(res: Response): Promise<boolean> {
  return (
    res.status === 404 &&
    (res.headers.get("content-type") ?? "").startsWith("text/plain") &&
    (await res.clone().text()) === "404 Not Found"
  );
}

function report(line: string): void {
  console.log(`[probe] ${line}`);
}

describe("revoking a collaborator", () => {
  it("denies the revoked collaborator on a session that was already warm", async () => {
    const app = createApp({
      store: new MemoryStore(),
      clock: new ManualClock(Date.UTC(2026, 0, 1, 9, 0, 0)),
      ids: sequentialIds(),
    });
    const call = async (method: string, path: string, token?: string, body?: unknown): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      return app.request(path, { method, headers, body: body === undefined ? null : JSON.stringify(body) });
    };
    const login = async (username: string): Promise<string> => {
      expect((await call("POST", "/users", undefined, { username, password: PASSWORD })).status).toBe(201);
      const res = await call("POST", "/sessions", undefined, { username, password: PASSWORD });
      expect(res.status).toBe(201);
      return ((await res.json()) as { token: string }).token;
    };

    // Alice owns alice/forge; Bob is an admin collaborator on it.
    const alice = await login("alice");
    const bob = await login("bob");
    expect((await call("POST", "/repos", alice, { name: "forge", visibility: "public" })).status).toBe(201);
    expect((await call("PUT", COLLABORATOR, alice, { role: "admin" })).status).toBe(201);

    // Bob's session touches the repository before the revoke.
    expect((await call("GET", REPO, bob)).status).toBe(200);

    const revoke = await call("DELETE", COLLABORATOR, alice);
    if (await isHonoDefaultNotFound(revoke)) {
      report(`alice DELETE ${COLLABORATOR} -> 404 Not Found (no such route)`);
      throw new Error(`${NOT_APPLICABLE} revoke route absent`);
    }
    report(`alice DELETE ${COLLABORATOR} -> ${revoke.status} (expected 204)`);
    expect(revoke.status).toBe(204);

    // Same session as the warm-up.
    const attempt = await call("DELETE", REPO, bob);
    report(`bob DELETE ${REPO} -> ${attempt.status} (expected 403)`);
    expect(attempt.status).toBe(403);

    const after = await call("GET", REPO, alice);
    report(`alice GET ${REPO} -> ${after.status} (expected 200)`);
    expect(after.status).toBe(200);
  });
});
