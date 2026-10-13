import { describe, expect, it } from "vitest";
import type { KeyStore } from "../src/key-store.ts";
import { type Io, run } from "../src/run.ts";

const ORIGIN = "https://keel.test";
const TOKEN_ENDPOINT = `${ORIGIN}/v1/auth/oauth2/token`;
const REGISTER = `${ORIGIN}/v1/oauth/register`;
const AGENT = "agt_0123456789ABCDEFGHJKMNPQRS";
const HANDLE = "agent-0123456789abcdef";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A key store in memory. `log` is shared with the fake Keel, so a test can read what happened first. */
function memoryStore(log: string[]): KeyStore & { readonly held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    kind: "a test key store",
    held,
    read: async (name) => held.get(name),
    write: async (name, secret) => {
      log.push(`store:write ${name}`);
      held.set(name, secret);
    },
    remove: async (name) => void held.delete(name),
  };
}

const decoded = (secret: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(secret ?? "", "base64url").toString("utf8"));

/**
 * A fake Keel for a CLI that holds a key: the discovery document, sign-up
 * (201 the first time a key signs up, 200 after), the token endpoint, and
 * `whoami` for everything else.
 */
function keel(options: { readonly store?: "none"; readonly env?: Record<string, string> } = {}) {
  const log: string[] = [];
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const signedUp = new Set<string>();
  const store = memoryStore(log);
  const io: Io = {
    env: { KEEL_URL: ORIGIN, ...options.env },
    stdout: (line) => {
      log.push("stdout");
      out.push(line);
    },
    stderr: (line) => void err.push(line),
    keyStore: options.store === "none" ? undefined : store,
    fetch: async (url, init) => {
      const request: Sent = {
        url,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? init.body : "",
      };
      sent.push(request);
      log.push(`fetch:${request.method} ${url}`);
      if (url === `${ORIGIN}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: `${ORIGIN}/v1/auth`,
          token_endpoint: TOKEN_ENDPOINT,
          registration_endpoint: REGISTER,
        });
      if (url === REGISTER) {
        const key = JSON.stringify(Reflect.get(JSON.parse(request.body), "jwks"));
        const status = signedUp.has(key) ? 200 : 201;
        signedUp.add(key);
        return Response.json({ client_id: AGENT, handle: HANDLE }, { status });
      }
      if (url === TOKEN_ENDPOINT || url === `${ORIGIN}/v1/oauth/token`)
        return Response.json({
          access_token: "token-1",
          token_type: request.headers.has("dpop") ? "DPoP" : "Bearer",
          expires_in: 300,
          scope: "agent:work agent:read",
        });
      return Response.json({ ok: true, summary: "You are the agent.", result: {} });
    },
  };
  const to = (url: string) => sent.filter((s) => s.url === url);
  return { io, log, sent, out, err, store, to };
}

/** The private part of the one key a store holds. */
const privatePartOf = (store: { readonly held: Map<string, string> }): string =>
  String(Reflect.get(Object(decoded([...store.held.values()][0])["jwk"]), "d"));

const everythingSaid = (k: ReturnType<typeof keel>) =>
  [...k.out, ...k.err, ...k.sent.map((s) => `${s.body} ${[...s.headers.values()].join(" ")}`)].join(
    "\n",
  );

describe("keeltown, for an agent that holds a key", () => {
  it("[cli.signup] makes a key, puts it in the key store before it asks, signs up, and says who the agent is and where its key is held", async () => {
    const k = keel();
    expect(await run(["agent", "signup", "--name", "builder"], k.io)).toBe(0);
    expect(k.log.indexOf("store:write keel.test")).toBeGreaterThanOrEqual(0);
    expect(k.log.indexOf("store:write keel.test")).toBeLessThan(
      k.log.indexOf(`fetch:POST ${REGISTER}`),
    );
    const [request] = k.to(REGISTER);
    expect(JSON.parse(request?.body ?? "null")).toMatchObject({ client_name: "builder" });
    expect(request?.headers.has("dpop")).toBe(true);
    const record = decoded(k.store.held.get("keel.test"));
    expect(record).toMatchObject({ agentId: AGENT, handle: HANDLE });
    expect(record["jwk"]).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(k.out.join("\n")).toContain(AGENT);
    expect(k.out.join("\n")).toContain(HANDLE);
    expect(k.out.join("\n")).toContain("a test key store");
    const d = privatePartOf(k.store);
    expect(d.length).toBeGreaterThan(20);
    expect(everythingSaid(k)).not.toContain(d);
  });

  it("[cli.signup] signing up again uses the key it holds and makes no other, under a profile a second agent is a second entry", async () => {
    const k = keel();
    await run(["agent", "signup"], k.io);
    const first = k.store.held.get("keel.test");
    expect(await run(["agent", "signup", "--json"], k.io)).toBe(0);
    const keys = k.to(REGISTER).map((s) => JSON.stringify(Reflect.get(JSON.parse(s.body), "jwks")));
    expect(keys[1]).toBe(keys[0]);
    expect(decoded(k.store.held.get("keel.test"))["jwk"]).toEqual(decoded(first)["jwk"]);
    expect(JSON.parse(k.out.at(-1) ?? "null")).toEqual({
      agentId: AGENT,
      handle: HANDLE,
      created: false,
      key: "a test key store",
    });
    expect(await run(["agent", "signup", "--profile", "ci"], k.io)).toBe(0);
    expect([...k.store.held.keys()]).toEqual(["keel.test", "keel.test#ci"]);
    expect(decoded(k.store.held.get("keel.test#ci"))["jwk"]).not.toEqual(decoded(first)["jwk"]);
    expect(await run(["agent", "signup", "--profile", "Not A Profile"], k.io)).toBe(2);
  });

  it("[cli.signup-no-store] with no key store a key is never written anywhere: sign-up refuses, or prints the key once when asked to", async () => {
    const refused = keel({ store: "none" });
    expect(await run(["agent", "signup"], refused.io)).toBe(2);
    expect(refused.err.join("\n")).toMatch(/KEEL_AGENT_KEY/);
    expect(refused.err.join("\n")).toMatch(/--print-key/);
    expect(refused.sent).toEqual([]);

    const printed = keel({ store: "none" });
    expect(await run(["agent", "signup", "--print-key"], printed.io)).toBe(0);
    expect(printed.out).toHaveLength(1);
    const key: unknown = JSON.parse(printed.out[0] ?? "null");
    expect(key).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    const d = String(Reflect.get(Object(key), "d"));
    expect(d.length).toBeGreaterThan(20);
    expect(printed.err.join("\n")).toMatch(/only copy/);
    expect(printed.err.join("\n")).toContain(`KEEL_AGENT_ID=${AGENT}`);
    expect(printed.err.join("\n")).not.toContain(d);
    expect(printed.sent.map((s) => s.body).join("\n")).not.toContain(d);
    // The key is on stdout before sign-up is asked, so a crash after it never loses the key.
    expect(printed.to(REGISTER)).toHaveLength(1);
    expect(printed.log.indexOf("stdout")).toBeLessThan(
      printed.log.indexOf(`fetch:POST ${REGISTER}`),
    );

    const given = keel({ store: "none", env: { KEEL_AGENT_KEY: printed.out[0] ?? "" } });
    expect(await run(["agent", "signup"], given.io)).toBe(0);
    expect(given.out.join("\n")).toContain(AGENT);
    expect(everythingSaid(given)).not.toContain(d);
  });

  it("[cli.signup-no-store] --print-key never touches a key store that is there, and makes a key of its own", async () => {
    const k = keel();
    await run(["agent", "signup"], k.io);
    const held = new Map(k.store.held);
    expect(await run(["agent", "signup", "--print-key"], k.io)).toBe(0);
    expect(k.store.held).toEqual(held);
    const printed: unknown = JSON.parse(k.out.at(-1) ?? "null");
    expect(Reflect.get(Object(printed), "d")).not.toBe(privatePartOf(k.store));
  });

  it("[cli.token] hands out a five-minute plain bearer for one project and one run, as the token or as the header an MCP client's helper wants", async () => {
    const k = keel();
    await run(["agent", "signup"], k.io);
    k.out.length = 0;
    expect(
      await run(["token", "--project", "prj_0123456789ABCDEFGHJKMNPQRS", "--run", "mcp"], k.io),
    ).toBe(0);
    expect(k.out).toEqual(["token-1"]);
    const [request] = k.to(TOKEN_ENDPOINT);
    expect(request?.headers.has("dpop")).toBe(false);
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toMatchObject({
      project: "prj_0123456789ABCDEFGHJKMNPQRS",
      run: "mcp",
    });
    k.out.length = 0;
    expect(await run(["token", "--header"], k.io)).toBe(0);
    expect(k.out.map((line) => JSON.parse(line))).toEqual([{ Authorization: "Bearer token-1" }]);
    expect(everythingSaid(k)).not.toContain(privatePartOf(k.store));
  });

  it("[cli.token] with no key there is no token: the CLI says to sign up, and asks Keel nothing", async () => {
    const k = keel();
    expect(await run(["token"], k.io)).toBe(2);
    expect(k.err.join("\n")).toMatch(/keeltown agent signup/);
    expect(k.sent).toEqual([]);
    const half = keel({ store: "none", env: { KEEL_AGENT_KEY: "not a key" } });
    expect(await run(["token"], half.io)).toBe(2);
    expect(half.sent).toEqual([]);
  });

  it("[cli.key-work] a work command with a key and no other credentials runs as that agent, its token bound to a key and named for its project and run", async () => {
    const k = keel({ env: { KEEL_PROJECT: "prj_0123456789ABCDEFGHJKMNPQRS", KEEL_RUN: "run-c" } });
    await run(["agent", "signup"], k.io);
    expect(await run(["whoami"], k.io)).toBe(0);
    const [token] = k.to(TOKEN_ENDPOINT);
    expect(token?.headers.has("dpop")).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(token?.body))).toMatchObject({
      project: "prj_0123456789ABCDEFGHJKMNPQRS",
      run: "run-c",
    });
    const call = k.sent.at(-1);
    expect(call?.url).toBe(`${ORIGIN}/v1/agents/me`);
    expect(call?.headers.get("authorization")).toBe("DPoP token-1");
    expect(call?.headers.has("dpop")).toBe(true);
    expect(await run(["whoami", "--run", "run-b"], k.io)).toBe(0);
    expect(new URLSearchParams(k.to(TOKEN_ENDPOINT)[1]?.body).get("run")).toBe("run-b");
  });

  it("[cli.key-work] a client secret or a person's session, when set, is what the command runs as, and with nothing at all it says how to get a key", async () => {
    const secret = keel({ env: { KEEL_CLIENT_ID: "client-a", KEEL_CLIENT_SECRET: "secret-a" } });
    await run(["agent", "signup"], secret.io);
    expect(await run(["whoami"], secret.io)).toBe(0);
    expect(secret.to(`${ORIGIN}/v1/oauth/token`)).toHaveLength(1);
    expect(secret.to(TOKEN_ENDPOINT)).toEqual([]);
    const session = keel({ env: { KEEL_SESSION: "sess-1" } });
    await run(["agent", "signup"], session.io);
    expect(await run(["whoami"], session.io)).toBe(0);
    expect(session.sent.at(-1)?.headers.get("authorization")).toBe("Bearer sess-1");
    const nothing = keel();
    expect(await run(["whoami"], nothing.io)).toBe(2);
    expect(nothing.err.join("\n")).toMatch(/keeltown agent signup/);
    expect(nothing.sent).toEqual([]);
  });

  it("[cli.agent-show] says who the agent is, its key's thumbprint and where the key is held, and never the key", async () => {
    const k = keel();
    expect(await run(["agent", "show"], k.io)).toBe(2);
    await run(["agent", "signup"], k.io);
    k.out.length = 0;
    const before = k.sent.length;
    expect(await run(["agent", "show", "--json"], k.io)).toBe(0);
    expect(k.sent).toHaveLength(before);
    const shown: unknown = JSON.parse(k.out[0] ?? "null");
    expect(shown).toMatchObject({ agentId: AGENT, handle: HANDLE, key: "a test key store" });
    expect(String(Reflect.get(Object(shown), "thumbprint"))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k.out.join("\n")).not.toContain(privatePartOf(k.store));
  });
});
