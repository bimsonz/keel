import { describe, expect, it } from "vitest";
import {
  IMPORT_URL_MAX,
  importRef,
  importUrl,
  PROJECT_TEMPLATES,
  projectRepos,
  projectSource,
} from "../../../src/application/integration/index.ts";
import { makeId } from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

/** Any ULID: 26 characters of Crockford's alphabet. */
const ulidArb = fc.string({
  unit: fc.constantFrom(..."0123456789ABCDEFGHJKMNPQRSTVWXYZ".split("")),
  minLength: 26,
  maxLength: 26,
});
const projectIdArb = ulidArb.map((ulid) => makeId("prj", ulid));

/**
 * A project's trunk name respelled: each character in either case, the hyphen
 * kept, swapped or dropped, and something or nothing after it. Now and then it
 * is the trunk's own name.
 */
const respelledArb = fc
  .tuple(
    projectIdArb,
    fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }),
    fc.constantFrom("-", "-", "_", "/", ""),
    fc.constantFrom("", "", "-staging", "-guards", "-mirror", "0", " ", "/"),
  )
  .map(([projectId, upper, separator, tail]) => ({
    projectId,
    text:
      `prj${separator}${projectId.slice(4)}`
        .split("")
        .map((char, i) => (upper[i] === true ? char.toUpperCase() : char.toLowerCase()))
        .join("") + tail,
  }));

const UNKNOWN = { _tag: "Unknown" };

describe("a new project's source", () => {
  it("[project.source-inverse] a project's trunk name reads back as that project", () => {
    fc.assert(
      fc.property(projectIdArb, (projectId) => {
        expect(projectSource(projectRepos(projectId).trunk.name)).toEqual({
          _tag: "Project",
          projectId,
        });
      }),
    );
  });

  it("[project.source-inverse] nothing else a project owns, and no other spelling of its trunk, is a source", () => {
    fc.assert(
      fc.property(projectIdArb, fc.constantFrom("keel-core", "keel-ws-00", "x"), (id, segment) => {
        const repos = projectRepos(id);
        const trunk = repos.trunk.name;
        for (const name of [
          repos.staging.name,
          repos.guards.name,
          repos.mirror.name,
          `${segment}/${trunk}`,
          `${trunk}/${segment}`,
          `${trunk}/`,
          `/${trunk}`,
          id,
          id.toLowerCase(),
          trunk.toUpperCase(),
          `prj-${id.slice(4)}`,
          ` ${trunk}`,
          `${trunk} `,
          `${trunk}0`,
          trunk.slice(0, -1),
        ])
          expect([name, projectSource(name)]).toEqual([name, UNKNOWN]);
      }),
    );
  });

  it("[project.source-inverse] a respelling of a trunk's name is that project only when it is the name itself", () => {
    fc.assert(
      fc.property(respelledArb, ({ projectId, text }) => {
        expect([text, projectSource(text)]).toEqual([
          text,
          text === projectRepos(projectId).trunk.name ? { _tag: "Project", projectId } : UNKNOWN,
        ]);
      }),
    );
  });

  it("[project.source-template] the fixture is the one template, read by its repo's name", () => {
    expect([...PROJECT_TEMPLATES]).toEqual(["fixture-forge-lite"]);
    for (const template of PROJECT_TEMPLATES)
      expect(projectSource(template)).toEqual({ _tag: "Template", repo: template });
    for (const name of [
      "no-such",
      "keel-core/x",
      "keel-core/fixture-forge-lite",
      "",
      "Fixture-Forge-Lite",
    ])
      expect([name, projectSource(name)]).toEqual([name, UNKNOWN]);
  });
});

const admitted = (url: string) => ({ _tag: "Url", url });
const refusedFor = (why: string) => ({ _tag: "Refused", why });

/** Anything shaped like a URL: either scheme, a name or an address as its host, with or without a credential, a port, a query and a fragment. */
const anyUrlArb = fc.webUrl({
  validSchemes: ["https", "http"],
  authoritySettings: {
    withIPv4: true,
    withIPv4Extended: true,
    withIPv6: true,
    withPort: true,
    withUserInfo: true,
  },
  withQueryParameters: true,
  withFragments: true,
});

/** A public repository's URL as people write one, then perhaps spoiled by one thing Keel refuses. */
const nearUrlArb = fc
  .tuple(
    fc.constantFrom("github.com", "gitlab.com", "git.sr.ht", "codeberg.org", "GitHub.com"),
    fc.constantFrom("/bimsonz/keel", "/octocat/Hello-World.git", "/~user/repo", "/a/b/c"),
    fc.constantFrom("", "", "", "tok@", "user:pw@", ":443", ":8443", "?x=1", "#main", "/", "/.."),
  )
  .map(([host, path, spoil]) =>
    spoil.endsWith("@")
      ? `https://${spoil}${host}${path}`
      : spoil.startsWith(":")
        ? `https://${host}${spoil}${path}`
        : `https://${host}${path}${spoil}`,
  );

describe("the URL a project is imported from", () => {
  it("[source.import-url] a public repository's https URL is admitted, its host in lower case", () => {
    for (const url of [
      "https://github.com/bimsonz/keel",
      "https://github.com/octocat/Hello-World.git",
      "https://git.sr.ht/~user/repo",
      "https://gitlab.example.co.uk/group/sub-group/repo_1",
      "https://xn--bcher-kva.example/a",
    ])
      expect([url, importUrl(url)]).toEqual([url, admitted(url)]);
    expect(importUrl("https://GitHub.COM/Bimsonz/Keel")).toEqual(
      admitted("https://github.com/Bimsonz/Keel"),
    );
    const longest = `https://github.com/${"a".repeat(IMPORT_URL_MAX - 19)}`;
    expect(longest).toHaveLength(IMPORT_URL_MAX);
    expect(importUrl(longest)).toEqual(admitted(longest));
  });

  it("[source.import-url] anything else is refused, and the refusal says for what", () => {
    const table: readonly (readonly [string, string])[] = [
      ["http://github.com/bimsonz/keel", "not-https"],
      ["HTTPS://github.com/bimsonz/keel", "not-https"],
      ["git://github.com/bimsonz/keel", "not-https"],
      ["ssh://git@github.com/bimsonz/keel", "not-https"],
      ["git@github.com:bimsonz/keel.git", "not-https"],
      ["//github.com/bimsonz/keel", "not-https"],
      [" https://github.com/bimsonz/keel", "not-https"],
      ["", "not-https"],
      ["https://token@github.com/bimsonz/keel", "credential"],
      ["https://user:secret@github.com/bimsonz/keel", "credential"],
      ["https://github.com\\@evil.example/bimsonz/keel", "credential"],
      ["https://@github.com/bimsonz/keel", "credential"],
      ["https://github.com/bimsonz/keel?ref=main", "query"],
      ["https://github.com/bimsonz/keel?", "query"],
      ["https://github.com?x", "query"],
      ["https://github.com/bimsonz/keel#readme", "fragment"],
      ["https://github.com/bimsonz/keel#", "fragment"],
      ["https://github.com:443/bimsonz/keel", "port"],
      ["https://github.com:8443/bimsonz/keel", "port"],
      ["https://github.com:/bimsonz/keel", "port"],
      ["https://127.0.0.1/bimsonz/keel", "ip-literal"],
      ["https://10.0.0.1/a", "ip-literal"],
      ["https://169.254.169.254/latest/meta-data", "ip-literal"],
      ["https://127.1/a", "ip-literal"],
      ["https://0x7f.0.0.0x1/a", "ip-literal"],
      ["https://example.0x/a", "ip-literal"],
      ["https://[::1]/a", "ip-literal"],
      ["https://[2001:db8::1]:8443/a", "ip-literal"],
      ["https://localhost/a", "host"],
      ["https://2130706433/a", "host"],
      ["https:///bimsonz/keel", "host"],
      ["https://github.com./bimsonz/keel", "host"],
      ["https://.github.com/bimsonz/keel", "host"],
      ["https://git_hub.com/bimsonz/keel", "host"],
      ["https://-github.com/bimsonz/keel", "host"],
      ["https://github-.com/bimsonz/keel", "host"],
      ["https://github.com evil.example/a", "host"],
      [`https://${"a".repeat(64)}.com/a`, "host"],
      ["https://github.com", "path"],
      ["https://github.com/", "path"],
      ["https://github.com/bimsonz/keel/", "path"],
      ["https://github.com//bimsonz/keel", "path"],
      ["https://github.com/bimsonz/../keel", "path"],
      ["https://github.com/./keel", "path"],
      ["https://github.com/bimsonz/keel%2e%2e", "path"],
      ["https://github.com/bimsonz/ke el", "path"],
      ["https://github.com/bimsonz\\keel", "path"],
      ["https://github.com/bimsonz/keel\n", "path"],
      ["https://github.com/@bimsonz/keel", "path"],
      [`https://github.com/${"a".repeat(IMPORT_URL_MAX - 18)}`, "too-long"],
    ];
    for (const [url, why] of table) expect([url, importUrl(url)]).toEqual([url, refusedFor(why)]);
  });

  it("[source.import-url] whatever is admitted reads, to a URL parser, as an https name and a path and nothing more", () => {
    fc.assert(
      fc.property(fc.oneof(anyUrlArb, nearUrlArb, fc.string()), (text) => {
        const read = importUrl(text);
        if (read._tag === "Refused") return;
        const parsed = new URL(read.url);
        expect({
          protocol: parsed.protocol,
          username: parsed.username,
          password: parsed.password,
          port: parsed.port,
          search: parsed.search,
          hash: parsed.hash,
          href: parsed.href,
        }).toEqual({
          protocol: "https:",
          username: "",
          password: "",
          port: "",
          search: "",
          hash: "",
          href: read.url,
        });
        expect(parsed.hostname).toMatch(/^[a-z0-9.-]+\.[a-z0-9-]*[a-z-][a-z0-9-]*$/);
        expect(text.slice("https://".length).toLowerCase()).toBe(
          read.url.slice("https://".length).toLowerCase(),
        );
        expect(importUrl(read.url)).toEqual(read);
      }),
    );
  });

  it("[source.import-url] a near miss of a real URL is admitted only when nothing was added to it", () => {
    fc.assert(
      fc.property(nearUrlArb, (text) => {
        const clean =
          /^https:\/\/[A-Za-z.]+(?:\/[A-Za-z~.-]+)+$/.test(text) && !text.endsWith("/..");
        expect([text, importUrl(text)._tag]).toEqual([text, clean ? "Url" : "Refused"]);
      }),
    );
  });

  it("[source.import-ref] a branch is named as git names one, and never as a full ref", () => {
    for (const name of ["main", "master", "release/1.x", "feat/a-b_c", "v2", "a".repeat(255)])
      expect([name, importRef(name)]).toEqual([name, name]);
    for (const name of [
      "",
      "refs/heads/main",
      "refs/tags/v1",
      "-main",
      "/main",
      "main/",
      "a//b",
      "a..b",
      ".hidden",
      "a/.b",
      "main.",
      "main.lock",
      "a.lock/b",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[",
      "a\\b",
      "a@{1}",
      "HEAD",
      "main\n",
      "a".repeat(256),
    ])
      expect([name, importRef(name)]).toEqual([name, undefined]);
  });
});
