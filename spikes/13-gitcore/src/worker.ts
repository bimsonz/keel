// Spike 13 Worker: a Durable Object that drives GitCore against the
// Artifacts binding and the repo's smart-HTTP remote. Every route is behind a
// bearer key so the workers.dev URL cannot be used to push to the spike repos.

import { DurableObject } from "cloudflare:workers";
import { dec, toHex, ZERO_OID } from "./gitcore/bytes";
import { mergeTrees, type ObjectReader, OverlayReader } from "./gitcore/merge";
import {
  type CommitInfo,
  decodeTree,
  encodeCommit,
  type GitObject,
  hashObject,
  normaliseMode,
  type TreeEntry,
} from "./gitcore/objects";
import { inflateAt, readPack } from "./gitcore/pack-read";
import { writePack } from "./gitcore/pack-write";
import { advertise, type Remote, receivePack, uploadPack } from "./gitcore/smart-http";

interface SpikeEnv extends Env {
  SPIKE_KEY: string;
}

class BindingReader implements ObjectReader {
  calls = 0;
  constructor(private readonly repo: ArtifactsRepo) {}
  async readTree(oid: string): Promise<TreeEntry[]> {
    this.calls++;
    const t = await this.repo.readTree(oid);
    if (!t) throw new Error(`tree ${oid} missing`);
    return t.map((e) => ({ name: e.name, mode: normaliseMode(e.mode), oid: e.hash }));
  }
  async readBlob(oid: string): Promise<Uint8Array> {
    this.calls++;
    const b = await this.repo.readBlob(oid);
    if (!b) throw new Error(`blob ${oid} missing`);
    return new Uint8Array(await b.arrayBuffer());
  }
  async readCommit(oid: string): Promise<CommitInfo> {
    this.calls++;
    const c = await this.repo.readCommit(oid);
    if (!c) throw new Error(`commit ${oid} missing`);
    return { tree: c.treeHash, parents: c.parents };
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

function summarise(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1], mean: Math.round(mean * 10) / 10 };
}

function errKey(e: unknown): string {
  const x = e as { name?: string; code?: string; message?: string };
  return `${x?.name ?? "Error"}${x?.code ? `[${x.code}]` : ""}: ${String(x?.message ?? e).slice(0, 160)}`;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v, null, 2), { status, headers: { "content-type": "application/json" } });

const IDENT = { name: "Keel Composer", email: "composer@keel.town" };
/** Deterministic committer time: candidates must hash the same on every replay. */
const COMPOSE_TIME = 1_760_000_000;

/** Offset of the first object's zlib data, and its declared inflated size. */
function firstObject(pack: Uint8Array): { dataAt: number; size: number } {
  let p = 12;
  let b = pack[p++] as number;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    b = pack[p++] as number;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { dataAt: p, size };
}

/** The colo this isolate runs in, from Cloudflare's trace endpoint. */
async function doColo(): Promise<string> {
  const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace");
  return /^colo=(.*)$/m.exec(await res.text())?.[1] ?? "unknown";
}

export class SpikeDO extends DurableObject<SpikeEnv> {
  /** Sequential fast-forward pushes of an empty-change commit: advertise + receive-pack timings. */
  private async pushbench(ns: Artifacts, name: string, n: number) {
    using repo = await ns.get(name);
    const t0 = Date.now();
    const remote = await this.remote(repo, "write");
    const tokenMs = Date.now() - t0;
    const adv: number[] = [];
    const rp: number[] = [];
    const replies: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const a0 = performance.now();
      const head = (await advertise(remote, "git-receive-pack")).head as string;
      adv.push(performance.now() - a0);
      const c = await this.newCommitOn(repo, head, `pushbench ${i} ${Date.now()}`);
      const pack = await writePack([{ type: "commit", body: c.body }]);
      const p0 = performance.now();
      const r = await receivePack(remote, "refs/heads/main", head, c.oid, pack);
      rp.push(performance.now() - p0);
      replies[r.raw] = (replies[r.raw] ?? 0) + 1;
    }
    return { repo: name, doColo: await doColo(), tokenAndInfoMs: tokenMs, advertise: summarise(adv), receivePack: summarise(rp), replies };
  }

  private async remote(repo: ArtifactsRepo, scope: "read" | "write" = "write"): Promise<Remote> {
    const [info, tok] = await Promise.all([repo.info(), repo.createToken(scope, 600)]);
    return { url: info.remote, token: tok.plaintext };
  }

  private async head(repo: ArtifactsRepo): Promise<string | null> {
    const log = await repo.log({ ref: "main", limit: 1 });
    return log[0]?.hash ?? null;
  }

  /** Every tree and blob id reachable from a tree. */
  private async walk(reader: ObjectReader, tree: string, trees: string[], blobs: string[]) {
    trees.push(tree);
    for (const e of await reader.readTree(tree)) {
      if (e.mode === "40000") await this.walk(reader, e.oid, trees, blobs);
      else if (e.mode !== "160000") blobs.push(e.oid);
    }
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const q = (k: string, d = "") => url.searchParams.get(k) ?? d;
    const ns = q("ns") === "eu" ? this.env.ARTIFACTS_EU : q("ns") === "w" ? this.env.ARTIFACTS_W : this.env.ARTIFACTS;
    try {
      switch (url.pathname) {
        case "/where":
          return json({ entryColo: req.headers.get("x-entry-colo"), doColo: await doColo() });
        case "/token": {
          // Lets a local git client seed a repo whose namespace the CLI cannot see.
          using repo = await ns.get(q("repo"));
          const [info, tok] = await Promise.all([repo.info(), repo.createToken("write", 900)]);
          return json({ remote: info.remote, token: tok.plaintext });
        }
        case "/pushbench":
          return json(await this.pushbench(ns, q("repo"), Number(q("n", "10"))));
        case "/fork": {
          using src = await ns.get(q("repo"));
          const t0 = Date.now();
          const f = await src.fork(q("to"), { defaultBranchOnly: true });
          const forkMs = Date.now() - t0;
          // A fork may still be materialising; wait until reads succeed.
          let readyMs = 0;
          for (let i = 0; i < 60; i++) {
            try {
              using h = await ns.get(f.name);
              if ((await h.log({ ref: "main", limit: 1 })).length > 0) {
                readyMs = Date.now() - t0;
                break;
              }
            } catch {}
            await new Promise((r) => setTimeout(r, 500));
          }
          return json({ name: f.name, forkMs, readyMs, remoteHost: new URL(f.remote).hostname.replace(/^[0-9a-f]{32}/, "<account>") });
        }
        case "/create": {
          const r = await ns.create(q("repo"));
          return json({ name: r.name, remote: r.remote, defaultBranch: r.defaultBranch });
        }
        case "/delete":
          return json({ deleted: await ns.delete(q("repo")) });
        case "/list":
          return json(await ns.list({ limit: 200 }));
        case "/info": {
          using repo = await ns.get(q("repo"));
          const info = await repo.info();
          return json({ info: { ...info }, log: await repo.log({ ref: q("ref", "main"), limit: 3 }) });
        }
        case "/bench":
          return json(await this.bench(ns, q("repo"), Number(q("n", "1000")), Number(q("delayMs", "0"))));
        case "/burst":
          return json(
            await this.burst(ns, q("repo").split(","), q("kind", "readBlob"), Number(q("n", "2500")), Number(q("conc", "64"))),
          );
        case "/compose":
          return json(
            await this.compose(ns, q("repo"), q("changes").split(","), q("skip") ? Number(q("skip")) : -1, q("dropTree") === "1"),
          );
        case "/stale":
          return json(await this.stale(ns, q("repo"), q("old")));
        case "/race":
          return json(await this.race(ns, q("repo"), Number(q("trials", "10")), Number(q("width", "2"))));
        case "/pako":
          return json(await this.pako(ns, q("repo"), q("corrupt") === "1"));
        default:
          return json({ error: "no route" }, 404);
      }
    } catch (e) {
      return json({ error: errKey(e), stack: (e as Error).stack?.split("\n").slice(0, 6) }, 500);
    }
  }

  // ------------------------------------------------------------ check 2

  private async bench(ns: Artifacts, name: string, n: number, delayMs: number) {
    using repo = await ns.get(name);
    const reader = new BindingReader(repo);
    const head = await this.head(repo);
    if (!head) throw new Error("empty repo");
    const root = (await reader.readCommit(head)).tree;
    const trees: string[] = [];
    const blobs: string[] = [];
    await this.walk(reader, root, trees, blobs);
    const treeMs: number[] = [];
    const blobMs: number[] = [];
    const errors: Record<string, number> = {};
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      const isTree = i % 2 === 0;
      const oid = isTree ? (trees[(i / 2) % trees.length] as string) : (blobs[((i - 1) / 2) % blobs.length] as string);
      const s = performance.now();
      try {
        if (isTree) {
          if (!(await repo.readTree(oid))) throw new Error("null tree");
        } else {
          const b = await repo.readBlob(oid);
          if (!b) throw new Error("null blob");
          await b.arrayBuffer();
        }
        // Can-fail seam: an injected delay must push p95 over the bar.
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        (isTree ? treeMs : blobMs).push(performance.now() - s);
      } catch (e) {
        const k = errKey(e);
        errors[k] = (errors[k] ?? 0) + 1;
      }
    }
    const all = summarise([...treeMs, ...blobMs]);
    return {
      repo: name,
      head,
      trees: trees.length,
      blobs: blobs.length,
      walkCalls: reader.calls,
      wallMs: Date.now() - t0,
      all,
      readTree: summarise(treeMs),
      readBlob: summarise(blobMs),
      errors,
      injectedDelayMs: delayMs,
      criterion: { p95BelowMs: 50, pass: all.p95 < 50 },
    };
  }

  private async burst(ns: Artifacts, names: string[], kind: string, n: number, conc: number) {
    const handles = await Promise.all(names.map((nm) => ns.get(nm)));
    try {
      const targets: Array<{ repo: ArtifactsRepo; name: string; blob: string; tree: string }> = [];
      for (let i = 0; i < handles.length; i++) {
        const repo = handles[i] as ArtifactsRepo;
        const head = (await repo.log({ ref: "main", limit: 1 }))[0];
        if (!head) throw new Error(`${names[i]} empty`);
        // Descend to the first regular file for a representative blob.
        let tree = head.treeHash;
        let blob = "";
        for (let depth = 0; depth < 8 && !blob; depth++) {
          const entries = (await repo.readTree(tree)) ?? [];
          blob = entries.find((e) => e.type === "blob")?.hash ?? "";
          const sub = entries.find((e) => e.type === "tree");
          if (!blob && sub) tree = sub.hash;
        }
        if (!blob) throw new Error(`no blob found in ${names[i]}`);
        targets.push({ repo, name: names[i] as string, blob, tree: head.treeHash });
      }
      let ok = 0;
      const okTimes: number[] = [];
      const errors: Record<string, { count: number; firstAtMs: number }> = {};
      let next = 0;
      const t0 = Date.now();
      const one = async (i: number) => {
        const t = targets[i % targets.length] as (typeof targets)[number];
        switch (kind) {
          case "readBlob": {
            const b = await t.repo.readBlob(t.blob);
            if (!b) throw new Error("null blob");
            await b.arrayBuffer();
            return;
          }
          case "readTree":
            if (!(await t.repo.readTree(t.tree))) throw new Error("null tree");
            return;
          case "info":
            await t.repo.info();
            return;
          case "get": {
            using h = await ns.get(t.name);
            void h;
            return;
          }
          case "log":
            await t.repo.log({ ref: "main", limit: 1 });
            return;
          default:
            throw new Error(`kind ${kind}`);
        }
      };
      const worker = async () => {
        while (next < n) {
          const i = next++;
          const s = Date.now();
          try {
            await one(i);
            ok++;
            okTimes.push(Date.now() - s);
          } catch (e) {
            const k = errKey(e);
            const slot = errors[k] ?? { count: 0, firstAtMs: Date.now() - t0 };
            slot.count++;
            errors[k] = slot;
          }
        }
      };
      await Promise.all(Array.from({ length: conc }, worker));
      const wall = Date.now() - t0;
      return {
        repos: names,
        kind,
        n,
        conc,
        ok,
        wallMs: wall,
        perSecond: Math.round((n / wall) * 1000),
        latency: summarise(okTimes),
        errors,
      };
    } finally {
      for (const h of handles) h[Symbol.dispose]();
    }
  }

  // ------------------------------------------------------------ check 3

  private async compose(ns: Artifacts, name: string, changes: string[], skip: number, dropTree: boolean) {
    using repo = await ns.get(name);
    const reader = new BindingReader(repo);
    const t0 = performance.now();
    const head = await this.head(repo);
    if (!head) throw new Error("empty repo");
    const headCommit = await reader.readCommit(head);
    const newObjects = new Map<string, GitObject>();
    // Intermediate trees exist only in memory until the push.
    const overlay = new OverlayReader(reader, newObjects);
    let acc = headCommit.tree;
    const used = changes.filter((_, i) => i !== skip);
    const steps: Array<{ change: string; tree: string }> = [];
    for (const c of used) {
      const cc = await reader.readCommit(c);
      if (cc.parents[0] !== head) throw new Error(`change ${c} is not based on head ${head}`);
      const r = await mergeTrees(overlay, headCommit.tree, acc, cc.tree);
      for (const [k, v] of r.newObjects) newObjects.set(k, v);
      acc = r.tree;
      steps.push({ change: c, tree: acc });
    }
    const commitBody = encodeCommit({
      tree: acc,
      parents: [head],
      author: { ...IDENT, time: COMPOSE_TIME },
      committer: { ...IDENT, time: COMPOSE_TIME },
      message: `Compose candidate of ${used.length} changes`,
      trailers: used.map((c) => ["Change-Id", `I${c}`] as const),
    });
    const commitOid = await hashObject("commit", commitBody);
    // Only new objects reachable from the candidate's tree, and only those the
    // server does not already hold, go in the pack. Intermediate roots from
    // earlier steps are dropped.
    const reachable: Array<[string, GitObject]> = [];
    const visit = (oid: string) => {
      const o = newObjects.get(oid);
      if (!o || reachable.some(([k]) => k === oid)) return;
      reachable.push([oid, o]);
      for (const e of decodeTree(o.body)) if (e.mode === "40000") visit(e.oid);
    };
    visit(acc);
    const missing: Array<[string, GitObject]> = [];
    for (const [oid, o] of reachable) {
      if ((await repo.readTree(oid)) === null) missing.push([oid, o]);
    }
    const composeMs = performance.now() - t0;
    const readsDuringCompose = reader.calls;

    const t1 = performance.now();
    // Can-fail seam: leave the candidate's root tree out of the pack.
    const shipped = (dropTree ? missing.filter(([oid]) => oid !== acc) : missing).map(([, o]) => o);
    const pack = await writePack([...shipped, { type: "commit", body: commitBody }]);
    const remote = await this.remote(repo, "write");
    const adv = await advertise(remote, "git-receive-pack");
    const t2 = performance.now();
    const push = await receivePack(remote, "refs/heads/main", adv.head ?? ZERO_OID, commitOid, pack);
    const pushMs = performance.now() - t2;
    const totalPushMs = performance.now() - t1;
    const after = await this.head(repo);
    return {
      head,
      steps,
      tree: acc,
      commit: commitOid,
      newTrees: newObjects.size,
      reachableNewTrees: reachable.length,
      missingTrees: missing.length,
      packedObjects: shipped.length + 1,
      packBytes: pack.length,
      composeMs: Math.round(composeMs),
      readsDuringCompose,
      receivePackMs: Math.round(pushMs),
      tokenAdvertisePackPushMs: Math.round(totalPushMs),
      advertisedHead: adv.head,
      serverCaps: [...adv.caps],
      push: { status: push.status, unpack: push.unpack, refs: Object.fromEntries(push.refStatus), raw: push.raw },
      headAfter: after,
      dropTree,
      skip,
    };
  }

  // ------------------------------------------------------------ check 4

  private async newCommitOn(repo: ArtifactsRepo, parent: string, label: string) {
    const pc = await repo.readCommit(parent);
    if (!pc) throw new Error(`no commit ${parent}`);
    const body = encodeCommit({
      tree: pc.treeHash,
      parents: [parent],
      author: { ...IDENT, time: COMPOSE_TIME },
      committer: { ...IDENT, time: COMPOSE_TIME },
      message: label,
    });
    return { oid: await hashObject("commit", body), body };
  }

  private async stale(ns: Artifacts, name: string, old: string) {
    using repo = await ns.get(name);
    const remote = await this.remote(repo, "write");
    const results: Record<string, unknown> = {};
    const cases: Array<[string, string | null]> = [
      ["stale-ancestor", old],
      ["never-existed", "deadbeef".repeat(5)],
      ["zero-oid-create", ZERO_OID],
      ["correct-old (control)", null],
    ];
    for (const [label, sentOld] of cases) {
      const before = (await advertise(remote, "git-receive-pack")).head as string;
      const expectOld = sentOld ?? before;
      const c = await this.newCommitOn(repo, before, `stale test ${label} ${Date.now()}`);
      const pack = await writePack([{ type: "commit", body: c.body }]);
      const res = await receivePack(remote, "refs/heads/main", expectOld, c.oid, pack);
      const after = (await advertise(remote, "git-receive-pack")).head;
      const accepted = res.unpack === "ok" && res.refStatus.get("refs/heads/main")?.ok === true;
      results[label] = {
        headBefore: before,
        sentOld: expectOld,
        newCommit: c.oid,
        status: res.status,
        raw: res.raw,
        accepted,
        headAfter: after,
        headMoved: after !== before,
        readBackAgrees: accepted ? after === c.oid : after === before,
      };
    }
    return results;
  }

  /** `width` pushes from the same base, sent concurrently; exactly one may win. */
  private async race(ns: Artifacts, name: string, trials: number, width: number) {
    using repo = await ns.get(name);
    const remote = await this.remote(repo, "write");
    const out: unknown[] = [];
    let exactlyOne = 0;
    let multipleOk = 0;
    let noneOk = 0;
    let readBackMismatch = 0;
    for (let t = 0; t < trials; t++) {
      const base = (await advertise(remote, "git-receive-pack")).head as string;
      const commits = await Promise.all(
        Array.from({ length: width }, (_, i) => this.newCommitOn(repo, base, `race ${t} #${i} ${Date.now()}`)),
      );
      const packs = await Promise.all(commits.map((c) => writePack([{ type: "commit", body: c.body }])));
      const t0 = Date.now();
      const results = await Promise.all(
        commits.map((c, i) => receivePack(remote, "refs/heads/main", base, c.oid, packs[i] as Uint8Array)),
      );
      const wall = Date.now() - t0;
      const ok = results.map((r) => r.unpack === "ok" && r.refStatus.get("refs/heads/main")?.ok === true);
      const winners = commits.filter((_, i) => ok[i]).map((c) => c.oid);
      const after = (await advertise(remote, "git-receive-pack")).head;
      const logHead = await this.head(repo);
      if (winners.length === 1) exactlyOne++;
      else if (winners.length > 1) multipleOk++;
      else noneOk++;
      // Read-back: the head must be the single acknowledged commit.
      const consistent = winners.length === 1 ? after === winners[0] && logHead === winners[0] : false;
      if (!consistent) readBackMismatch++;
      out.push({
        trial: t,
        base,
        wallMs: wall,
        winnerIndex: ok.indexOf(true),
        replies: results.map((r) => r.raw),
        headAfter: after,
        logHeadAfter: logHead,
        consistent,
      });
    }
    return { trials, width, exactlyOne, multipleOk, noneOk, readBackMismatch, detail: out };
  }

  // ------------------------------------------------------------ check 5

  private async pako(ns: Artifacts, name: string, corrupt: boolean) {
    using repo = await ns.get(name);
    const remote = await this.remote(repo, "read");
    const adv = await advertise(remote, "git-upload-pack");
    if (!adv.head) throw new Error("no head");
    const t0 = performance.now();
    const pack = await uploadPack(remote, [adv.head], adv.caps);
    const fetchMs = performance.now() - t0;
    if (corrupt) {
      // Can-fail seam: flip one byte inside the last object's compressed data.
      pack[pack.length - 30] = (pack[pack.length - 30] as number) ^ 0xff;
    }
    const result: Record<string, unknown> = {
      head: adv.head,
      uploadPackCaps: [...adv.caps],
      packBytes: pack.length,
      fetchMs: Math.round(fetchMs),
      corrupted: corrupt,
    };
    const t1 = performance.now();
    try {
      const parsed = await readPack(pack);
      const byOid = new Map(parsed.objects.map((o) => [o.oid, o]));
      // Connectivity: every id referenced from the head down must be an
      // object whose recomputed SHA-1 is that id.
      let checked = 0;
      const missing: string[] = [];
      const visit = (oid: string, expect: "commit" | "tree" | "blob") => {
        const o = byOid.get(oid);
        checked++;
        if (!o || o.type !== expect) {
          missing.push(`${expect} ${oid}`);
          return;
        }
        if (o.type === "commit") {
          const text = dec.decode(o.body);
          visit(/^tree ([0-9a-f]{40})/m.exec(text)?.[1] as string, "tree");
          for (const m of text.matchAll(/^parent ([0-9a-f]{40})/gm)) visit(m[1] as string, "commit");
        } else if (o.type === "tree") {
          let i = 0;
          while (i < o.body.length) {
            const sp = o.body.indexOf(0x20, i);
            const nul = o.body.indexOf(0, sp);
            const mode = dec.decode(o.body.subarray(i, sp));
            const child = toHex(o.body.subarray(nul + 1, nul + 21));
            if (mode === "40000") visit(child, "tree");
            else if (mode !== "160000") visit(child, "blob");
            i = nul + 21;
          }
        }
      };
      visit(adv.head, "commit");
      result.pako = {
        ok: parsed.trailerOk && missing.length === 0 && parsed.objects.length === parsed.declaredCount,
        declaredCount: parsed.declaredCount,
        parsedObjects: parsed.objects.length,
        distinctOids: byOid.size,
        deltas: parsed.deltas,
        trailerOk: parsed.trailerOk,
        referencesChecked: checked,
        missingOrMismatched: missing.slice(0, 5),
        parseMs: Math.round(performance.now() - t1),
        types: parsed.objects.reduce<Record<string, number>>((m, o) => {
          m[o.type] = (m[o.type] ?? 0) + 1;
          return m;
        }, {}),
      };
    } catch (e) {
      result.pako = { ok: false, error: errKey(e), parseMs: Math.round(performance.now() - t1) };
    }

    // The same pack through the platform DecompressionStream, starting at the
    // first object's zlib data and running on, as a reader that does not know
    // the compressed length must. Control: the exact slice pako consumed.
    const first = firstObject(pack);
    const onRest = await this.decompressionStream(pack.subarray(first.dataAt));
    let onExact: unknown;
    try {
      const { used } = inflateAt(pack, first.dataAt, first.size);
      onExact = { consumedBytes: used, ...(await this.decompressionStream(pack.subarray(first.dataAt, first.dataAt + used))) };
    } catch (e) {
      onExact = { error: errKey(e) };
    }
    result.decompressionStream = { firstObjectInflatedSize: first.size, onRestOfPack: onRest, onExactSlice: onExact };
    return result;
  }

  private async decompressionStream(input: Uint8Array) {
    let produced = 0;
    try {
      const reader = new Blob([input as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new DecompressionStream("deflate"))
        .getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        produced += value.length;
      }
      return { ok: true, outputBytes: produced };
    } catch (e) {
      return { ok: false, error: errKey(e), outputBytesDeliveredBeforeError: produced };
    }
  }
}

export default {
  async fetch(req, env) {
    const key = (env as SpikeEnv).SPIKE_KEY;
    if (!key || req.headers.get("authorization") !== `Bearer ${key}`) {
      return new Response("unauthorised", { status: 401 });
    }
    const url = new URL(req.url);
    const hint = url.searchParams.get("hint") as DurableObjectLocationHint | null;
    const id = env.SPIKE.idFromName(url.searchParams.get("do") ?? "main");
    // locationHint only matters on the first request that creates the object.
    const stub = hint ? env.SPIKE.get(id, { locationHint: hint }) : env.SPIKE.get(id);
    const fwd = new Request(req);
    fwd.headers.set("x-entry-colo", String((req.cf as { colo?: string } | undefined)?.colo ?? "unknown"));
    return stub.fetch(fwd);
  },
} satisfies ExportedHandler<Env>;
