import { describe, expect, it } from "vitest";
import { hrefOf, nextOf, placeOf } from "../../src/places.ts";
import { RESERVED, parse } from "../../src/route.ts";

describe("the pages above every project", () => {
  it("[places.addresses] reads each page's address and writes it back", () => {
    expect(placeOf("/login")).toEqual({ at: "login" });
    expect(placeOf("/signup/")).toEqual({ at: "signup" });
    expect(placeOf("/settings")).toEqual({ at: "settings" });
    expect(placeOf("/device", "?user_code=ABCD-EFGH")).toEqual({
      at: "device",
      userCode: "ABCD-EFGH",
    });
    expect(hrefOf({ at: "device", userCode: "ABCD-EFGH" })).toBe("/device?user_code=ABCD-EFGH");
    expect(hrefOf({ at: "login" }, "/device?user_code=ABCD-EFGH")).toBe(
      "/login?next=%2Fdevice%3Fuser_code%3DABCD-EFGH",
    );
    expect(hrefOf({ at: "login" }, "/")).toBe("/login");
  });

  it("[places.reserved] has every page at a reserved first segment, so none is a project's address or an org's", () => {
    for (const address of ["/login", "/signup", "/settings", "/device"]) {
      const segment = address.split("/").find((part) => part !== "") ?? "";
      expect(RESERVED).toContain(segment);
      expect(parse(address, "").project).toBeNull();
    }
    // And nothing else is one of them: a project's own pages, and a path under a page.
    for (const address of ["/", "/demo", "/demo/login", "/login/extra", "/orgs/ada/members"])
      expect(placeOf(address)).toBeNull();
  });

  it("[places.next] goes back, once signed in, only to a page of this console", () => {
    expect(nextOf("?next=%2Fdevice%3Fuser_code%3DABCD-EFGH")).toBe("/device?user_code=ABCD-EFGH");
    expect(nextOf("?next=/demo/changes")).toBe("/demo/changes");
    expect(nextOf("")).toBe("/");
    for (const elsewhere of [
      "https://elsewhere.example/",
      "//elsewhere.example/",
      "/\\elsewhere.example",
      "javascript:alert(1)",
      "elsewhere.example",
    ])
      expect(nextOf(`?next=${encodeURIComponent(elsewhere)}`)).toBe("/");
  });
});
