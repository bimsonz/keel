// An in-memory object store built with gitcore's own encoder. It records every
// tree read, so a property can say exactly which trees a diff had to open.

import { enc } from "../src/bytes.ts";
import { MissingObject, type TreeReader } from "../src/diff.ts";
import { decodeTree, encodeTree, type GitObject, hashObject, MODE_GITLINK, MODE_TREE, type TreeEntry } from "../src/objects.ts";
import type { TreeModel } from "./git-harness.ts";

/** A leaf as a flat listing sees it. */
export interface Leaf {
  readonly mode: string;
  readonly oid: string;
}

export class MemoryStore implements TreeReader {
  readonly objects = new Map<string, GitObject>();
  readonly reads: string[] = [];

  readTree(oid: string): Promise<readonly TreeEntry[]> {
    this.reads.push(oid);
    return Promise.resolve(this.tree(oid));
  }

  /** Reads a tree without recording it. */
  tree(oid: string): TreeEntry[] {
    const o = this.objects.get(oid);
    if (o?.type !== "tree") throw new MissingObject(oid);
    return decodeTree(o.body);
  }

  private async put(type: "blob" | "tree", body: Uint8Array): Promise<string> {
    const oid = await hashObject(type, body);
    this.objects.set(oid, { type, body });
    return oid;
  }

  /** Writes a flat path → file model as nested trees and returns the root tree id. */
  async write(model: TreeModel): Promise<string> {
    const here: TreeEntry[] = [];
    const dirs = new Map<string, TreeModel>();
    for (const [path, file] of model) {
      const slash = path.indexOf("/");
      if (slash >= 0) {
        const dir = path.slice(0, slash);
        const below = dirs.get(dir) ?? new Map();
        below.set(path.slice(slash + 1), file);
        dirs.set(dir, below);
      } else if (file.mode === MODE_GITLINK) {
        here.push({ name: path, mode: file.mode, oid: String(file.data) });
      } else {
        const body = typeof file.data === "string" ? enc.encode(file.data) : file.data;
        here.push({ name: path, mode: file.mode, oid: await this.put("blob", body) });
      }
    }
    for (const [dir, below] of dirs) here.push({ name: dir, mode: MODE_TREE, oid: await this.write(below) });
    return this.put("tree", encodeTree(here));
  }

  /** Every leaf under a tree, by path. */
  leaves(oid: string, prefix = "", out = new Map<string, Leaf>()): Map<string, Leaf> {
    for (const e of this.tree(oid)) {
      const path = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.mode === MODE_TREE) this.leaves(e.oid, path, out);
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
    return out;
  }

  /** Every tree under (and including) a tree, by path; the root is "". */
  trees(oid: string, prefix = "", out = new Map<string, string>()): Map<string, string> {
    out.set(prefix, oid);
    for (const e of this.tree(oid)) {
      if (e.mode === MODE_TREE) this.trees(e.oid, prefix === "" ? e.name : `${prefix}/${e.name}`, out);
    }
    return out;
  }
}
