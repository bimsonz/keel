import { describe, expect, it } from "vitest";
import {
  approvalPasskeyAt,
  FRESH_FOR_MS,
  isFresh,
  isFreshForApproval,
  mayAddFirstPasskey,
  signInMethod,
} from "../../src/adapters/driven/better-auth/fresh.ts";

const NOW = new Date("2026-10-13T12:00:00.000Z");

/** A session made `ms` before NOW. */
const made = (ms: number, signedInBy?: string | null) => ({
  createdAt: new Date(NOW.getTime() - ms),
  ...(signedInBy === undefined ? {} : { signedInBy }),
});

describe("a fresh sign-in", () => {
  it("[fresh.method] names a session's sign-in by the endpoint that made it, and anything else `other`", () => {
    expect(signInMethod("/passkey/verify-authentication")).toBe("passkey");
    expect(signInMethod("/passkey/verify-registration")).toBe("passkey");
    expect(signInMethod("/sign-in/email-otp")).toBe("email-otp");
    expect(signInMethod("/callback/:id")).toBe("github");
    expect(signInMethod("/device/token")).toBe("device");
    for (const path of [
      "",
      "/sign-in/social",
      "/sign-in/username",
      "/passkey/generate-register-options",
      "/passkey/verify-authentication/",
      "/PASSKEY/VERIFY-AUTHENTICATION",
      "/device/approve",
      "/callback/github",
      "/update-session",
      "toString",
    ])
      expect(signInMethod(path)).toBe("other");
  });

  it("[fresh.window] lasts ten minutes from a passkey sign-in, the tenth minute's end included", () => {
    expect(FRESH_FOR_MS).toBe(10 * 60 * 1000);
    expect(isFresh(made(0, "passkey"), NOW)).toBe(true);
    expect(isFresh(made(FRESH_FOR_MS - 1, "passkey"), NOW)).toBe(true);
    expect(isFresh(made(FRESH_FOR_MS, "passkey"), NOW)).toBe(true);
    expect(isFresh(made(FRESH_FOR_MS + 1, "passkey"), NOW)).toBe(false);
    expect(isFresh(made(24 * 60 * 60 * 1000, "passkey"), NOW)).toBe(false);
  });

  it("[fresh.passkey-only] is never a session signed in another way, or one whose row says no way at all", () => {
    for (const method of ["email-otp", "github", "device", "other", "", "Passkey", "passkey "])
      expect(isFresh(made(0, method), NOW)).toBe(false);
    expect(isFresh(made(0, null), NOW)).toBe(false);
    expect(isFresh(made(0), NOW)).toBe(false);
  });

  it("[fresh.unreadable] is never a session whose time of making can't be read", () => {
    expect(isFresh({ signedInBy: "passkey", createdAt: new Date("never") }, NOW)).toBe(false);
  });

  it("[fresh.first-passkey] a first passkey takes a sign-in of the person's own from the last ten minutes: a passkey, a code or GitHub", () => {
    for (const method of ["passkey", "email-otp", "github"]) {
      expect([method, mayAddFirstPasskey(made(0, method), NOW)]).toEqual([method, true]);
      expect([method, mayAddFirstPasskey(made(FRESH_FOR_MS, method), NOW)]).toEqual([method, true]);
    }
  });

  it("[fresh.first-passkey-window] a first passkey takes no sign-in older than ten minutes, or one whose time can't be read", () => {
    for (const method of ["passkey", "email-otp", "github"]) {
      expect([method, mayAddFirstPasskey(made(FRESH_FOR_MS + 1, method), NOW)]).toEqual([
        method,
        false,
      ]);
      expect([
        method,
        mayAddFirstPasskey({ signedInBy: method, createdAt: new Date("never") }, NOW),
      ]).toEqual([method, false]);
    }
  });

  it("[fresh.first-passkey-own] a first passkey takes no session the person did not sign in themselves: a device grant's, or one that says no way", () => {
    for (const method of ["device", "other", "", "GitHub", "email-otp ", "toString"])
      expect([method, mayAddFirstPasskey(made(0, method), NOW)]).toEqual([method, false]);
    expect(mayAddFirstPasskey(made(0, null), NOW)).toBe(false);
    expect(mayAddFirstPasskey(made(0), NOW)).toBe(false);
  });

  it("[fresh.device-window] a device sign-in may give agents standing for ten minutes from the passkey that approved it, however late it was redeemed", () => {
    const device = (passkeyMs: number, madeMs = 0) => ({
      ...made(madeMs, "device"),
      passkeyAt: new Date(NOW.getTime() - passkeyMs),
    });
    const minute = 60_000;
    expect(isFreshForApproval(device(9 * minute + 59_000), NOW)).toBe(true);
    expect(isFreshForApproval(device(FRESH_FOR_MS), NOW)).toBe(true);
    expect(isFreshForApproval(device(10 * minute + 1000), NOW)).toBe(false);
    expect(isFreshForApproval(device(10 * minute + 1000, 0), NOW)).toBe(false);
    expect(isFreshForApproval(device(11 * minute, 2 * minute), NOW)).toBe(false);
    expect(isFreshForApproval(device(24 * 60 * minute), NOW)).toBe(false);
    expect(isFreshForApproval(device(0), NOW)).toBe(true);
    expect(isFreshForApproval(device(-1000), NOW)).toBe(false);
    expect(isFreshForApproval(device(-5 * minute), NOW)).toBe(false);
    expect(approvalPasskeyAt(device(4 * minute, 1 * minute), NOW)).toEqual(
      new Date(NOW.getTime() - 4 * minute),
    );
    expect(isFreshForApproval({ ...made(0, "device"), passkeyAt: new Date("never") }, NOW)).toBe(
      false,
    );
  });

  it("[fresh.device-unstepped] a device sign-in whose approval had no fresh passkey never may, nor any other way in but a fresh passkey", () => {
    expect(isFreshForApproval(made(0, "device"), NOW)).toBe(false);
    expect(isFreshForApproval({ ...made(0, "device"), passkeyAt: null }, NOW)).toBe(false);
    for (const method of ["email-otp", "github", "other", "", null])
      expect(
        isFreshForApproval({ ...made(0, method), passkeyAt: new Date(NOW.getTime()) }, NOW),
      ).toBe(false);
    expect(isFreshForApproval(made(0, "passkey"), NOW)).toBe(true);
    expect(approvalPasskeyAt(made(60_000, "passkey"), NOW)).toEqual(
      new Date(NOW.getTime() - 60_000),
    );
    expect(isFreshForApproval(made(FRESH_FOR_MS + 1, "passkey"), NOW)).toBe(false);
  });

  it("[fresh.device-not-sign-in] a device sign-in's passkey never lets it change how the account signs in", () => {
    const device = { ...made(0, "device"), passkeyAt: new Date(NOW.getTime()) };
    expect(isFreshForApproval(device, NOW)).toBe(true);
    expect(isFresh(device, NOW)).toBe(false);
  });
});
