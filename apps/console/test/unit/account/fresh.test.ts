import { describe, expect, it } from "vitest";
import { FRESH_SIGN_IN_REQUIRED, wayToFresh } from "../../../src/account/fresh.ts";

describe("signing in afresh, where Keel wants it", () => {
  it("[account.fresh-way] offers the way to a fresh sign-in that this person has, and none where Keel refused for another reason", () => {
    // Someone with a passkey touches it, here on the page.
    expect(wayToFresh(FRESH_SIGN_IN_REQUIRED, 2)).toBe("passkey");
    expect(wayToFresh(FRESH_SIGN_IN_REQUIRED, 1)).toBe("passkey");
    // Someone with none has none to touch: they sign in again the way they came.
    expect(wayToFresh(FRESH_SIGN_IN_REQUIRED, 0)).toBe("sign-in");
    // Until the page knows what they hold it offers neither.
    expect(wayToFresh(FRESH_SIGN_IN_REQUIRED, null)).toBeNull();
    // Any other refusal, and no refusal, is answered by no sign-in.
    expect(wayToFresh("PASSKEY_NOT_FOUND", 1)).toBeNull();
    expect(wayToFresh("PASSKEY_NOT_FOUND", 0)).toBeNull();
    expect(wayToFresh(undefined, 0)).toBeNull();
  });
});
