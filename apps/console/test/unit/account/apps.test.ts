import { describe, expect, it } from "vitest";
import { appAskingOf, appRequestAgain, isAppRequest } from "../../../src/account/apps.ts";
import { nextOf, placeOf, sentFrom } from "../../../src/places.ts";

/** An app's request as Keel's sign-in sends it to the login and consent pages: signed, with its signing fields. */
const SIGNED =
  "?response_type=code&client_id=app-1&redirect_uri=http%3A%2F%2Flocalhost%3A33418%2Fcallback&scope=person+offline_access&state=s-1&code_challenge=abc&code_challenge_method=S256&resource=https%3A%2F%2Fkeel.town%2Fmcp&exp=1792623208&ba_iat=1792622608469&ba_param=ba_iat&ba_param=client_id&sig=c2lnbmVk";

describe("an app a person signs in through", () => {
  it("[console.app-resume] a person who signs in for an app goes on to the app's request at Keel's own authorization endpoint, with the signing fields dropped, and nowhere else", () => {
    expect(isAppRequest(SIGNED)).toBe(true);
    const again = new URL(appRequestAgain(SIGNED), "https://keel.town");
    expect(again.pathname).toBe("/v1/auth/oauth2/authorize");
    expect(Object.fromEntries(again.searchParams)).toEqual({
      response_type: "code",
      client_id: "app-1",
      redirect_uri: "http://localhost:33418/callback",
      scope: "person offline_access",
      state: "s-1",
      code_challenge: "abc",
      code_challenge_method: "S256",
      resource: "https://keel.town/mcp",
    });
    expect(nextOf(SIGNED)).toBe(appRequestAgain(SIGNED));
    // A signed-in reader sent to the login page by the app goes straight on.
    expect(
      sentFrom(
        { at: "login" },
        { is: "user", handle: "ann" },
        { pathname: "/login", search: SIGNED },
      ),
    ).toBe(appRequestAgain(SIGNED));
    // A query that is no signed request of an app's is a plain `next`, and another site is never followed.
    expect(isAppRequest("?client_id=app-1&response_type=code")).toBe(false);
    expect(nextOf("?next=https://elsewhere.example/")).toBe("/");
  });

  it("[console.app-asking] the consent page names the app and the origin it sends the person back to, and holds the signed request to answer it with", () => {
    expect(placeOf("/consent", SIGNED)).toEqual({ at: "consent" });
    expect(appAskingOf(SIGNED)).toEqual({
      clientId: "app-1",
      returnsTo: "http://localhost:33418",
      query: SIGNED.slice(1),
    });
    expect(appAskingOf("?client_id=app-1")).toBeNull();
    // A request Keel did not sign, callback and all, is none to answer.
    expect(appAskingOf(SIGNED.replace(/&sig=[^&]*/, ""))).toBeNull();
    // A visitor is sent to sign in first, and comes back to the page.
    expect(
      sentFrom({ at: "consent" }, { is: "visitor" }, { pathname: "/consent", search: SIGNED }),
    ).toBe(`/login?next=${encodeURIComponent(`/consent${SIGNED}`)}`);
  });
});
