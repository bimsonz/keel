import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  addedLines,
  applyNoop,
  buildWorlds,
  FRESHNESS_SCHEMA,
  type FreshnessSlots,
  freshnessNoop,
  MATRIX_WORLDS,
  type NoopRecipe,
  noopPlaced,
  renderFreshness,
  type TextCodec,
  validateSlots,
} from "../../../src/application/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

type File = { readonly path: string; readonly text?: string };
const codec: TextCodec<File> = {
  path: (f) => f.path,
  text: (f) => f.text,
  withText: (f, text) => ({ ...f, text }),
};

const ANCHOR = "store.removeCollaborator(repo.id, target.id, actor.id, clock.now());";
const recipe = (anchor = ANCHOR): NoopRecipe =>
  freshnessNoop({ path: "src/routes/collaborators.ts", call: anchor });

/** Text that never contains the anchor. */
const plain = (anchor: string) => fc.string({ maxLength: 80 }).filter((t) => !t.includes(anchor));
const anchorArb = fc.string({ minLength: 3, maxLength: 20 }).filter((a) => !a.includes("void 0"));

describe("A-noop: the anchored call made a no-op", () => {
  it("[world-matrix.noop-once] replaces the anchor's one occurrence and nothing else", () => {
    fc.assert(
      fc.property(
        anchorArb.chain((a) => fc.tuple(fc.constant(a), plain(a), plain(a))),
        ([a, before, after]) => {
          const text = `${before}${a}${after}`;
          fc.pre(text.split(a).length === 2);
          const r = recipe(a);
          expect(Result.getOrThrow(applyNoop(text, r))).toBe(`${before}${r.replacement}${after}`);
        },
      ),
    );
  });

  it("[world-matrix.noop-anchor-ambiguous] gives no A-noop for an anchor that is absent, empty or not unique", () => {
    fc.assert(
      fc.property(
        anchorArb,
        fc.array(fc.string({ maxLength: 20 }), { minLength: 3, maxLength: 5 }),
        (a, parts) => {
          const text = parts.join(a);
          const count = text.split(a).length - 1;
          fc.pre(count >= 2);
          expect(applyNoop(text, recipe(a))).toEqual(
            Result.fail({ reason: "anchor-ambiguous", path: "src/routes/collaborators.ts", count }),
          );
        },
      ),
    );
    expect(Result.isFailure(applyNoop("nothing here", recipe()))).toBe(true);
    expect(applyNoop("x", recipe(""))).toMatchObject(Result.fail({ reason: "anchor-absent" }));
  });

  it("[world-matrix.five-worlds] builds trunk, A, B and AB as given, and A-noop as A with the one file changed", () => {
    const route = {
      path: "src/routes/collaborators.ts",
      text: `  ${ANCHOR}\n  return c.body(null, 204);\n`,
    };
    const other = { path: "src/app.ts", text: "export {};" };
    const trees = { trunk: [other], A: [other, route], B: [other], AB: [other, route] };
    const worlds = Result.getOrThrow(buildWorlds(trees, recipe(), codec));
    expect(Object.keys(worlds).toSorted()).toEqual([...MATRIX_WORLDS].toSorted());
    expect([worlds.trunk, worlds.A, worlds.B, worlds.AB]).toEqual([
      trees.trunk,
      trees.A,
      trees.B,
      trees.AB,
    ]);
    expect(worlds["A-noop"]).toEqual([
      other,
      {
        path: route.path,
        text: `  void 0; /* A-noop: the anchored call does nothing */\n  return c.body(null, 204);\n`,
      },
    ]);
    expect(buildWorlds(trees, undefined, codec)).toEqual(Result.fail({ reason: "no-recipe" }));
    expect(buildWorlds({ ...trees, A: [other] }, recipe(), codec)).toMatchObject(
      Result.fail({ reason: "file-absent" }),
    );
    expect(
      buildWorlds({ ...trees, A: [other, { path: route.path }] }, recipe(), codec),
    ).toMatchObject(Result.fail({ reason: "file-absent" }));
  });

  it("[freshness.s1-anchor] S-1's revoke call occurs exactly once in A's change", () => {
    const patch = readFileSync(
      join(import.meta.dirname, "../../../../../fixtures/forge-lite/scenarios/s1/a.patch"),
      "utf8",
    );
    const added = patch
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
    expect(Result.isSuccess(applyNoop(added, recipe()))).toBe(true);
  });
});

const S1: FreshnessSlots = {
  owner: "alice",
  subject: "bob",
  setup: [
    {
      actor: "owner",
      method: "POST",
      path: "/repos",
      body: '{"name":"forge","visibility":"public"}',
      expectedStatus: 201,
    },
    {
      actor: "owner",
      method: "PUT",
      path: "/repos/alice/forge/collaborators/bob",
      body: '{"role":"admin"}',
      expectedStatus: 200,
    },
  ],
  call: {
    actor: "subject",
    method: "GET",
    path: "/repos/alice/forge",
    body: "",
    expectedStatus: 200,
  },
  revoke: {
    actor: "owner",
    method: "DELETE",
    path: "/repos/alice/forge/collaborators/bob",
    body: "",
    expectedStatus: 204,
  },
  callAgain: {
    actor: "subject",
    method: "DELETE",
    path: "/repos/alice/forge",
    body: "",
    expectedStatus: 403,
  },
  rationale: "bob's admin role is revoked mid-session",
  noop: {
    path: "src/routes/collaborators.ts",
    call: "store.removeCollaborator(repo.id, target.id, actor.id, clock.now());",
  },
};

describe("A-noop's recipe, placed on A's own work", () => {
  const patch = readFileSync(
    join(import.meta.dirname, "../../../../../fixtures/forge-lite/scenarios/s1/a.patch"),
    "utf8",
  );

  it("[noop.placed] accepts S-1's revoke call: on a line A adds to the file A changes", () => {
    expect(Result.isSuccess(noopPlaced(patch, recipe()))).toBe(true);
    expect(addedLines(patch, "src/routes/collaborators.ts")).toContain(`    ${ANCHOR}`);
  });

  it("[noop.placed] refuses a call A does not add, or a file A does not change, saying which", () => {
    const context = patch
      .split("\n")
      .find((l) => l.startsWith(" ") && l.trim().length > 3)
      ?.trim();
    if (context === undefined) throw new Error("a.patch has a context line");
    expect(noopPlaced(patch, recipe(context))).toEqual(
      Result.fail("the call is not on a line A adds to src/routes/collaborators.ts"),
    );
    expect(noopPlaced(patch, { ...recipe(), path: "src/app.ts" })).toEqual(
      Result.fail("src/app.ts is not in A's diff"),
    );
  });
});

describe("the freshness template", () => {
  it("[freshness.slots] accepts well-formed slots and names exactly what is wrong otherwise", () => {
    expect(validateSlots(S1)).toEqual(Result.succeed(S1));
    const wrong = (patch: Record<string, unknown>) => validateSlots({ ...S1, ...patch });
    expect(wrong({ owner: "Alice" })).toEqual(Result.fail("owner must be a lowercase username"));
    expect(wrong({ subject: "alice" })).toEqual(Result.fail("owner and subject must differ"));
    expect(wrong({ setup: [{ ...S1.call, path: "/sessions" }] })).toEqual(
      Result.fail(
        "setup[0] calls /sessions: the template already creates both users and signs each in; setup must not",
      ),
    );
    expect(wrong({ revoke: { ...S1.revoke, actor: "subject" } })).toEqual(
      Result.fail("revoke must be made by the owner"),
    );
    expect(wrong({ call: { ...S1.call, body: "{" } })).toEqual(
      Result.fail("call.body is not JSON text"),
    );
    expect(wrong({ callAgain: { ...S1.callAgain, expectedStatus: 99 } })).toEqual(
      Result.fail("callAgain.expectedStatus must be an HTTP status"),
    );
    expect(wrong({ noop: undefined })).toEqual(
      Result.fail("noop.path must be the repo-relative path of a file in A's diff"),
    );
    expect(wrong({ noop: { ...S1.noop, call: "a();\nb();" } })).toEqual(
      Result.fail("noop.call must be one statement as written on one line"),
    );
    expect(validateSlots([])).toEqual(Result.fail("the reply is not a JSON object"));
  });

  it("renders a probe that carries every slot and decides n/a on an absent revoke route", () => {
    const probe = renderFreshness(S1);
    for (const value of [S1.owner, S1.subject, S1.call, S1.revoke, S1.callAgain, S1.setup])
      expect(probe).toContain(JSON.stringify(value));
    expect(probe).toContain('throw new Error("probe not applicable: revoke route absent")');
    expect(renderFreshness(S1)).toBe(probe);
    expect(FRESHNESS_SCHEMA.required).toContain("revoke");
  });
});
