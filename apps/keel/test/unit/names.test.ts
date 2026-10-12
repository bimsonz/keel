import { describe, expect, it } from "vitest";
import { nameRefusal, RESERVED_NAMES } from "../../src/adapters/driven/better-auth/names.ts";

/** The paths keel.town serves at its root (Mission Control's list, plus Better Auth's mount). */
const SITE_PATHS = [
  "api",
  "v1",
  "mcp",
  "auth",
  "assets",
  "healthz",
  "login",
  "signup",
  "logout",
  "device",
  "invite",
  "settings",
  "new",
  "orgs",
  "install",
  "admin",
  "terms",
  "privacy",
  "rule",
  ".well-known",
  "robots.txt",
  "favicon.ico",
  "start",
  "llms.txt",
];

describe("handles and org names", () => {
  it("[names.reserved] refuses every path the site serves, in any case, and reserves nothing else", () => {
    expect([...RESERVED_NAMES].toSorted()).toEqual(SITE_PATHS.toSorted());
    for (const path of SITE_PATHS) {
      expect(nameRefusal(path)).toMatch(/reserved/);
      expect(nameRefusal(path.toUpperCase())).toMatch(/reserved/);
      expect(nameRefusal(`${path[0]?.toUpperCase()}${path.slice(1)}`)).toMatch(/reserved/);
    }
  });

  it("[names.instance] the org holding Keel's own projects is an ordinary name: whoever signs up first may take it", () => {
    for (const name of ["keel", "Keel", "KEEL"]) expect(nameRefusal(name)).toBeUndefined();
  });

  it("[names.handle] takes letters, digits and single inner hyphens up to 39 characters", () => {
    for (const ok of ["ada", "Ada", "keeltown", "a", "a-b", "forge-lite", "x".repeat(39), "r2d2"])
      expect(nameRefusal(ok)).toBeUndefined();
    for (const bad of ["", "-a", "a-", "a--b", "a_b", "a.b", "a b", "x".repeat(40), "é"])
      expect(nameRefusal(bad)).toMatch(/must be/);
  });
});
