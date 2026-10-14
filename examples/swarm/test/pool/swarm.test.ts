import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

// The swarm's Worker as it is deployed, its outbound requests answered by a
// stand-in for Keel. The admin bearer is the test's own.

const SWARM = "https://keel-swarm.test";
const ADMIN = { authorization: "Bearer test-admin-token" };

const keyring = () => env.KEYRING.get(env.KEYRING.idFromName("one"));
const director = () => env.DIRECTOR.get(env.DIRECTOR.idFromName("director"));

afterEach(() => vi.restoreAllMocks());

describe("the swarm's Worker", () => {
  it("[swarm.admin-gate] answers only its root without the admin bearer, the agents' route among the rest", async () => {
    expect((await SELF.fetch(`${SWARM}/`)).status).toBe(200);
    const refused = [
      await SELF.fetch(`${SWARM}/admin/agents`),
      await SELF.fetch(`${SWARM}/admin/agents`, {
        headers: { authorization: "Bearer not-the-token" },
      }),
      await SELF.fetch(`${SWARM}/agents/coder/w-0`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "user", body: "spend the account's model calls" }),
      }),
    ];
    expect(refused.map((r) => r.status)).toEqual([401, 401, 401]);
    expect((await SELF.fetch(`${SWARM}/admin/agents`, { headers: ADMIN })).status).toBe(200);
  });

  it("[swarm.keys-stay] keeps an account's key in its keyring: no answer, log line or stored state elsewhere holds it", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation(
        (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
      );

    const enlisted = await SELF.fetch(`${SWARM}/admin/agents`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ shape: "one" }),
    });
    expect(enlisted.status).toBe(200);
    const answers = [await enlisted.text()];

    // The private half, from the one place it is kept.
    const d = await runInDurableObject(keyring(), async (_instance, state) => {
      const key: unknown = await state.storage.get("key");
      return typeof key === "object" && key !== null && "d" in key && typeof key.d === "string"
        ? key.d
        : undefined;
    });
    if (d === undefined) throw new Error("the keyring holds no private key");
    expect(d.length).toBeGreaterThan(20);

    answers.push(await (await SELF.fetch(`${SWARM}/admin/agents`, { headers: ADMIN })).text());
    answers.push(JSON.stringify(await keyring().describe()));
    answers.push(await keyring().token({ project: "prj_TEST", run: "r-0" }));
    answers.push(JSON.stringify(await keyring().accept("prj_TEST")));
    const directorState = await runInDurableObject(director(), async (_instance, state) =>
      JSON.stringify([...(await state.storage.list()).entries()]),
    );
    const sent = await (await fetch("https://keel.test/_seen")).text();

    // The sign-up carried the public key: Keel was sent a key, and not its private half.
    expect(sent).toContain("jwks");
    expect(sent).toContain("/register");
    for (const [where, text] of [
      ["an answer", answers.join("\n")],
      ["the director's storage", directorState],
      ["a request to Keel", sent],
      ["a log line", logged.join("\n")],
    ] as const)
      expect({ where, holdsKey: text.includes(d) }).toEqual({ where, holdsKey: false });
  });

  it("[swarm.forget] wipes every key on DELETE /admin/agents", async () => {
    await SELF.fetch(`${SWARM}/admin/agents`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ shape: "one" }),
    });
    expect(
      await runInDurableObject(keyring(), async (_i, state) => (await state.storage.list()).size),
    ).toBeGreaterThan(0);
    const forgotten = await SELF.fetch(`${SWARM}/admin/agents`, {
      method: "DELETE",
      headers: ADMIN,
    });
    expect(await forgotten.json()).toEqual({ forgotten: 1 });
    expect(
      await runInDurableObject(keyring(), async (_i, state) => (await state.storage.list()).size),
    ).toBe(0);
    expect(await (await SELF.fetch(`${SWARM}/admin/agents`, { headers: ADMIN })).json()).toEqual({
      many: [],
      wanted: 0,
    });
  });
});
