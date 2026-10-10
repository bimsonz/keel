// keel-spike-12-client: drives workspace-git cycles against Artifacts from a
// deployed Worker so that wall time and CPU are measured on the edge.
import {
  type AuthMode,
  type Edit,
  type Workspace,
  authHeaders,
  cloneWorkspace,
  commitEdits,
  commitEditsCheckout,
  describeError,
  initWorkspace,
  parseTrailers,
  pushWorkspace,
  tokenShape,
} from "./workspace-git";
import { ulid } from "./ulid";

type AppEnv = Env & { SPIKE_KEY: string };

const SEED = "seed";
const SEED_DIRS = ["src/core", "src/util", "docs", "test"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json" } });

function dispose(stub: unknown) {
  const d = (stub as { [Symbol.dispose]?: () => void })?.[Symbol.dispose];
  if (typeof d === "function") d.call(stub);
}

async function getRepo(env: AppEnv, name: string, waitMs = 20_000): Promise<ArtifactsRepo> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await env.ARTIFACTS.get(name);
    } catch (e) {
      const code = (e as { code?: string }).code;
      const busy = code === "FORK_IN_PROGRESS" || code === "CREATE_IN_PROGRESS";
      if (!busy || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Three edits to existing seed files, chosen per cycle. */
function pickEdits(changeId: string): Edit[] {
  const r = crypto.getRandomValues(new Uint8Array(3));
  return [0, 1, 2].map((i) => {
    const dir = SEED_DIRS[i];
    const n = String(r[i] % 50).padStart(3, "0");
    return { path: `${dir}/file-${n}.txt`, content: `edited by ${changeId} (edit ${i})\n` };
  });
}

async function cycle(env: AppEnv, p: URLSearchParams, colo: string) {
  const wsParam = p.get("ws") ?? "fork";
  const flow = p.get("flow") === "checkout" ? "checkout" : "tree";
  const auth = (p.get("auth") ?? "bearer") as AuthMode | "read";
  const branch = p.get("branch") ?? "main";
  const verify = p.get("verify") !== "0";
  // n > 1: one clone, then n commit+push cycles on the same in-memory workspace.
  const n = Math.min(Math.max(Number(p.get("n") ?? 1) || 1, 1), 20);
  const session = p.get("session") ?? `S-${ulid()}`;

  const t: Record<string, number> = {};
  let mark = Date.now();
  const lap = (k: string) => {
    const now = Date.now();
    t[k] = now - mark;
    mark = now;
  };
  let phase = "setup";
  let name = wsParam;
  let repo: ArtifactsRepo | undefined;
  let ws: Workspace | undefined;
  let memfs: { bytes: number; peakBytes: number; files: number } | undefined;
  let shape: string | undefined;
  const warm: { commit: number; push: number }[] = [];
  const commits: { oid: string; changeId: string }[] = [];
  try {
    if (wsParam === "fork") {
      phase = "fork";
      name = `ws-${ulid().toLowerCase()}`;
      const seed = await env.ARTIFACTS.get(SEED);
      try {
        await seed.fork(name);
      } finally {
        dispose(seed);
      }
    }
    repo = await getRepo(env, name);
    lap("fork");
    phase = "info";
    const info = await repo.info();
    lap("info");
    phase = "token";
    const tok = await repo.createToken(auth === "read" ? "read" : "write", 600);
    const headers = authHeaders(tok.plaintext, auth === "read" ? "bearer" : auth);
    shape = `${tok.scope} ${tokenShape(tok.plaintext)}`;
    lap("token");

    phase = "clone";
    // A named branch is cloned at its own tip when it exists, else from main.
    try {
      ws = await cloneWorkspace({ url: info.remote, headers, ref: branch, noCheckout: flow === "tree" });
    } catch (e) {
      // Any real failure (auth, network) recurs on the fallback clone and is thrown there.
      if (branch === "main") throw e;
      ws = await cloneWorkspace({ url: info.remote, headers, ref: "main", noCheckout: flow === "tree" });
    }
    lap("clone");

    for (let k = 0; k < n; k++) {
      phase = "commit";
      const changeId = `I${ulid()}`;
      const edits = pickEdits(changeId);
      const msg = {
        subject: `loadgen: edit ${edits.length} files`,
        body: `Session ${session} cycle.`,
        trailers: { "Change-Id": changeId, "MFP-Session": session },
      };
      const oid = flow === "tree" ? await commitEdits(ws, edits, msg) : await commitEditsCheckout(ws, edits, msg);
      commits.push({ oid, changeId });
      lap("commit");
      phase = "push";
      await pushWorkspace(ws, { headers, remoteRef: branch });
      lap("push");
      if (k > 0) warm.push({ commit: t.commit, push: t.push });
      else {
        t.commit1 = t.commit;
        t.push1 = t.push;
      }
    }
    t.commit = t.commit1;
    t.push = t.push1;
    delete t.commit1;
    delete t.push1;
    memfs = { bytes: ws.fs.bytes, peakBytes: ws.fs.peakBytes, files: ws.fs.fileCount() };

    let verified: boolean | null = null;
    let seen: Record<string, string> = {};
    if (verify) {
      phase = "verify";
      const log = await repo.log({ ref: branch, limit: n });
      const want = [...commits].reverse();
      const expectWrong = p.get("expect") === "wrong";
      verified = log.length === n;
      for (let k = 0; k < n && verified; k++) {
        const c = await repo.readCommit(want[k].oid);
        seen = parseTrailers(c?.message ?? "");
        const expectId = expectWrong ? `I${ulid()}` : want[k].changeId;
        verified =
          log[k]?.hash === want[k].oid && seen["Change-Id"] === expectId && seen["MFP-Session"] === session;
      }
      lap("verify");
    }
    const cycleMs = t.clone + t.commit + t.push;
    const out = {
      ok: true, colo, ws: name, flow, auth, token: shape, branch, n, oid: commits[commits.length - 1].oid, verified,
      trailers: seen, cycleMs, t, warm, memfs, http: ws.httpLog,
    };
    console.log(JSON.stringify({ tag: "cycle", ...out, trailers: undefined, http: undefined }));
    return json(out);
  } catch (e) {
    lap(phase);
    const out = { ok: false, colo, ws: name, flow, auth, token: shape, branch, phase, error: describeError(e), t, memfs, http: ws?.httpLog };
    console.log(JSON.stringify({ tag: "cycle", ...out, http: undefined }));
    return json(out, 502);
  } finally {
    dispose(repo);
  }
}

/** Create a brand-new empty repo, try to clone it, then init + commit + push into it. */
async function emptyRepo(env: AppEnv) {
  const name = `empty-${ulid().toLowerCase()}`;
  const t: Record<string, number> = {};
  let mark = Date.now();
  const lap = (k: string) => {
    const now = Date.now();
    t[k] = now - mark;
    mark = now;
  };
  const steps: Record<string, unknown> = {};
  let repo: ArtifactsRepo | undefined;
  try {
    const created = await env.ARTIFACTS.create(name);
    lap("create");
    const headers = authHeaders(created.token, "bearer");
    try {
      const ws = await cloneWorkspace({ url: created.remote, headers });
      steps.cloneEmpty = { ok: true, head: ws.head };
    } catch (e) {
      steps.cloneEmpty = { ok: false, error: describeError(e) };
    }
    lap("cloneEmpty");
    const ws = await initWorkspace(created.remote);
    const changeId = `I${ulid()}`;
    const session = `S-${ulid()}`;
    const edits: Edit[] = ["README.md", "src/a.txt", "src/b/c.txt"].map((path) => ({
      path,
      content: `first content for ${path}\n`,
    }));
    const oid = await commitEdits(ws, edits, {
      subject: "workspace: initial commit",
      trailers: { "Change-Id": changeId, "MFP-Session": session },
    });
    lap("commit");
    try {
      await pushWorkspace(ws, { headers });
      steps.push = { ok: true, oid };
    } catch (e) {
      steps.push = { ok: false, error: describeError(e) };
    }
    lap("push");
    repo = await getRepo(env, name);
    const [head] = await repo.log({ ref: "main", limit: 1 });
    const c = await repo.readCommit(oid);
    const seen = parseTrailers(c?.message ?? "");
    const info = await repo.info();
    steps.verify = {
      headIsOurs: head?.hash === oid,
      trailers: seen,
      verified: head?.hash === oid && seen["Change-Id"] === changeId && seen["MFP-Session"] === session,
      defaultBranch: info.defaultBranch,
      lastPushAt: info.lastPushAt,
    };
    lap("verify");
    // Second cycle against the now non-empty repo through the normal path.
    const ws2 = await cloneWorkspace({ url: created.remote, headers });
    const oid2 = await commitEdits(ws2, [{ path: "src/a.txt", content: "second\n" }], {
      subject: "workspace: second commit",
      trailers: { "Change-Id": `I${ulid()}`, "MFP-Session": session },
    });
    await pushWorkspace(ws2, { headers });
    const [head2] = await repo.log({ ref: "main", limit: 2 });
    steps.secondCycle = { ok: head2?.hash === oid2, parentIsFirst: head2?.parents[0] === oid };
    lap("secondCycle");
    const out = { ok: true, repo: name, steps, t };
    console.log(JSON.stringify({ tag: "empty", ...out }));
    return json(out);
  } catch (e) {
    const out = { ok: false, repo: name, steps, error: describeError(e), t };
    console.log(JSON.stringify({ tag: "empty", ...out }));
    return json(out, 502);
  } finally {
    dispose(repo);
  }
}

async function listRepos(env: AppEnv): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARTIFACTS.list({ limit: 200, cursor });
    names.push(...page.repos.map((r) => r.name));
    cursor = page.cursor;
  } while (cursor);
  return names;
}

export default {
  async fetch(req: Request, env: AppEnv): Promise<Response> {
    if (!env.SPIKE_KEY || req.headers.get("x-spike-key") !== env.SPIKE_KEY) return json({ error: "forbidden" }, 403);
    const url = new URL(req.url);
    const p = url.searchParams;
    switch (url.pathname) {
      case "/cycle":
        return cycle(env, p, String((req as { cf?: { colo?: string } }).cf?.colo ?? "?"));
      case "/empty":
        return emptyRepo(env);
      case "/fork": {
        const name = p.get("name") ?? `ws-${ulid().toLowerCase()}`;
        const t0 = Date.now();
        const seed = await env.ARTIFACTS.get(SEED);
        try {
          await seed.fork(name);
        } finally {
          dispose(seed);
        }
        const repo = await getRepo(env, name);
        const info = await repo.info();
        dispose(repo);
        return json({ name, forkMs: Date.now() - t0, source: info.source, defaultBranch: info.defaultBranch });
      }
      case "/list":
        return json({ repos: await listRepos(env) });
      case "/cleanup": {
        const keep = new Set(p.getAll("keep"));
        const deleted: string[] = [];
        for (const name of await listRepos(env)) {
          if (keep.has(name)) continue;
          if (await env.ARTIFACTS.delete(name)) deleted.push(name);
        }
        return json({ deleted: deleted.length, remaining: await listRepos(env) });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  },
} satisfies ExportedHandler<AppEnv>;
