import { generateAgentKey } from "@keeltown/sdk";
import { describe, expect, it } from "vitest";
import { encodeEntry } from "../src/agent-key.ts";
import { run } from "../src/run.ts";
import {
  AGENT_TOKEN,
  CODE,
  DEVICE,
  decoded,
  keel,
  ORIGIN,
  PAGE,
  POLL,
  SESSION,
  SIGN_OUT,
  TOKEN,
  USER_CODE,
} from "./person.ts";

const authorization = (sent: { readonly headers: Headers } | undefined) =>
  sent?.headers.get("authorization") ?? "";

describe("keeltown login", () => {
  it("[cli.login] asks for a code as keeltown, names the page to open, polls no faster than Keel said, and keeps the sign-in in the key store", async () => {
    const k = keel({ polls: ["pending", "pending", "token"] });
    expect(await run(["login"], k.io)).toBe(0);
    const [code] = k.to(CODE);
    expect(code?.method).toBe("POST");
    expect(JSON.parse(code?.body ?? "null")).toEqual({ client_id: "keeltown" });
    expect(k.err.join("\n")).toContain(PAGE);
    expect(k.err.join("\n")).toContain(USER_CODE);
    const polls = k.to(POLL);
    expect(polls.map((poll) => JSON.parse(poll.body))).toEqual(
      Array.from({ length: 3 }, () => ({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: DEVICE,
        client_id: "keeltown",
      })),
    );
    // Five seconds is the interval the code's answer named.
    expect(polls.map((poll) => poll.at - (code?.at ?? 0))).toEqual([5000, 10_000, 15_000]);
    expect(authorization(k.to(SESSION)[0])).toBe(`Bearer ${TOKEN}`);
    expect(decoded(k.signIns.held.get("keel.test"))).toEqual({
      token: TOKEN,
      handle: "ada",
      userId: "usr_ada",
    });
    expect(k.out).toEqual(["Signed in as ada. The sign-in is held in a test key store."]);
  });

  it("[cli.login-quiet] says neither the token nor the device code, as a line or as JSON", async () => {
    const plain = keel();
    expect(await run(["login"], plain.io)).toBe(0);
    const json = keel();
    expect(await run(["login", "--json"], json.io)).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toEqual({
      handle: "ada",
      userId: "usr_ada",
      signIn: "a test key store",
    });
    for (const said of [plain.said(), json.said()]) {
      expect(said).not.toContain(TOKEN);
      expect(said).not.toContain(DEVICE);
    }
  });

  it("[cli.login-slow-down] waits five seconds longer between polls after Keel says to slow down", async () => {
    const k = keel({ polls: ["pending", "slow_down", "pending", "token"] });
    expect(await run(["login"], k.io)).toBe(0);
    expect(k.slept).toEqual([5000, 5000, 10_000, 10_000]);
  });

  it("[cli.login-denied] a sign-in refused on Keel ends at once: exit 1, nothing held", async () => {
    const k = keel({ polls: ["pending", "denied"] });
    expect(await run(["login"], k.io)).toBe(1);
    expect(k.to(POLL)).toHaveLength(2);
    expect(k.err.join("\n")).toMatch(/refused/);
    expect(k.signIns.held.size).toBe(0);
    expect(k.out).toEqual([]);
  });

  it("[cli.login-expired] a code Keel says ran out ends the wait: exit 1, nothing held", async () => {
    const k = keel({ polls: ["pending", "expired"] });
    expect(await run(["login"], k.io)).toBe(1);
    expect(k.to(POLL)).toHaveLength(2);
    expect(k.err.join("\n")).toMatch(/ran out/);
    expect(k.signIns.held.size).toBe(0);
  });

  it("[cli.login-deadline] a code nobody approves is asked about only for as long as Keel said it lasts", async () => {
    const k = keel({ polls: ["pending"], expiresIn: 60 });
    expect(await run(["login"], k.io)).toBe(1);
    const [code] = k.to(CODE);
    const waited = k.to(POLL).map((poll) => poll.at - (code?.at ?? 0));
    expect(waited.length).toBeGreaterThan(0);
    expect(Math.max(...waited)).toBeLessThanOrEqual(60_000);
    expect(k.err.join("\n")).toMatch(/ran out/);
    expect(k.signIns.held.size).toBe(0);
  });

  it("[cli.login-no-store] with no key store it refuses before asking Keel, and --print-token prints the token alone, once, and keeps nothing", async () => {
    const none = keel({ store: "none" });
    expect(await run(["login"], none.io)).toBe(2);
    expect(none.sent).toEqual([]);
    expect(none.err.join("\n")).toContain("--print-token");

    const printed = keel({ store: "none" });
    expect(await run(["login", "--print-token"], printed.io)).toBe(0);
    expect(printed.out).toEqual([TOKEN]);
    expect(printed.err.join("\n")).toContain("KEEL_SESSION");
    expect(printed.err.join("\n")).toContain("ada");
    expect(printed.err.join("\n")).not.toContain(TOKEN);

    const stored = keel();
    expect(await run(["login", "--print-token"], stored.io)).toBe(0);
    expect(stored.signIns.held.size).toBe(0);
  });

  it("[cli.login-own-entry] a sign-in is kept in its own store: the agent's key under the same name is as it was", async () => {
    const k = keel();
    k.keyStore.held.set("keel.test", "the-agents-entry");
    expect(await run(["login"], k.io)).toBe(0);
    expect([...k.keyStore.held]).toEqual([["keel.test", "the-agents-entry"]]);
    expect([...k.signIns.held.keys()]).toEqual(["keel.test"]);
    expect(await run(["login", "--profile", "work"], k.io)).toBe(0);
    expect([...k.signIns.held.keys()]).toEqual(["keel.test", "keel.test#work"]);
    expect([...k.keyStore.held]).toEqual([["keel.test", "the-agents-entry"]]);
  });
});

describe("keeltown logout", () => {
  it("[cli.logout] ends the session at Keel with its own bearer, then holds nothing", async () => {
    const k = keel();
    await run(["login"], k.io);
    expect(await run(["logout"], k.io)).toBe(0);
    const [ended] = k.to(SIGN_OUT);
    expect(ended?.method).toBe("POST");
    expect(authorization(ended)).toBe(`Bearer ${TOKEN}`);
    expect(k.signIns.held.size).toBe(0);
    expect(k.out.at(-1)).toMatch(/Signed out ada/);
    expect(k.said()).not.toContain(TOKEN);
  });

  it("[cli.logout-kept] a sign-in Keel could not be told to end stays held, so it can be ended later", async () => {
    const down = keel({ signOut: () => Response.json({ code: "internal" }, { status: 503 }) });
    await run(["login"], down.io);
    expect(await run(["logout"], down.io)).toBe(1);
    expect([...down.signIns.held.keys()]).toEqual(["keel.test"]);
    expect(down.err.join("\n")).toMatch(/still held/);

    const unreachable = keel({
      signOut: () => {
        throw new TypeError("fetch failed");
      },
    });
    await run(["login"], unreachable.io);
    expect(await run(["logout"], unreachable.io)).toBe(1);
    expect([...unreachable.signIns.held.keys()]).toEqual(["keel.test"]);
  });

  it("[cli.logout-gone] a session Keel no longer knows is forgotten here too, and with nothing held there is nothing to ask", async () => {
    const gone = keel({ signOut: () => Response.json({ code: "x" }, { status: 401 }) });
    await run(["login"], gone.io);
    expect(await run(["logout"], gone.io)).toBe(0);
    expect(gone.signIns.held.size).toBe(0);

    const nobody = keel();
    expect(await run(["logout"], nobody.io)).toBe(2);
    expect(nobody.sent).toEqual([]);
  });
});

describe("keeltown, for a person signed in on this machine", () => {
  it("[cli.login-client] with no agent's credential a command runs as the person signed in", async () => {
    const k = keel();
    await run(["login"], k.io);
    const before = k.sent.length;
    expect(await run(["whoami"], k.io)).toBe(0);
    const asked = k.sent.slice(before);
    expect(asked.map(authorization)).toEqual([`Bearer ${TOKEN}`]);
    expect(asked[0]?.url.startsWith(`${ORIGIN}/v1/`)).toBe(true);
    // `whoami` as a person reads the person's record: an agent's is refused to them.
    expect(asked[0]?.url).toBe(`${ORIGIN}/v1/users/me`);

    const nobody = keel();
    expect(await run(["whoami"], nobody.io)).toBe(2);
    expect(nobody.err.join("\n")).toContain("keeltown login");
    expect(nobody.sent).toEqual([]);
  });

  it("[cli.login-key-first] an agent's key on the machine still wins over a sign-in", async () => {
    const { privateJwk } = await generateAgentKey();
    const k = keel({
      env: {
        KEEL_AGENT_KEY: JSON.stringify(privateJwk),
        KEEL_AGENT_ID: "agt_0123456789ABCDEFGHJKMNPQRS",
      },
    });
    await run(["login"], k.io);
    const before = k.sent.length;
    expect(await run(["whoami"], k.io)).toBe(0);
    const asked = k.sent.slice(before).at(-1);
    expect(authorization(asked)).toContain(AGENT_TOKEN);
    expect(authorization(asked)).not.toContain(TOKEN);
  });

  it("[cli.project-invite-person] project invite is the person's alone: with an agent's key or secret held and nobody signed in, it says to log in and asks Keel nothing", async () => {
    const invite = ["project", "invite", "--project", "prj_1", "--agent", "agent-1x443jkgfjjzbqj5"];
    const { privateJwk } = await generateAgentKey();
    const key = keel();
    key.keyStore.held.set(
      "keel.test",
      encodeEntry({ jwk: privateJwk, agentId: "agt_0123456789ABCDEFGHJKMNPQRS" }),
    );
    const secret = keel({ env: { KEEL_CLIENT_ID: "client-a", KEEL_CLIENT_SECRET: "secret-a" } });
    expect(await Promise.all([key, secret].map((k) => run(invite, k.io)))).toEqual([2, 2]);
    for (const k of [key, secret]) {
      expect(k.err).toHaveLength(1);
      expect(k.err[0]).toMatch(/a person's move.*`keeltown login`.*passkey/);
      expect(k.sent).toEqual([]);
      expect(k.out).toEqual([]);
    }
  });
});
