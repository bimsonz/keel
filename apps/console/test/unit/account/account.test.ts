import { describe, expect, it } from "vitest";
import { NotOpen, Refused, createAccount } from "../../../src/account/account.ts";
import { type Identity, createIdentity } from "../../fixtures/identity/standIn.ts";

const ORIGIN = "https://keel.example";

interface Cookie {
  value: string;
  httpOnly: boolean;
  sameSite: string;
}

/**
 * A browser's part in a request: it keeps the cookies it is given and sends them back, and it says which
 * page is asking. What the page's own code put on a request is kept apart from what the browser added.
 */
function browser(
  identity: Pick<Identity, "handle">,
  origin = ORIGIN,
  jar = new Map<string, Cookie>(),
) {
  const fromThePage: Request[] = [];
  const serve: typeof fetch = async (input, init) => {
    const asked = new Request(input, init);
    fromThePage.push(asked.clone());
    const headers = new Headers(asked.headers);
    if (jar.size > 0)
      headers.set("cookie", [...jar].map(([name, cookie]) => `${name}=${cookie.value}`).join("; "));
    headers.set("origin", origin);
    const response = await identity.handle(new Request(asked, { headers }));
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      const has = (attribute: string) =>
        attributes.find((given) => given.toLowerCase().startsWith(attribute));
      if (value === "" || has("max-age=0") !== undefined) jar.delete(name);
      else
        jar.set(name, {
          value,
          httpOnly: has("httponly") !== undefined,
          sameSite: has("samesite=")?.slice("samesite=".length) ?? "",
        });
    }
    return response;
  };
  return { serve, jar, fromThePage };
}

async function signedUp(email = "ada@example.com") {
  const identity = createIdentity(ORIGIN);
  const tab = browser(identity);
  const account = createAccount({ origin: ORIGIN, fetch: tab.serve });
  await account.sendCode(email);
  const code = identity.outbox.at(-1)?.otp ?? "";
  const who = await account.signInWithCode(email, code);
  return { identity, tab, account, who };
}

/** The session's token, as the cookie carries it: what must never come back out of this module. */
function tokenIn(jar: Map<string, Cookie>): string {
  const session = [...jar].find(([name]) => name.endsWith("session_token"))?.[1];
  return decodeURIComponent(session?.value ?? "").split(".")[0] ?? "";
}

describe("who the page is, to Keel", () => {
  it("[account.signup] signs a new address up and in with a code sent to it, and the session is a cookie the page cannot read", async () => {
    const identity = createIdentity(ORIGIN);
    const tab = browser(identity);
    const account = createAccount({ origin: ORIGIN, fetch: tab.serve });
    expect(await account.who()).toBeNull();
    await account.sendCode("ada@example.com");
    expect(identity.outbox).toHaveLength(1);
    const who = await account.signInWithCode("ada@example.com", identity.outbox[0]?.otp ?? "");
    expect(who).toEqual({ id: who.id, email: "ada@example.com", name: "" });
    expect(await account.who()).toEqual(who);
    const session = [...tab.jar].filter(([name]) => name.endsWith("session_token"));
    expect(session).toHaveLength(1);
    expect(session[0]?.[1]).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    // Every request went to Keel's identity, on the page's own origin.
    expect(identity.requests.every((request) => request.url.startsWith(`${ORIGIN}/v1/auth/`))).toBe(
      true,
    );
  });

  it("[account.wrong-code] is refused with a code that was not the one sent, and no session is made", async () => {
    const identity = createIdentity(ORIGIN);
    const tab = browser(identity);
    const account = createAccount({ origin: ORIGIN, fetch: tab.serve });
    await account.sendCode("ada@example.com");
    await expect(account.signInWithCode("ada@example.com", "000000")).rejects.toThrow(Refused);
    expect(await account.who()).toBeNull();
    expect([...tab.jar.keys()].filter((name) => name.endsWith("session_token"))).toEqual([]);
  });

  it("[account.no-token] gives a page nothing that holds the session's token, though Keel's answers carry it", async () => {
    const { tab, account, who } = await signedUp();
    const token = tokenIn(tab.jar);
    expect(token.length).toBeGreaterThan(20);
    // Keel's own answer to "who am I" has the token in it: that is why nothing is handed on as it came.
    const raw = await tab.serve(`${ORIGIN}/v1/auth/get-session`);
    expect(await raw.text()).toContain(token);
    expect(JSON.stringify([who, await account.who()])).not.toContain(token);
  });

  it("[account.page-sends-nothing] puts no credential of its own on a request, signed in or not", async () => {
    const { tab, account } = await signedUp();
    await account.who();
    await account.signOut();
    await account.who();
    expect(tab.fromThePage.length).toBeGreaterThan(4);
    expect(
      tab.fromThePage.filter(
        (request) => request.headers.has("authorization") || request.headers.has("cookie"),
      ),
    ).toEqual([]);
  });

  it("[account.sign-out] ends the session", async () => {
    const { tab, account } = await signedUp();
    await account.signOut();
    expect(await account.who()).toBeNull();
    expect([...tab.jar.keys()].filter((name) => name.endsWith("session_token"))).toEqual([]);
  });

  it("[account.cross-site] is refused when another site's page makes the same call with the user's cookies", async () => {
    const { identity, tab, account } = await signedUp();
    // The same cookies, sent by a browser on behalf of a page somewhere else.
    const elsewhere = browser(identity, "https://elsewhere.example", new Map(tab.jar));
    const forged = createAccount({ origin: ORIGIN, fetch: elsewhere.serve });
    await expect(forged.signOut()).rejects.toThrow(Refused);
    expect(await account.who()).not.toBeNull();
  });

  it("[account.not-open] says signing in is not open where Keel serves no identity, and takes nobody for a visitor", async () => {
    const closed = browser({
      handle: () => Promise.resolve(new Response("Not found", { status: 404 })),
    });
    const account = createAccount({ origin: ORIGIN, fetch: closed.serve });
    await expect(account.who()).rejects.toThrow(NotOpen);
  });

  it("[account.handle] takes a handle that is free, once, and it is then the user's", async () => {
    const { account, who } = await signedUp();
    expect(who.handle).toBeUndefined();
    expect(await account.handleIsFree("ada")).toBe(true);
    await account.chooseHandle("ada");
    expect((await account.who())?.handle).toBe("ada");
    expect(await account.handleIsFree("ada")).toBe(false);
  });

  it("[account.device] approves a code a terminal is showing, for the user signed in here, and only after claiming it", async () => {
    const { identity, tab, account, who } = await signedUp();
    const post = (path: string, body: unknown) =>
      identity.handle(
        new Request(`${ORIGIN}/v1/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    // The terminal's part, as `keeltown login` plays it.
    const issued: { device_code: string; user_code: string; verification_uri: string } = await (
      await post("/device/code", { client_id: "keeltown" })
    ).json();
    expect(issued.verification_uri).toBe(`${ORIGIN}/device`);
    const poll = () =>
      post("/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: issued.device_code,
        client_id: "keeltown",
      });
    expect((await poll()).status).toBe(400);
    await expect(account.approveDevice(issued.user_code)).rejects.toThrow(Refused);
    await account.claimDevice(issued.user_code);
    await account.approveDevice(issued.user_code);
    // The terminal now holds a session of the same user. The page was given none of it.
    let granted = await poll();
    if (granted.status === 400) {
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      granted = await poll();
    }
    const grant: { access_token?: string } = await granted.json();
    expect(typeof grant.access_token).toBe("string");
    const asTerminal = await identity.handle(
      new Request(`${ORIGIN}/v1/auth/get-session`, {
        headers: { authorization: `Bearer ${grant.access_token ?? ""}` },
      }),
    );
    const session: { user?: { id: string } } = await asTerminal.json();
    expect(session.user?.id).toBe(who.id);
    expect(tab.fromThePage.some((request) => request.headers.has("authorization"))).toBe(false);
  }, 20_000);
});
