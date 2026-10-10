// workspace-git: a client-side library for Worker-hosted clients (load
// generator, example swarm agents). It clones an agent's workspace repo into
// memory, commits with trailers and pushes. It is never Keel's own git path.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemFs } from "./memfs";

export const DIR = "/ws";

/** How the token is presented to the git remote. Never put a token in the URL. */
export type AuthMode =
  | "bearer" // Authorization: Bearer <full token>
  | "basic" // Basic, password = token part before "?expires="
  | "basic-full" // Basic, password = full token including "?expires=<unix>"
  | "basic-bad"; // Basic, password = token part with its last character changed (must be refused)

export function authHeaders(token: string, mode: AuthMode): Record<string, string> {
  if (mode === "bearer") return { Authorization: `Bearer ${token}` };
  const part = token.split("?expires=")[0];
  const password =
    mode === "basic" ? part : mode === "basic-full" ? token : part.slice(0, -1) + (part.endsWith("0") ? "1" : "0");
  return { Authorization: `Basic ${btoa(`x:${password}`)}` };
}

/** Token layout with secret material replaced by lengths, safe to log. */
export function tokenShape(token: string): string {
  return token.replace(/[0-9a-fA-F]{8,}/g, (m) => `<hex${m.length}>`).replace(/expires=\d+/, "expires=<unix>");
}

/** Strip anything token-like or credential-bearing before it reaches a log or a response. */
export function redact(s: string): string {
  // Live tokens are art_v1_<hex> or art_v2_x_<hex>, each with ?expires=<unix>.
  // The remote host also embeds the account id.
  return s
    .replace(/art_v\d+_[A-Za-z0-9_]+(\?expires=\d+)?/g, "art_<redacted>")
    .replace(/[0-9a-f]{32}\.artifacts\./g, "<account>.artifacts.")
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/=._?-]+/g, "$1 <redacted>")
    .replace(/\/\/[^/@\s]+@/g, "//<redacted>@");
}

export function describeError(e: unknown): { name: string; code?: string; status?: number; message: string } {
  const err = e as { name?: string; code?: string; message?: string; data?: { statusCode?: number } };
  return {
    name: err?.name ?? "Error",
    code: err?.code,
    status: err?.data?.statusCode,
    message: redact(String(err?.message ?? e)).slice(0, 400),
  };
}

/** One smart-HTTP exchange: time to response headers and to the end of the body. */
export interface HttpEvent {
  op: string;
  status: number;
  headersMs: number;
  totalMs: number;
  reqBytes: number;
  resBytes: number;
}

type HttpClient = typeof http;
type GitHttpResponse = Awaited<ReturnType<HttpClient["request"]>>;

/** Wrap the web http client so every request/response is timed and sized. */
export function timedHttp(log: HttpEvent[]): HttpClient {
  return {
    async request(req) {
      const u = new URL(req.url);
      const op = `${req.method} ${u.pathname.split("/").pop()}${u.searchParams.get("service") ? `?${u.searchParams.get("service")}` : ""}`;
      let reqBytes = 0;
      if (req.body) {
        const chunks: Uint8Array[] = [];
        for await (const c of req.body as AsyncIterable<Uint8Array>) {
          chunks.push(c);
          reqBytes += c.byteLength;
        }
        req = {
          ...req,
          body: (async function* () {
            yield* chunks;
          })(),
        };
      }
      const t0 = Date.now();
      const res: GitHttpResponse = await http.request(req);
      const ev: HttpEvent = { op, status: res.statusCode, headersMs: Date.now() - t0, totalMs: 0, reqBytes, resBytes: 0 };
      log.push(ev);
      const inner = res.body;
      if (!inner) {
        ev.totalMs = ev.headersMs;
        return res;
      }
      async function* body() {
        for await (const c of inner as AsyncIterable<Uint8Array>) {
          ev.resBytes += c.byteLength;
          yield c;
        }
        ev.totalMs = Date.now() - t0;
      }
      return { ...res, body: body() };
    },
  };
}

export interface Workspace {
  fs: MemFs;
  dir: string;
  head: string | null;
  /** Local branch that commits advance and pushes send. */
  branch: string;
  http: HttpClient;
  httpLog: HttpEvent[];
}

export interface CloneOpts {
  url: string;
  headers: Record<string, string>;
  ref?: string;
  /** Skip the working tree; edits are applied as object writes. */
  noCheckout?: boolean;
}

export async function cloneWorkspace(o: CloneOpts): Promise<Workspace> {
  const fs = new MemFs();
  const httpLog: HttpEvent[] = [];
  const client = timedHttp(httpLog);
  await git.clone({
    fs,
    http: client,
    dir: DIR,
    url: o.url,
    ref: o.ref ?? "main",
    headers: o.headers,
    depth: 1,
    singleBranch: true,
    noTags: true,
    noCheckout: o.noCheckout ?? true,
  });
  const head = await git.resolveRef({ fs, dir: DIR, ref: "HEAD" }).catch(() => null);
  const branch = (await git.currentBranch({ fs, dir: DIR })) ?? o.ref ?? "main";
  return { fs, dir: DIR, head, branch, http: client, httpLog };
}

/** Start a workspace for a repo that has no commits yet. */
export async function initWorkspace(url: string, branch = "main"): Promise<Workspace> {
  const fs = new MemFs();
  await git.init({ fs, dir: DIR, defaultBranch: branch });
  await git.addRemote({ fs, dir: DIR, remote: "origin", url });
  const httpLog: HttpEvent[] = [];
  return { fs, dir: DIR, head: null, branch, http: timedHttp(httpLog), httpLog };
}

export interface Edit {
  path: string;
  content: string;
}

export interface CommitOpts {
  subject: string;
  body?: string;
  trailers: Record<string, string>;
  author?: { name: string; email: string };
}

export function formatMessage(o: CommitOpts): string {
  const trailerBlock = Object.entries(o.trailers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return [o.subject, o.body, trailerBlock].filter(Boolean).join("\n\n") + "\n";
}

/** Parse the trailer block (last paragraph of key: value lines) of a commit message. */
export function parseTrailers(message: string): Record<string, string> {
  const paras = message.trimEnd().split(/\n\s*\n/);
  const last = paras[paras.length - 1] ?? "";
  const out: Record<string, string> = {};
  for (const line of last.split("\n")) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!m) return {};
    out[m[1]] = m[2];
  }
  return paras.length > 1 ? out : {};
}

type TreeEntry = { mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" };

/** Write `blobOid` at `parts` below `treeOid` (or a new tree), returning the new tree oid. */
async function putPath(ws: Workspace, treeOid: string | null, parts: string[], blobOid: string): Promise<string> {
  const entries: TreeEntry[] = treeOid
    ? ((await git.readTree({ fs: ws.fs, dir: ws.dir, oid: treeOid })).tree as TreeEntry[])
    : [];
  const [name, ...rest] = parts;
  const idx = entries.findIndex((e) => e.path === name);
  let entry: TreeEntry;
  if (rest.length === 0) {
    entry = { mode: "100644", path: name, oid: blobOid, type: "blob" };
  } else {
    const sub = idx >= 0 && entries[idx].type === "tree" ? entries[idx].oid : null;
    entry = { mode: "040000", path: name, oid: await putPath(ws, sub, rest, blobOid), type: "tree" };
  }
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  return git.writeTree({ fs: ws.fs, dir: ws.dir, tree: entries });
}

const AUTHOR = { name: "keel-loadgen", email: "loadgen@keel.invalid" };

/**
 * Commit edits without a working tree: write blobs, rewrite the touched
 * trees, write the commit and advance the current branch. Works on a
 * `noCheckout` shallow clone and on an empty, freshly initialised repo.
 */
export async function commitEdits(ws: Workspace, edits: Edit[], o: CommitOpts): Promise<string> {
  let tree: string | null = null;
  if (ws.head) tree = (await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: ws.head })).commit.tree;
  for (const e of edits) {
    const blob = await git.writeBlob({ fs: ws.fs, dir: ws.dir, blob: new TextEncoder().encode(e.content) });
    tree = await putPath(ws, tree, e.path.split("/"), blob);
  }
  if (tree === null) throw new Error("no edits");
  // `ref` deliberately omitted: commit({ ref: 'main' }) writes .git/main
  // rather than refs/heads/main. Without it the commit advances HEAD's branch.
  const oid = await git.commit({
    fs: ws.fs,
    dir: ws.dir,
    message: formatMessage(o),
    author: o.author ?? AUTHOR,
    tree,
    parent: ws.head ? [ws.head] : [],
  });
  ws.head = oid;
  return oid;
}

/** Commit edits the conventional way: write files into a checked-out tree, add, commit. */
export async function commitEditsCheckout(ws: Workspace, edits: Edit[], o: CommitOpts): Promise<string> {
  for (const e of edits) {
    const full = `${ws.dir}/${e.path}`;
    const segs = e.path.split("/").slice(0, -1);
    let d = ws.dir;
    for (const s of segs) {
      d = `${d}/${s}`;
      await ws.fs.mkdir(d).catch(() => undefined);
    }
    await ws.fs.writeFile(full, e.content);
    await git.add({ fs: ws.fs, dir: ws.dir, filepath: e.path });
  }
  const oid = await git.commit({ fs: ws.fs, dir: ws.dir, message: formatMessage(o), author: o.author ?? AUTHOR });
  ws.head = oid;
  return oid;
}

export async function pushWorkspace(
  ws: Workspace,
  o: { headers: Record<string, string>; remoteRef?: string },
): Promise<void> {
  await git.push({
    fs: ws.fs,
    http: ws.http,
    dir: ws.dir,
    remote: "origin",
    ref: ws.branch,
    remoteRef: o.remoteRef ?? ws.branch,
    headers: o.headers,
  });
}
