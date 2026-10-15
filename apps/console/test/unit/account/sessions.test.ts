import { describe, expect, it } from "vitest";
import { type OwnSession, Refused, createAccount } from "../../../src/account/account.ts";
import { deviceOf, rowsOf } from "../../../src/account/sessions.ts";
import { type Identity, createIdentity } from "../../fixtures/identity/standIn.ts";
import { ORIGIN, browser, signedUp, tokenIn } from "./browser.ts";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";

/** Another browser of the same person's, which says what it is: signed in with a code sent to their address. */
async function alsoOn(identity: Identity, email: string, userAgent?: string) {
  const tab = browser(identity);
  const serve: typeof fetch = (input, init) => {
    const asked = new Request(input, init);
    if (userAgent !== undefined) asked.headers.set("user-agent", userAgent);
    return tab.serve(asked);
  };
  const account = createAccount({ origin: ORIGIN, fetch: serve });
  await account.sendCode(email);
  const who = await account.signInWithCode(email, identity.outbox.at(-1)?.otp ?? "");
  return { tab, account, who };
}

const session = (over: Partial<OwnSession>): OwnSession => ({
  id: "ses_1",
  current: false,
  signedInBy: "passkey",
  userAgent: CHROME_MAC,
  createdAt: "2026-10-12T09:15:00.000Z",
  lastUsedAt: "2026-10-13T16:40:00.000Z",
  ...over,
});

describe("a person's own sessions", () => {
  it("[sessions.device] says what a session's browser called itself, shortly where it is one it knows, and never guesses past that", () => {
    expect(deviceOf(CHROME_MAC)).toBe("Chrome on macOS");
    expect(deviceOf(FIREFOX_WINDOWS)).toBe("Firefox on Windows");
    // Each of these carries another's mark as well as its own: Edge has Chrome's, Android has Linux's, and an
    // iPhone's Safari has the Mac's.
    expect(
      deviceOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toBe("Edge on Windows");
    expect(
      deviceOf(
        "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
    expect(
      deviceOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    // Something that is no browser it knows is shown by its own first word, and nothing is made of the rest.
    expect(deviceOf("keeltown/0.4.1 node/24.1.0 darwin")).toBe("keeltown");
    expect(deviceOf("curl/8.7.1")).toBe("curl");
    // A session that sent nothing has named none: it is not called unknown, or a fault.
    expect(deviceOf(null)).toBe("A device that named no browser");
    expect(deviceOf("  ")).toBe("A device that named no browser");
  });

  it("[sessions.rows] words each session by how Keel says it was signed in and when, to the minute, a session with no way named plainly, in Keel's order", () => {
    const rows = rowsOf([
      session({ id: "ses_1" }),
      session({ id: "ses_3", signedInBy: "other", userAgent: null, current: true }),
      session({ id: "ses_2", signedInBy: "device", userAgent: "keeltown/0.4.1 node/24.1.0" }),
      session({ id: "ses_4", signedInBy: "email-otp", userAgent: FIREFOX_WINDOWS }),
      session({ id: "ses_5", signedInBy: "github" }),
    ]);
    expect(rows.map((row) => `${row.id} ${row.signedIn}`)).toEqual([
      "ses_1 Signed in with a passkey on 2026-10-12 at 09:15",
      "ses_3 Signed in on 2026-10-12 at 09:15",
      "ses_2 Signed in from a terminal on 2026-10-12 at 09:15",
      "ses_4 Signed in with an email code on 2026-10-12 at 09:15",
      "ses_5 Signed in with GitHub on 2026-10-12 at 09:15",
    ]);
    // Its last use is said to the day: Keel writes it once an hour, so no minute is claimed.
    expect(new Set(rows.map((row) => row.lastUsed))).toEqual(new Set(["2026-10-13"]));
    // The session asking is marked where Keel listed it, and is not moved to the top.
    expect(rows.map((row) => row.current)).toEqual([false, true, false, false, false]);
    expect(rows.map((row) => row.device)).toEqual([
      "Chrome on macOS",
      "A device that named no browser",
      "keeltown",
      "Firefox on Windows",
      "Chrome on macOS",
    ]);
    expect([rows[1]?.userAgent, rows[3]?.userAgent]).toEqual(["", FIREFOX_WINDOWS]);
  });

  it("[sessions.list] lists the reader's own sessions as Keel answers them, the one asking marked, and nobody else's", async () => {
    const identity = createIdentity(ORIGIN);
    const first = await alsoOn(identity, "ada@example.com", CHROME_MAC);
    const second = await alsoOn(identity, "ada@example.com", FIREFOX_WINDOWS);
    await alsoOn(identity, "grace@example.com", CHROME_MAC);
    const listed = await second.account.sessions();
    expect(
      new Set(listed.map((each) => `${each.userAgent} ${each.current} ${each.signedInBy}`)),
    ).toEqual(new Set([`${CHROME_MAC} false email-otp`, `${FIREFOX_WINDOWS} true email-otp`]));
    expect(listed).toHaveLength(2);
    // The same list, asked from the other browser, marks that one.
    expect((await first.account.sessions()).find((each) => each.current)?.userAgent).toBe(
      CHROME_MAC,
    );
    for (const each of listed) {
      expect(Number.isNaN(Date.parse(each.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(each.lastUsedAt))).toBe(false);
    }
    // A visitor has no sessions to list, and is refused as such.
    const nobody = createAccount({ origin: ORIGIN, fetch: browser(identity).serve });
    await expect(nobody.sessions()).rejects.toThrow(Refused);
  });

  it("[sessions.no-token] hands a page nothing of a session that signs anybody in: its id is its row's, and no token is in the list", async () => {
    const identity = createIdentity(ORIGIN);
    const first = await alsoOn(identity, "ada@example.com");
    const second = await alsoOn(identity, "ada@example.com", FIREFOX_WINDOWS);
    const said = JSON.stringify(await second.account.sessions());
    // Keel's own answer has none either: its list reads the columns it answers, and the token is not one.
    const raw = await (await second.tab.serve(`${ORIGIN}/v1/auth/sessions`)).text();
    for (const token of [tokenIn(first.tab.jar), tokenIn(second.tab.jar)]) {
      expect(token.length).toBeGreaterThan(20);
      expect(said).not.toContain(token);
      expect(raw).not.toContain(token);
    }
    // A browser that sent no description of itself is listed with none.
    expect(new Set((await second.account.sessions()).map((each) => each.userAgent))).toEqual(
      new Set([FIREFOX_WINDOWS, null]),
    );
  });

  it("[sessions.as-answered] hands on the fields of a session it knows and no other, and reads a way of signing in it does not know as no way named", async () => {
    const answered = {
      sessions: [
        {
          id: "ses_9",
          current: true,
          signedInBy: "magic-link",
          userAgent: "",
          createdAt: "2026-10-13T09:00:00.000Z",
          lastUsedAt: "2026-10-13T10:00:00.000Z",
          expiresAt: "2026-10-20T09:00:00.000Z",
          token: "a-token-no-page-may-hold",
        },
      ],
    };
    const account = createAccount({
      origin: ORIGIN,
      // oxlint-disable-next-line typescript/require-await -- fetch's own signature
      fetch: async () =>
        new Response(JSON.stringify(answered), { headers: { "content-type": "application/json" } }),
    });
    expect(await account.sessions()).toEqual([
      {
        id: "ses_9",
        current: true,
        signedInBy: "other",
        userAgent: null,
        createdAt: "2026-10-13T09:00:00.000Z",
        lastUsedAt: "2026-10-13T10:00:00.000Z",
      },
    ]);
  });

  it("[sessions.end] ends the one session named, which then signs nobody in, and leaves the one asking", async () => {
    const identity = createIdentity(ORIGIN);
    const first = await alsoOn(identity, "ada@example.com", CHROME_MAC);
    const second = await alsoOn(identity, "ada@example.com", FIREFOX_WINDOWS);
    const third = await alsoOn(identity, "ada@example.com", "curl/8.7.1");
    const other = (await second.account.sessions()).find((each) => each.userAgent === CHROME_MAC);
    await second.account.endSession(other?.id ?? "");
    expect(await first.account.who()).toBeNull();
    expect(await second.account.who()).toEqual(second.who);
    expect(await third.account.who()).toEqual(third.who);
    const left = (await second.account.sessions()).map((each) => each.userAgent);
    expect(new Set(left)).toEqual(new Set(["curl/8.7.1", FIREFOX_WINDOWS]));
    expect(left).toHaveLength(2);
  });

  it("[sessions.not-theirs] is told Keel's own sentence for a session that is not theirs, or is already ended, and ends nobody's", async () => {
    const identity = createIdentity(ORIGIN);
    const ada = await alsoOn(identity, "ada@example.com", CHROME_MAC);
    const grace = await alsoOn(identity, "grace@example.com", FIREFOX_WINDOWS);
    const hers = (await grace.account.sessions())[0]?.id ?? "";
    const refused = await ada.account.endSession(hers).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Refused);
    expect(refused).toMatchObject({
      code: "SESSION_NOT_FOUND",
      message: "No session of yours has that id",
    });
    expect(await grace.account.who()).toEqual(grace.who);
    // One of her own, ended twice: the second time there is no such session.
    const again = await alsoOn(identity, "ada@example.com", "curl/8.7.1");
    const extra = (await ada.account.sessions()).find((each) => each.userAgent === "curl/8.7.1");
    await ada.account.endSession(extra?.id ?? "");
    expect(await again.account.who()).toBeNull();
    await expect(ada.account.endSession(extra?.id ?? "")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });
});

describe("a person's passkeys, as their settings list them", () => {
  it("[passkeys.used] says when a passkey last signed its person in only where Keel has it, and nothing where it has none", async () => {
    const { identity, account, who } = await signedUp();
    await identity.keyed(who.id, "This laptop", new Date("2026-10-13T16:02:03.000Z"));
    await identity.keyed(who.id, "Old phone");
    const listed = await account.passkeys();
    expect(new Set(listed.map((passkey) => `${passkey.name}: ${passkey.lastUsedAt}`))).toEqual(
      new Set(["Old phone: undefined", "This laptop: 2026-10-13T16:02:03.000Z"]),
    );
    expect(listed).toHaveLength(2);
    // Nothing stands in for a last use Keel does not have: the field is not there at all.
    expect(listed.find((passkey) => passkey.name === "Old phone")).not.toHaveProperty("lastUsedAt");
  });

  it("[passkeys.rename] gives a passkey of the reader's own another name, and nobody else's", async () => {
    const { identity, tab, account, who } = await signedUp();
    const id = await identity.keyed(who.id, "This laptop");
    await account.renamePasskey(id, "  Work laptop ");
    // What the page sent is the name without the spaces typed round it, whatever Keel would have made of them.
    const sent = tab.fromThePage.findLast((request) => request.url.endsWith("/update-passkey"));
    expect(await sent?.json()).toEqual({ id, name: "Work laptop" });
    expect((await account.passkeys()).map((passkey) => passkey.name)).toEqual(["Work laptop"]);
    const grace = await alsoOn(identity, "grace@example.com");
    await expect(grace.account.renamePasskey(id, "Mine now")).rejects.toThrow(Refused);
    expect((await account.passkeys()).map((passkey) => passkey.name)).toEqual(["Work laptop"]);
    expect(await grace.account.passkeys()).toEqual([]);
  });
});
