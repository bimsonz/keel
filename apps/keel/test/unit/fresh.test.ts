import { describe, expect, it } from "vitest";
import {
  FRESH_FOR_MS,
  isFresh,
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
});
