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
      "/new",
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
      "/new/project",
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

  it("[places.new] has making a project at /new, with the owner a link named, for someone signed in who has a handle", () => {
    expect(placeOf("/new")).toEqual({ at: "new-project" });
    expect(placeOf("/new", "?owner=acme")).toEqual({ at: "new-project", owner: "acme" });
    expect(placeOf("/new", "?owner=")).toEqual({ at: "new-project" });
    expect(hrefOf({ at: "new-project" })).toBe("/new");
    expect(hrefOf({ at: "new-project", owner: "acme" })).toBe("/new?owner=acme");
    // A visitor signs in first, and comes back to the form with the owner the link named.
    expect(
      sentFrom(
        { at: "new-project", owner: "acme" },
        { is: "visitor" },
        { pathname: "/new", search: "?owner=acme" },
      ),
    ).toBe("/login?next=%2Fnew%3Fowner%3Dacme");
    // Someone who has chosen no handle chooses one first: Keel makes a project for nobody without a name.
    const bare = { pathname: "/new", search: "" };
    expect(sentFrom({ at: "new-project" }, { is: "user" }, bare)).toBe("/signup?next=%2Fnew");
    expect(sentFrom({ at: "new-project" }, { is: "user", handle: "ada" }, bare)).toBeNull();
  });

  it("[places.namespace-tabs] reads a namespace's projects and a person's orgs as tabs of its page, and nothing else as one", () => {
    expect(placeOf("/ada", "?tab=projects")).toEqual({
      at: "namespace",
      handle: "ada",
      tab: "projects",
    });
    expect(placeOf("/ada", "?tab=orgs")).toEqual({ at: "namespace", handle: "ada", tab: "orgs" });
    expect(placeOf("/ada", "?tab=people")).toEqual({ at: "namespace", handle: "ada" });
    expect(placeOf("/ada")).toEqual({ at: "namespace", handle: "ada" });
    expect(hrefOf({ at: "namespace", handle: "ada", tab: "projects" })).toBe("/ada?tab=projects");
    expect(hrefOf({ at: "namespace", handle: "ada" })).toBe("/ada");
  });

  it("[places.not-a-handle] reads no namespace from a first segment no handle could be", () => {
    expect(placeOf("/sitemap.xml")).toBeNull();
    expect(placeOf("/a--b")).toBeNull();
    expect(placeOf("/-ada")).toBeNull();
    expect(placeOf("/Ada")).toEqual({ at: "namespace", handle: "Ada" });
    expect(placeOf("/ada-lovelace")).toEqual({ at: "namespace", handle: "ada-lovelace" });
  });

  it("[places.new-import] opens making a project on an import where the link asks for one, and on an empty start otherwise", () => {
    expect(placeOf("/new", "?owner=acme&start=import")).toEqual({
      at: "new-project",
      owner: "acme",
      start: "import",
    });
    expect(placeOf("/new", "?owner=acme&start=fork")).toEqual({ at: "new-project", owner: "acme" });
    expect(hrefOf({ at: "new-project", owner: "acme", start: "import" })).toBe(
      "/new?owner=acme&start=import",
    );
  });

  it("[places.fork] has forking a project at the project's own address with fork after it, for someone signed in who has a handle", () => {
    expect(placeOf("/acme/demo/fork")).toEqual({ at: "fork", namespace: "acme", project: "demo" });
    expect(hrefOf({ at: "fork", namespace: "acme", project: "demo" })).toBe("/acme/demo/fork");
    // Nothing else under a project is the form, and nothing under a reserved first segment is a project.
    for (const address of [
      "/acme/demo/forks",
      "/acme/demo/fork/again",
      "/acme/demo",
      "/new/demo/fork",
    ])
      expect(placeOf(address)).not.toMatchObject({ at: "fork" });
    expect(placeOf("/orgs/demo/fork")).toBeNull();
    // A visitor signs in first and comes back to the form; someone with no handle chooses one first.
    const fork = { at: "fork", namespace: "acme", project: "demo" } as const;
    const here = { pathname: "/acme/demo/fork", search: "" };
    expect(sentFrom(fork, { is: "visitor" }, here)).toBe("/login?next=%2Facme%2Fdemo%2Ffork");
    expect(sentFrom(fork, { is: "user" }, here)).toBe("/signup?next=%2Facme%2Fdemo%2Ffork");
    expect(sentFrom(fork, { is: "user", handle: "ada" }, here)).toBeNull();
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
