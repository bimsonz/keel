import { describe, expect, it } from "vitest";
import {
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
