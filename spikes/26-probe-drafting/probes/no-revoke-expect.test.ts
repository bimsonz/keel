import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { ManualClock } from "../src/clock.ts";
import { sequentialIds } from "../src/ids.ts";
import { MemoryStore } from "../src/store/memory.ts";

const PASSWORD = "correct horse battery staple";

async function forge(store = new MemoryStore()) {
  const app = createApp({ store, clock: new ManualClock(Date.UTC(2026, 0, 1)), ids: sequentialIds() });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  const login = async (username: string) => {
    expect((await call("POST", "/users", undefined, { username, password: PASSWORD })).status).toBe(201);
    const res = await call("POST", "/sessions", undefined, { username, password: PASSWORD });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  };
  const alice = await login("alice");
  const bob = await login("bob");
  expect((await call("POST", "/repos", alice, { name: "forge", visibility: "public" })).status).toBe(201);
  expect((await call("PUT", "/repos/alice/forge/collaborators/bob", alice, { role: "admin" })).status).toBe(201);
  return { call, alice, bob, store };
}

async function routeAbsent(res: Response): Promise<boolean> {
  return res.status === 404 && (res.headers.get("content-type") ?? "").startsWith("text/plain") && (await res.clone().text()) === "404 Not Found";
}

// Can-fail for the static flag: the revoke DELETE's own outcome is never
// asserted (it is only checked for absence). It still fails against mutant A,
// so the flag is a flag, not the gate.
describe("revocation", () => {
  it("denies a warm session after revoke", async () => {
    const { call, alice, bob } = await forge();
    expect((await call("GET", "/repos/alice/forge", bob)).status).toBe(200);
    const revoke = await call("DELETE", "/repos/alice/forge/collaborators/bob", alice);
    if (await routeAbsent(revoke)) throw new Error("probe not applicable: revoke route absent");
    console.log(`[probe] alice DELETE /repos/alice/forge/collaborators/bob -> ${revoke.status}`);
    const attempt = await call("DELETE", "/repos/alice/forge", bob);
    console.log(`[probe] bob DELETE /repos/alice/forge -> ${attempt.status} (expected 403)`);
    expect(attempt.status).toBe(403);
  });
});
