// Applying file edits to a stored tree: the trees on an edited path are
// rebuilt, every other subtree is kept by id, and a directory left empty is
// dropped, as git never stores one. Nothing is read but the trees on the paths.

import type { TreeReader } from "./diff.ts";
import {
  encodeTree,
  type GitObject,
  hashObject,
  MODE_EXEC,
  MODE_FILE,
  MODE_TREE,
  type TreeEntry,
} from "./objects.ts";

/** A file's new content at a path, or its deletion. */
export type FileEdit =
  | {
      readonly path: string;
      readonly content: Uint8Array;
      /** Absent keeps an existing file's mode, and makes a new file plain. */
      readonly executable?: boolean | undefined;
    }
  | { readonly path: string; readonly delete: true };

export type EditRefusalReason =
  /** Empty, absolute, or with an empty, `.`, `..` or `.git` segment. */
  | "bad-path"
  /** Two edits name the same path. */
  | "duplicate-path"
  /** One edit's path lies under another's. */
  | "nested-paths"
  /** The path runs through something that is not a directory. */
  | "through-file"
  /** The path is a directory. */
  | "is-directory"
  /** The file to delete is not there. */
  | "missing"
  /** A write onto a symlink or a submodule. */
  | "not-a-file";

/** The edits cannot be applied; `path` is the first edit, in path order, that fails. */
export class EditRefused extends Error {
  constructor(
    readonly reason: EditRefusalReason,
    readonly path: string,
  ) {
    super(`edit refused: ${reason} at ${path}`);
  }
}

export interface EditedTree {
  readonly tree: string;
  /** The blobs and trees the edit wrote that the base tree does not hold. */
  readonly newObjects: ReadonlyMap<string, GitObject>;
  /** Paths whose file, or mode, now differs from the base. */
  readonly changed: number;
}

interface EditNode {
  edit?: FileEdit;
  /** The edit's full path, kept to name it in a refusal. */
  path?: string;
  readonly children: Map<string, EditNode>;
}

function segmentsOf(path: string): string[] {
  const segments = path.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === ".." || s.toLowerCase() === ".git" || s.includes("\0"))
      throw new EditRefused("bad-path", path);
  }
  return segments;
}

/** The edits as a tree of names, refusing duplicates and an edit under another. */
function trieOf(edits: readonly FileEdit[]): EditNode {
  const root: EditNode = { children: new Map() };
  for (const edit of edits.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    let node = root;
    for (const segment of segmentsOf(edit.path)) {
      if (node.edit !== undefined) throw new EditRefused("nested-paths", edit.path);
      let next = node.children.get(segment);
      if (next === undefined) {
        next = { children: new Map() };
        node.children.set(segment, next);
      }
      node = next;
    }
    if (node.edit !== undefined) throw new EditRefused("duplicate-path", edit.path);
    if (node.children.size > 0) throw new EditRefused("nested-paths", edit.path);
    node.edit = edit;
    node.path = edit.path;
  }
  return root;
}

const joinPath = (prefix: string, name: string) => (prefix === "" ? name : `${prefix}/${name}`);

async function put(
  out: Map<string, GitObject>,
  type: "blob" | "tree",
  body: Uint8Array,
): Promise<string> {
  const oid = await hashObject(type, body);
  out.set(oid, { type, body });
  return oid;
}

interface Rebuilt {
  /** The rebuilt tree's id, or null when nothing is left in it. */
  readonly oid: string | null;
  readonly changed: number;
}

async function rebuild(
  reader: TreeReader,
  base: string | null,
  node: EditNode,
  prefix: string,
  out: Map<string, GitObject>,
): Promise<Rebuilt> {
  const entries = new Map<string, TreeEntry>(
    base === null ? [] : (await reader.readTree(base)).map((e) => [e.name, e]),
  );
  let changed = 0;
  for (const name of [...node.children.keys()].toSorted()) {
    const child = node.children.get(name);
    if (child === undefined) continue;
    const existing = entries.get(name);
    const edit = child.edit;
    if (edit === undefined) {
      if (existing !== undefined && existing.mode !== MODE_TREE)
        throw new EditRefused("through-file", firstPath(child));
      const below = await rebuild(
        reader,
        existing?.oid ?? null,
        child,
        joinPath(prefix, name),
        out,
      );
      changed += below.changed;
      if (below.oid === null) entries.delete(name);
      else entries.set(name, { name, mode: MODE_TREE, oid: below.oid });
      continue;
    }
    if (existing?.mode === MODE_TREE) throw new EditRefused("is-directory", edit.path);
    if ("delete" in edit) {
      if (existing === undefined) throw new EditRefused("missing", edit.path);
      entries.delete(name);
      changed += 1;
      continue;
    }
    if (existing !== undefined && existing.mode !== MODE_FILE && existing.mode !== MODE_EXEC)
      throw new EditRefused("not-a-file", edit.path);
    const mode =
      edit.executable === undefined
        ? (existing?.mode ?? MODE_FILE)
        : edit.executable
          ? MODE_EXEC
          : MODE_FILE;
    const blobs = new Map<string, GitObject>();
    const oid = await put(blobs, "blob", edit.content);
    if (existing?.oid === oid && existing.mode === mode) continue;
    if (existing?.oid !== oid) for (const [id, o] of blobs) out.set(id, o);
    entries.set(name, { name, mode, oid });
    changed += 1;
  }
  if (entries.size === 0 && prefix !== "") return { oid: null, changed };
  const body = encodeTree([...entries.values()]);
  const oid = await hashObject("tree", body);
  if (oid !== base) out.set(oid, { type: "tree", body });
  return { oid, changed };
}

/** The first edit's path under a node, in path order: where a refusal at the node is reported. */
function firstPath(node: EditNode): string {
  if (node.path !== undefined) return node.path;
  const first = [...node.children.keys()].toSorted()[0];
  const child = first === undefined ? undefined : node.children.get(first);
  return child === undefined ? "" : firstPath(child);
}

/**
 * Applies `edits` to the tree `base`. Only the trees on edited paths are
 * read and rebuilt; a directory an edit empties is dropped. Throws
 * `EditRefused` for edits that cannot apply, and `MissingObject` for a tree
 * the reader lacks.
 */
export async function applyEdits(
  reader: TreeReader,
  base: string,
  edits: readonly FileEdit[],
): Promise<EditedTree> {
  const trie = trieOf(edits);
  const out = new Map<string, GitObject>();
  const { oid, changed } = await rebuild(reader, base, trie, "", out);
  if (oid === null) throw new Error("unreachable: the root tree is always written");
  return { tree: oid, newObjects: out, changed };
}
