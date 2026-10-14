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

/** The bodies of the requests to `path` the stand-in Keel has been sent, oldest first. */
async function seen(path: string): Promise<string[]> {
  const sent: unknown = await (await fetch("https://keel.test/_seen")).json();
  if (!Array.isArray(sent)) throw new Error("the stand-in answers its requests as a list");
  return sent.flatMap((r: unknown) =>
    typeof r === "object" &&
    r !== null &&
    "url" in r &&
    "body" in r &&
    typeof r.url === "string" &&
    typeof r.body === "string" &&
    new URL(r.url).pathname === path
      ? [r.body]
      : [],
  );
}

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

  it("[swarm.mcp-door] mints a worker's token for Keel's MCP door, and for no other", async () => {
    await SELF.fetch(`${SWARM}/admin/agents`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ shape: "one" }),
    });
    const before = await seen("/token");
    await keyring().token({ project: "prj_MCP", run: "r-mcp" });
    const minted = (await seen("/token")).slice(before.length);
    expect(minted).toHaveLength(1);
    expect(new URLSearchParams(minted[0]).get("resource")).toBe("https://keel.test/mcp");
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
  // The one account signs up while a "many" sign-up is awaited, landing first
  // in one case and last in the other: the roster keeps both either way.
  for (const last of ["swarm-0", "swarm-one"] as const)
    it(`[swarm.roster-race] keeps both accounts on the roster when ${last}'s sign-up lands last`, async () => {
      await runInDurableObject(director(), async (_instance, state) => {
        await state.storage.deleteAlarm();
        await state.storage.put("roster", { many: [], wanted: 1 });
      });
      const signUp = (name: string) =>
        name === "swarm-0"
          ? runInDurableObject(director(), (instance) => instance.alarm())
          : director().enlist("one", 1);
      const first = last === "swarm-0" ? "swarm-one" : "swarm-0";
      const before = (await seen("/register")).length;
      await fetch(`https://keel.test/_hold?name=${last}`);
      try {
        const waiting = signUp(last);
        await vi.waitFor(async () => expect(await seen("/register")).toHaveLength(before + 1));
        await signUp(first);
        await fetch("https://keel.test/_release");
        await waiting;
      } finally {
        await fetch("https://keel.test/_release");
      }
      const roster = await director().roster();
      expect({ one: roster.one?.name, many: roster.many.map((m) => m.name) }).toEqual({
        one: "swarm-one",
        many: ["swarm-0"],
      });
    });
});
