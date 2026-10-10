// Minimal in-memory filesystem for isomorphic-git inside a Worker.
//
// isomorphic-git detects a promise-based fs by calling readFile() with no
// arguments and checking for a thenable, so every method is an `async`
// function that throws. Returning Promise.reject() from a plain function
// makes some operations hang, so do not do that.

type Node =
  | { kind: "dir"; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; mode: number; mtimeMs: number }
  | { kind: "symlink"; target: string; mtimeMs: number };

class FsError extends Error {
  code: string;
  constructor(code: string, op: string, path: string) {
    super(`${code}: ${op} '${path}'`);
    this.code = code;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function parent(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function encodingOf(opts: unknown): string | undefined {
  if (typeof opts === "string") return opts;
  if (opts && typeof opts === "object" && "encoding" in opts) {
    return (opts as { encoding?: string }).encoding;
  }
  return undefined;
}

let inoSeq = 1;

function statOf(node: Node, size: number) {
  const ino = inoSeq++;
  const isDir = node.kind === "dir";
  const mode = node.kind === "file" ? node.mode : isDir ? 0o40755 : 0o120000;
  return {
    type: isDir ? "dir" : node.kind === "file" ? "file" : "symlink",
    mode,
    size,
    ino,
    dev: 1,
    uid: 1,
    gid: 1,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.mtimeMs,
    isFile: () => node.kind === "file",
    isDirectory: () => isDir,
    isSymbolicLink: () => node.kind === "symlink",
  };
}

export class MemFs {
  private nodes = new Map<string, Node>([["/", { kind: "dir", mtimeMs: Date.now() }]]);
  /** Bytes currently held in file contents. */
  bytes = 0;
  /** High-water mark of `bytes`. */
  peakBytes = 0;

  private need(path: string, op: string): Node {
    const n = this.nodes.get(path);
    if (!n) throw new FsError("ENOENT", op, path);
    return n;
  }

  private needParentDir(path: string, op: string): void {
    const par = this.nodes.get(parent(path));
    if (!par) throw new FsError("ENOENT", op, path);
    if (par.kind !== "dir") throw new FsError("ENOTDIR", op, path);
  }

  fileCount(): number {
    let n = 0;
    for (const v of this.nodes.values()) if (v.kind === "file") n++;
    return n;
  }

  async readFile(path?: string, opts?: unknown): Promise<Uint8Array | string> {
    if (typeof path !== "string") throw new FsError("EINVAL", "readFile", String(path));
    const p = norm(path);
    const n = this.need(p, "readFile");
    if (n.kind === "dir") throw new FsError("EISDIR", "readFile", p);
    if (n.kind === "symlink") return this.readFile(n.target, opts);
    return encodingOf(opts) === "utf8" ? dec.decode(n.data) : n.data;
  }

  async writeFile(path: string, data: Uint8Array | string, opts?: unknown): Promise<void> {
    const p = norm(path);
    this.needParentDir(p, "writeFile");
    const prev = this.nodes.get(p);
    if (prev?.kind === "dir") throw new FsError("EISDIR", "writeFile", p);
    // Copy: isomorphic-git hands us Buffer views that may share a larger pool.
    const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
    const modeOpt =
      opts && typeof opts === "object" && "mode" in opts ? (opts as { mode?: number }).mode : undefined;
    const mode = modeOpt ?? (prev?.kind === "file" ? prev.mode : 0o100644);
    if (prev?.kind === "file") this.bytes -= prev.data.byteLength;
    this.nodes.set(p, { kind: "file", data: bytes, mode, mtimeMs: Date.now() });
    this.bytes += bytes.byteLength;
    if (this.bytes > this.peakBytes) this.peakBytes = this.bytes;
  }

  async mkdir(path: string): Promise<void> {
    const p = norm(path);
    if (this.nodes.has(p)) throw new FsError("EEXIST", "mkdir", p);
    this.needParentDir(p, "mkdir");
    this.nodes.set(p, { kind: "dir", mtimeMs: Date.now() });
  }

  async rmdir(path: string): Promise<void> {
    const p = norm(path);
    const n = this.need(p, "rmdir");
    if (n.kind !== "dir") throw new FsError("ENOTDIR", "rmdir", p);
    const prefix = p === "/" ? "/" : p + "/";
    for (const k of this.nodes.keys()) {
      if (k !== p && k.startsWith(prefix)) throw new FsError("ENOTEMPTY", "rmdir", p);
    }
    this.nodes.delete(p);
  }

  async unlink(path: string): Promise<void> {
    const p = norm(path);
    const n = this.need(p, "unlink");
    if (n.kind === "dir") throw new FsError("EISDIR", "unlink", p);
    if (n.kind === "file") this.bytes -= n.data.byteLength;
    this.nodes.delete(p);
  }

  async stat(path: string) {
    const p = norm(path);
    let n = this.need(p, "stat");
    if (n.kind === "symlink") n = this.need(norm(n.target), "stat");
    return statOf(n, n.kind === "file" ? n.data.byteLength : 0);
  }

  async lstat(path: string) {
    const p = norm(path);
    const n = this.need(p, "lstat");
    const size = n.kind === "file" ? n.data.byteLength : n.kind === "symlink" ? n.target.length : 0;
    return statOf(n, size);
  }

  async readdir(path: string): Promise<string[]> {
    const p = norm(path);
    const n = this.need(p, "readdir");
    if (n.kind !== "dir") throw new FsError("ENOTDIR", "readdir", p);
    const prefix = p === "/" ? "/" : p + "/";
    const out: string[] = [];
    for (const k of this.nodes.keys()) {
      if (k.length > prefix.length && k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
        out.push(k.slice(prefix.length));
      }
    }
    return out;
  }

  async readlink(path: string): Promise<string> {
    const p = norm(path);
    const n = this.need(p, "readlink");
    if (n.kind !== "symlink") throw new FsError("EINVAL", "readlink", p);
    return n.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    const p = norm(path);
    if (this.nodes.has(p)) throw new FsError("EEXIST", "symlink", p);
    this.needParentDir(p, "symlink");
    this.nodes.set(p, { kind: "symlink", target, mtimeMs: Date.now() });
  }
}
