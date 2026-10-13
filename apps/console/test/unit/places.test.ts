import { describe, expect, it } from "vitest";
import { hrefOf, nextOf, placeOf, sentFrom } from "../../src/places.ts";
import { RESERVED_SEGMENTS } from "../../src/contract/keel/index.ts";
import { parse } from "../../src/route.ts";

/** An address as the browser gives it. */
const at = (pathname: string, search = "") => ({ pathname, search });

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

  it("[places.reserved] has every page but a namespace's own at a reserved first segment, so none is a project's address or a handle", () => {
    for (const address of [
      "/login",
      "/signup",
      "/settings",
      "/device",
      "/new/org",
      "/orgs/ada",
      "/orgs/ada/members",
      "/invite/inv_1",
    ]) {
      const segment = address.split("/").find((part) => part !== "") ?? "";
      expect(RESERVED_SEGMENTS).toContain(segment);
      expect(parse(address, "")).toMatchObject({ namespace: null, project: null });
    }
    // And nothing else is one of them: the home, a project's own pages, and a path under a page.
    for (const address of [
      "/",
      "/acme/demo",
      "/acme/login",
      "/login/extra",
      "/new",
      "/orgs",
      "/orgs/ada/projects",
      "/orgs/ada/members/extra",
      "/invite",
      "/invite/inv_1/accept",
      "/orgs/%E0%A4%A",
    ])
      expect(placeOf(address)).toBeNull();
  });

  it("[places.namespace] has a namespace's own page at its handle, where a code host has an owner's, and no reserved word is one", () => {
    expect(placeOf("/lovelace")).toEqual({ at: "namespace", handle: "lovelace" });
    expect(placeOf("/lovelace/")).toEqual({ at: "namespace", handle: "lovelace" });
    expect(hrefOf({ at: "namespace", handle: "lovelace" })).toBe("/lovelace");
    // The address an org's home had before still reads as the same place, and is written the new way.
    expect(hrefOf(placeOf("/orgs/lovelace") ?? { at: "login" })).toBe("/lovelace");
    // The route table agrees: one segment names a namespace and no project.
    expect(parse("/lovelace", "")).toMatchObject({ namespace: "lovelace", project: null });
    for (const word of RESERVED_SEGMENTS) expect(placeOf(`/${word}`)?.at).not.toBe("namespace");
    // Anyone may open it: Keel shows a visitor a namespace's public projects. An org's members' pages are a member's.
    const visitor = { is: "visitor" } as const;
    expect(sentFrom({ at: "namespace", handle: "lovelace" }, visitor, at("/lovelace"))).toBeNull();
  });

  it("[places.orgs] gives an org's pages, making one and an invitation each an address of its own", () => {
    expect(placeOf("/new/org")).toEqual({ at: "new-org" });
    expect(placeOf("/orgs/lovelace")).toEqual({ at: "namespace", handle: "lovelace" });
    // Nothing else is under an org's handle there: an org has members and settings, and no page of another name.
    expect(placeOf("/orgs/lovelace/home")).toBeNull();
    expect(placeOf("/orgs/lovelace/members")).toEqual({
      at: "org",
      org: "lovelace",
      tab: "members",
    });
    expect(placeOf("/orgs/lovelace/settings/")).toEqual({
      at: "org",
      org: "lovelace",
      tab: "settings",
    });
    expect(placeOf("/invite/inv_1")).toEqual({ at: "invite", id: "inv_1" });
    for (const address of ["/new/org", "/lovelace", "/orgs/lovelace/members", "/invite/inv_1"])
      expect(hrefOf(placeOf(address) ?? { at: "login" })).toBe(address);
  });

  it("[places.sent] sends a visitor to sign in and back to the page they asked for, an invitation included", () => {
    const visitor = { is: "visitor" } as const;
    expect(sentFrom({ at: "invite", id: "inv_1" }, visitor, at("/invite/inv_1"))).toBe(
      "/login?next=%2Finvite%2Finv_1",
    );
    expect(
      sentFrom(
        { at: "org", org: "lovelace", tab: "members" },
        visitor,
        at("/orgs/lovelace/members"),
      ),
    ).toBe("/login?next=%2Forgs%2Flovelace%2Fmembers");
    expect(sentFrom({ at: "settings" }, visitor, at("/settings"))).toBe("/login?next=%2Fsettings");
    expect(sentFrom({ at: "login" }, visitor, at("/login"))).toBeNull();
    expect(sentFrom({ at: "signup" }, visitor, at("/signup"))).toBeNull();
    // Signed in, the sign-in pages go on to where the reader was going.
    const ada = { is: "user", handle: "ada" } as const;
    expect(sentFrom({ at: "login" }, ada, at("/login", "?next=%2Finvite%2Finv_1"))).toBe(
      "/invite/inv_1",
    );
    expect(sentFrom({ at: "signup" }, ada, at("/signup"))).toBe("/");
    expect(sentFrom({ at: "invite", id: "inv_1" }, ada, at("/invite/inv_1"))).toBeNull();
    // A user with no handle yet chooses one first, and is then at the page they asked for.
    const unnamed = { is: "user" } as const;
    expect(sentFrom({ at: "signup" }, unnamed, at("/signup"))).toBeNull();
    expect(sentFrom({ at: "invite", id: "inv_1" }, unnamed, at("/invite/inv_1"))).toBe(
      "/signup?next=%2Finvite%2Finv_1",
    );
    expect(sentFrom({ at: "new-org" }, unnamed, at("/new/org"))).toBe("/signup?next=%2Fnew%2Forg");
    expect(sentFrom({ at: "settings" }, unnamed, at("/settings"))).toBeNull();
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
