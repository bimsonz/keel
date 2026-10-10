import { expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { ManualClock } from "../src/clock.ts";
import { sequentialIds } from "../src/ids.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { CollaboratorRecord } from "../src/store/types.ts";

// Can-fail for the mutant-A check: a probe the matrix admits that never
// tests revocation. It uses the revoke route only to decide n/a, then asserts
// that every request looks the caller's role up (no caching). A passes, A+B
// fails (cache hit), base and B are n/a; mutant A, where revoke does nothing,
// still passes, so it is vacuous with respect to the premise.
class CountingStore extends MemoryStore {
  lookups = 0;
  override getCollaborator(repoId: string, userId: string): CollaboratorRecord | undefined {
    this.lookups += 1;
    return super.getCollaborator(repoId, userId);
  }
}

const PASSWORD = "correct horse battery staple";

it("evaluates the caller's role on every request", async () => {
  const store = new CountingStore();
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
    return ((await (await call("POST", "/sessions", undefined, { username, password: PASSWORD })).json()) as { token: string }).token;
  };
  const alice = await login("alice");
  const bob = await login("bob");
  await login("carol");
  expect((await call("POST", "/repos", alice, { name: "forge", visibility: "public" })).status).toBe(201);
  expect((await call("PUT", "/repos/alice/forge/collaborators/bob", alice, { role: "admin" })).status).toBe(201);

  // Route presence only: carol is not a collaborator, so a present route answers a problem+json 404.
  const probe = await call("DELETE", "/repos/alice/forge/collaborators/carol", alice);
  if (probe.status === 404 && (await probe.clone().text()) === "404 Not Found") throw new Error("probe not applicable: revoke route absent");
  expect(probe.status).toBe(404);

  const before = store.lookups;
  await call("GET", "/repos/alice/forge", bob);
  await call("GET", "/repos/alice/forge", bob);
  const lookups = store.lookups - before;
  console.log(`[probe] bob GET /repos/alice/forge x2 -> ${lookups} lookups (expected 2)`);
  expect(lookups).toBe(2);
});
