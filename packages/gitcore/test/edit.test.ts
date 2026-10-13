import { describe, expect, it } from "vitest";
import { enc } from "../src/bytes.ts";
import { MissingObject } from "../src/diff.ts";
import { applyEdits, EditRefused, type EditRefusalReason, type FileEdit } from "../src/edit.ts";
import {
  decodeTree,
  type GitObject,
  MODE_EXEC,
  MODE_FILE,
  MODE_GITLINK,
  MODE_SYMLINK,
  MODE_TREE,
} from "../src/objects.ts";
import { PATHS } from "./gen.ts";
import type { FileSpec, Mode, TreeModel } from "./git-harness.ts";
import { MemoryStore } from "./store.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";

const CONTENTS = ["one\n", "two\n", "three\n", ""];
const GITLINK = "1111111111111111111111111111111111111111";

/** A base tree over the shared vocabulary: plain, executable, symlink and the odd submodule. */
const fileArb: fc.Arbitrary<FileSpec> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom(...CONTENTS).map((data) => ({ mode: "100644" as const, data })),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(...CONTENTS).map((data) => ({ mode: "100755" as const, data })),
  },
  { weight: 1, arbitrary: fc.constant({ mode: "120000" as const, data: "x" }) },
  { weight: 1, arbitrary: fc.constant({ mode: "160000" as const, data: GITLINK }) },
);
const modelArb: fc.Arbitrary<TreeModel> = fc
  .uniqueArray(fc.tuple(fc.constantFrom(...PATHS), fileArb), {
    selector: ([p]) => p,
    maxLength: 10,
  })
  .map((entries) => new Map(entries));

/** Edit paths: the vocabulary, paths that clash with its directories, and paths no edit may name. */
const editPathArb = fc.oneof(
  { weight: 24, arbitrary: fc.constantFrom(...PATHS) },
  { weight: 3, arbitrary: fc.constantFrom("a", "a/c", "b", "a/c/x/deeper", "new/dir/f") },
  {
    weight: 1,
    arbitrary: fc.constantFrom("", "/x", "a//x", "a/./x", "a/../x", ".git/config", "a/.GIT/x"),
  },
);
const editOver = (pathArb: fc.Arbitrary<string>): fc.Arbitrary<FileEdit> =>
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .record({
          path: pathArb,
          content: fc.constantFrom(...CONTENTS),
          executable: fc.option(fc.boolean(), { nil: undefined }),
        })
        .map(({ path, content, executable }) => ({
          path,
          content: enc.encode(content),
          ...(executable === undefined ? {} : { executable }),
        })),
    },
    { weight: 1, arbitrary: pathArb.map((path) => ({ path, delete: true as const })) },
  );

/** A base tree and edits to it, most of them naming the tree's own files, so most cases apply. */
const caseArb = modelArb.chain((model) => {
  const own = [...model.keys()];
  const pathArb =
    own.length === 0
      ? editPathArb
      : fc.oneof(
          { weight: 3, arbitrary: fc.constantFrom(...own) },
          { weight: 1, arbitrary: fc.constantFrom(...own).map((p) => `${p}/deeper`) },
          { weight: 2, arbitrary: editPathArb },
        );
  return fc.tuple(fc.constant(model), fc.array(editOver(pathArb), { minLength: 1, maxLength: 4 }));
});

const text = (data: FileSpec["data"]) =>
  typeof data === "string" ? data : new TextDecoder().decode(data);

type Expected =
  | { readonly ok: true; readonly model: TreeModel; readonly changed: number }
  | { readonly ok: false; readonly reasons: ReadonlySet<EditRefusalReason> };

/**
 * The oracle: the same edits applied to a flat path → file map, with no trees
 * at all. Every rule an edit can break is collected, since the implementation
 * reports only the first it meets.
 */
function expected(model: TreeModel, edits: readonly FileEdit[]): Expected {
  const reasons = new Set<EditRefusalReason>();
  const dirs = new Set([...model.keys()].flatMap((p) => prefixes(p)));
  const paths = edits.map((e) => e.path);
  for (const [i, path] of paths.entries()) {
    const segments = path.split("/");
    if (segments.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")) {
      reasons.add("bad-path");
      continue;
    }
    if (paths.indexOf(path) !== i) reasons.add("duplicate-path");
    if (paths.some((other) => other.startsWith(`${path}/`))) reasons.add("nested-paths");
  }
  for (const edit of edits) {
    if (reasons.has("bad-path")) break;
    const through = prefixes(edit.path).some((p) => model.has(p));
    if (through) reasons.add("through-file");
    else if (dirs.has(edit.path)) reasons.add("is-directory");
    else if ("delete" in edit) {
      if (!model.has(edit.path)) reasons.add("missing");
    } else {
      const mode = model.get(edit.path)?.mode;
      if (mode === MODE_SYMLINK || mode === MODE_GITLINK) reasons.add("not-a-file");
    }
  }
  if (reasons.size > 0) return { ok: false, reasons };
  const next = new Map(model);
  let changed = 0;
  for (const edit of edits) {
    const before = model.get(edit.path);
    if ("delete" in edit) {
      next.delete(edit.path);
      changed += 1;
      continue;
    }
    const mode: Mode =
      edit.executable === undefined
        ? before?.mode === MODE_EXEC
          ? "100755"
          : "100644"
        : edit.executable
          ? "100755"
          : "100644";
    const data = new TextDecoder().decode(edit.content);
    if (before === undefined || before.mode !== mode || text(before.data) !== data) changed += 1;
    next.set(edit.path, { mode, data });
  }
  return { ok: true, model: next, changed };
}

/** Every directory above a path: `a/c/x` → `a`, `a/c`. */
function prefixes(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join("/"));
}

/** Every object id a tree reaches, read from the base store or the edit's new objects. */
function reachable(store: MemoryStore, extra: ReadonlyMap<string, GitObject>, tree: string) {
  const found = new Set<string>();
  const walk = (oid: string) => {
    found.add(oid);
    const o = extra.get(oid) ?? store.objects.get(oid);
    if (o?.type !== "tree") throw new MissingObject(oid);
    for (const e of decodeTree(o.body)) {
      if (e.mode === MODE_TREE) walk(e.oid);
      else if (e.mode !== MODE_GITLINK) {
        if (!extra.has(e.oid) && !store.objects.has(e.oid)) throw new MissingObject(e.oid);
        found.add(e.oid);
      }
    }
  };
  walk(tree);
  return found;
}

describe("applyEdits", () => {
  it(
    "[edit.differential] equals the tree rebuilt from scratch, refuses exactly what the flat model refuses, and writes every object the new tree lacks",
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArb, async ([model, edits]) => {
          const store = new MemoryStore();
          const base = await store.write(model);
          const want = expected(model, edits);
          const got = await applyEdits(store, base, edits).catch((e: unknown) => {
            if (e instanceof EditRefused) return e;
            throw e;
          });
          // One comparison per case: a refusal for a reason the model also finds, or the
          // rebuilt tree, its count, and (when nothing changed) the base left untouched.
          const outcome =
            got instanceof EditRefused
              ? {
                  refused:
                    !want.ok && want.reasons.has(got.reason)
                      ? "a reason the model finds"
                      : got.reason,
                }
              : {
                  tree: got.tree,
                  changed: got.changed,
                  reaches: reachable(store, got.newObjects, got.tree).size > 0,
                  untouchedWhenUnchanged:
                    got.changed > 0 || (got.tree === base && got.newObjects.size === 0),
                };
          expect(outcome).toEqual(
            want.ok
              ? {
                  tree: await new MemoryStore().write(want.model),
                  changed: want.changed,
                  reaches: true,
                  untouchedWhenUnchanged: true,
                }
              : { refused: "a reason the model finds" },
          );
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it("[edit.prunes-empty] drops a directory its last file leaves, all the way up", async () => {
    const store = new MemoryStore();
    const base = await store.write(
      new Map<string, FileSpec>([
        ["a/c/x", { mode: "100644", data: "one\n" }],
        ["y", { mode: "100644", data: "two\n" }],
      ]),
    );
    const got = await applyEdits(store, base, [{ path: "a/c/x", delete: true }]);
    expect(got.tree).toBe(
      await new MemoryStore().write(new Map([["y", { mode: "100644", data: "two\n" }]])),
    );
  });

  it("[edit.keeps-mode] keeps an executable file executable unless the edit says otherwise", async () => {
    const store = new MemoryStore();
    const base = await store.write(new Map([["run", { mode: "100755", data: "one\n" }]]));
    const kept = await applyEdits(store, base, [{ path: "run", content: enc.encode("two\n") }]);
    const entry = decodeTree(kept.newObjects.get(kept.tree)?.body ?? new Uint8Array())[0];
    expect(entry?.mode).toBe(MODE_EXEC);
    const plain = await applyEdits(store, base, [
      { path: "run", content: enc.encode("two\n"), executable: false },
    ]);
    const changed = decodeTree(plain.newObjects.get(plain.tree)?.body ?? new Uint8Array())[0];
    expect(changed?.mode).toBe(MODE_FILE);
  });

  it("[edit.reads-only-the-path] opens no tree off the edited paths", async () => {
    const store = new MemoryStore();
    const model = new Map<string, FileSpec>(
      PATHS.map((p) => [p, { mode: "100644", data: `${p}\n` }]),
    );
    const base = await store.write(model);
    const trees = store.trees(base);
    store.reads.length = 0;
    await applyEdits(store, base, [{ path: "a/c/x", content: enc.encode("new\n") }]);
    expect(new Set(store.reads)).toEqual(
      new Set([trees.get(""), trees.get("a"), trees.get("a/c")]),
    );
    expect(store.reads).toHaveLength(3);
  });

  it("[edit.through-file] refuses a write or a delete whose path runs through a file or a symlink", async () => {
    const store = new MemoryStore();
    const base = await store.write(
      new Map<string, FileSpec>([
        ["a/x", { mode: "100644", data: "one\n" }],
        ["link", { mode: "120000", data: "a" }],
      ]),
    );
    for (const edit of [
      { path: "a/x/y", content: enc.encode("two\n") },
      { path: "a/x/y", delete: true as const },
      { path: "link/y", content: enc.encode("two\n") },
    ]) {
      const refused = await applyEdits(store, base, [edit]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(refused instanceof EditRefused ? [refused.reason, refused.path] : refused).toEqual([
        "through-file",
        edit.path,
      ]);
    }
  });

  it("[edit.bad-path] refuses .git in any case, dot segments and empty segments before reading anything", async () => {
    const store = new MemoryStore();
    const base = await store.write(new Map([["x", { mode: "100644", data: "one\n" }]]));
    for (const path of [".git/hooks/pre-commit", "a/.Git/x", "../x", "a/./x", "a//x", "/x", ""]) {
      store.reads.length = 0;
      const refused = await applyEdits(store, base, [{ path, content: enc.encode("x") }]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(EditRefused);
      expect(refused instanceof EditRefused ? refused.reason : undefined).toBe("bad-path");
      expect(store.reads).toEqual([]);
    }
  });
});
