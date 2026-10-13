import { describe, expect, it } from "vitest";
import { type SessionRow, shownSession } from "../../src/adapters/driven/better-auth/sessions.ts";

const ROW: SessionRow = {
  id: "ses_1",
  createdAt: "2026-10-13T09:00:00.000Z",
  updatedAt: new Date("2026-10-13T11:00:00.000Z"),
  expiresAt: "2026-10-20T11:00:00.000Z",
  userAgent: "Mozilla/5.0",
  signedInBy: "passkey",
};

describe("a session as its person is shown it", () => {
  it("[sessions.shown] answers the row's id and times, its last write as its last use, and nothing else the row holds", () => {
    const row = { ...ROW, token: "secret", ipAddress: "2001:db8::1", userId: "usr_1" };
    expect(shownSession(row, "ses_2")).toStrictEqual({
      id: "ses_1",
      current: false,
      signedInBy: "passkey",
      userAgent: "Mozilla/5.0",
      createdAt: "2026-10-13T09:00:00.000Z",
      lastUsedAt: "2026-10-13T11:00:00.000Z",
      expiresAt: "2026-10-20T11:00:00.000Z",
    });
  });

  it("[sessions.shown-current] marks the row whose id is the asking session's, and no other", () => {
    expect(shownSession(ROW, "ses_1").current).toBe(true);
    expect(shownSession(ROW, "ses_10").current).toBe(false);
    expect(shownSession(ROW, "").current).toBe(false);
  });

  it("[sessions.shown-way] names each way Keel signs a session in, and reads any other row as `other`", () => {
    for (const way of ["passkey", "email-otp", "github", "device"])
      expect(shownSession({ ...ROW, signedInBy: way }, "ses_2").signedInBy).toBe(way);
    for (const way of [null, undefined, "", "password", "PASSKEY", "other"])
      expect(shownSession({ ...ROW, signedInBy: way }, "ses_2").signedInBy).toBe("other");
  });

  it("[sessions.shown-agent] answers a browser that said nothing as null, never as an empty name", () => {
    for (const userAgent of [null, undefined, ""])
      expect(shownSession({ ...ROW, userAgent }, "ses_2").userAgent).toBeNull();
  });
});
