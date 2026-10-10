// Local push driver for S6. Repos are created through the trigger Worker's
// /create route; pushes use local `git` with the token in a GIT_CONFIG_* env
// var (never argv, never the URL). Push records go to results/pushes.jsonl with
// no tokens or remote URLs.
//
//   WORKER_URL=... SPIKE_KEY_FILE=... WORK=<scratch dir> node scripts/pushes.ts <cmd> [...]
//     clock                      Worker vs local clock offset -> results/clock.json
//     fresh <prefix> <n>         create each repo, then push to it immediately
//     spread <prefix> <n> <rounds> <sleepMs>   round-robin commit+push to main
//     burst <prefix> <n>         one push per repo, all in parallel
//     special <repo>             tags, notes, branch create/delete, multi-ref, force, no-op
//     sub <repo> <subCreatedAtMs> <everyMs> <maxPushes>   pushes for the activation-gap probe
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.WORKER_URL;
const keyFile = process.env.SPIKE_KEY_FILE;
const work = process.env.WORK;
if (!url || !keyFile || !work) throw new Error("WORKER_URL, SPIKE_KEY_FILE and WORK required");
const key = readFileSync(keyFile, "utf8").trim();
const results = new URL("../results/", import.meta.url);
const pushLog = new URL("pushes.jsonl", results);
const ZERO = "0".repeat(40);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scrub = (s: string) =>
  s.replace(/https:\/\/[0-9a-f]{32}\./g, "https://<acct>.").replace(/art_v\d+_[A-Za-z0-9_?=]+/g, "<token>");

async function call(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "x-spike-key": key } });
  return (await res.json()) as Record<string, unknown>;
}

function run(cwd: string, args: string[], token?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (token) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraHeader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
    }
    const p = spawn("git", args, { cwd, env });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

type Meta = { name: string; remote: string; token: string; createdAt: number };
const metaPath = (name: string) => join(work, `${name}.meta.json`);
const dirOf = (name: string) => join(work, name);
const meta = (name: string): Meta => JSON.parse(readFileSync(metaPath(name), "utf8")) as Meta;

async function create(names: string[]): Promise<Meta[]> {
  const r = (await call(`/create?names=${names.join(",")}`)) as { out: (Meta & { error?: string })[] };
  for (const m of r.out) {
    if (m.error) throw new Error(`create ${m.name}: ${m.error}`);
    writeFileSync(metaPath(m.name), JSON.stringify(m), { mode: 0o600 });
    const d = dirOf(m.name);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    await run(d, ["init", "-q", "-b", "main"]);
  }
  return r.out;
}

async function head(d: string): Promise<string> {
  const r = await run(d, ["rev-parse", "-q", "--verify", "HEAD"]);
  return r.code === 0 ? r.out.trim() : ZERO;
}

async function commit(name: string, msg: string): Promise<{ before: string; after: string }> {
  const d = dirOf(name);
  const before = await head(d);
  writeFileSync(join(d, "counter.txt"), `${msg}\n${Date.now()}\n`);
  await run(d, ["add", "-A"]);
  await run(d, ["-c", "user.name=keel-s6", "-c", "user.email=s6@keel.invalid", "commit", "-q", "-m", msg]);
  return { before, after: await head(d) };
}

let seq = Date.now();
async function push(phase: string, name: string, refspecs: string[], expect: { ref: string; before: string; after: string }[], extra: string[] = []) {
  const m = meta(name);
  const localStart = Date.now();
  const r = await run(dirOf(name), ["push", "--porcelain", ...extra, m.remote, ...refspecs], m.token);
  const localDone = Date.now();
  const rows = expect.map((e) => ({
    seq: seq++,
    phase,
    repo: name,
    ref: e.ref,
    before: e.before,
    after: e.after,
    localStart,
    localDone,
    pushMs: localDone - localStart,
    ok: r.code === 0,
    porcelain: scrub(r.out.split("\n").filter((l) => /^[ *+\-!=]\t|^Done|rejected|error/.test(l)).join(" | ")).slice(0, 300),
  }));
  for (const row of rows) appendFileSync(pushLog, `${JSON.stringify(row)}\n`);
  return rows;
}

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);

const [cmd, ...a] = process.argv.slice(2);
mkdirSync(work, { recursive: true });

if (cmd === "clock") {
  const samples: { rtt: number; offset: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const t1 = Date.now();
    const r = (await call("/now")) as { now: number; colo: string };
    const t2 = Date.now();
    samples.push({ rtt: t2 - t1, offset: r.now - (t1 + t2) / 2 });
  }
  const best = samples.toSorted((x, y) => x.rtt - y.rtt)[0];
  const out = { measuredAt: Date.now(), best, samples };
  writeFileSync(new URL("clock.json", results), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
} else if (cmd === "fresh") {
  // create -> push immediately, one repo at a time
  for (const name of names(a[0], Number(a[1]))) {
    const [m] = await create([name]);
    const c = await commit(name, `${name} first`);
    const [row] = await push("fresh", name, ["HEAD:refs/heads/main"], [{ ref: "refs/heads/main", ...c }]);
    appendFileSync(new URL("fresh-gap.jsonl", results), `${JSON.stringify({ repo: name, createdAtWorker: m.createdAt, createMs: (m as Meta & { createMs: number }).createMs, pushDone: row.localDone, pushMs: row.pushMs, ok: row.ok })}\n`);
    console.log(`${name} ok=${row.ok} push=${row.pushMs}ms`);
  }
} else if (cmd === "spread") {
  const list = names(a[0], Number(a[1]));
  const rounds = Number(a[2]);
  const gap = Number(a[3]);
  for (let r = 0; r < rounds; r++) {
    for (const name of list) {
      const c = await commit(name, `${name} spread ${r}`);
      const [row] = await push("spread", name, ["HEAD:refs/heads/main"], [{ ref: "refs/heads/main", ...c }]);
      if (!row.ok) console.log(`FAIL ${name}: ${row.porcelain}`);
      await sleep(gap);
    }
    console.log(`round ${r} done`);
  }
} else if (cmd === "burst") {
  const list = names(a[0], Number(a[1]));
  const prepared = [];
  for (const name of list) prepared.push({ name, c: await commit(name, `${name} burst`) });
  const t = Date.now();
  const rows = await Promise.all(prepared.map((p) => push("burst", p.name, ["HEAD:refs/heads/main"], [{ ref: "refs/heads/main", ...p.c }])));
  const flat = rows.flat();
  const span = Math.max(...flat.map((r) => r.localDone)) - t;
  console.log(`burst: ${flat.length} pushes, ok=${flat.filter((r) => r.ok).length}, all done within ${span} ms`);
} else if (cmd === "special") {
  const name = a[0];
  const d = dirOf(name);
  const h = await head(d);
  // 1. lightweight tag
  await run(d, ["tag", "-f", "light-1"]);
  await push("special:tag-light", name, ["refs/tags/light-1:refs/tags/light-1"], [{ ref: "refs/tags/light-1", before: ZERO, after: h }]);
  // 2. annotated tag (after = tag object id)
  await run(d, ["-c", "user.name=keel-s6", "-c", "user.email=s6@keel.invalid", "tag", "-f", "-a", "ann-1", "-m", "annotated"]);
  const tagObj = (await run(d, ["rev-parse", "refs/tags/ann-1"])).out.trim();
  await push("special:tag-annotated", name, ["refs/tags/ann-1:refs/tags/ann-1"], [{ ref: "refs/tags/ann-1", before: ZERO, after: tagObj }]);
  // 3. git notes
  await run(d, ["-c", "user.name=keel-s6", "-c", "user.email=s6@keel.invalid", "notes", "add", "-f", "-m", "keel-note", "HEAD"]);
  const notes = (await run(d, ["rev-parse", "refs/notes/commits"])).out.trim();
  await push("special:notes", name, ["refs/notes/commits:refs/notes/commits"], [{ ref: "refs/notes/commits", before: ZERO, after: notes }]);
  // 4. new branch
  const cb = await commit(name, `${name} feature`);
  await push("special:branch-create", name, ["HEAD:refs/heads/feature-x"], [{ ref: "refs/heads/feature-x", before: ZERO, after: cb.after }]);
  // 5. branch delete
  await push("special:branch-delete", name, [":refs/heads/feature-x"], [{ ref: "refs/heads/feature-x", before: cb.after, after: ZERO }]);
  // 6. multi-ref push: main + a second branch in one receive-pack
  const cm = await commit(name, `${name} multi`);
  await push("special:multi-ref", name, ["HEAD:refs/heads/main", "HEAD:refs/heads/multi-b"], [
    { ref: "refs/heads/main", before: h, after: cm.after },
    { ref: "refs/heads/multi-b", before: ZERO, after: cm.after },
  ]);
  // 7. force push (non-fast-forward rewrite of main)
  await run(d, ["reset", "-q", "--hard", "HEAD~1"]);
  const cf = await commit(name, `${name} rewritten`);
  await push("special:force", name, ["+HEAD:refs/heads/main"], [{ ref: "refs/heads/main", before: cm.after, after: cf.after }]);
  // 8. no-op push (already up to date): no ref changes, so no event expected
  await push("special:noop", name, ["HEAD:refs/heads/main"], [{ ref: "refs/heads/main", before: cf.after, after: cf.after }]);
  // 9. tag delete
  await push("special:tag-delete", name, [":refs/tags/light-1"], [{ ref: "refs/tags/light-1", before: h, after: ZERO }]);
  console.log("special done");
} else if (cmd === "sub") {
  const name = a[0];
  const subCreatedAt = Number(a[1]);
  const every = Number(a[2]);
  const max = Number(a[3]);
  for (let i = 0; i < max; i++) {
    const c = await commit(name, `${name} probe ${i}`);
    const [row] = await push(`sub:${subCreatedAt}`, name, ["HEAD:refs/heads/main"], [{ ref: "refs/heads/main", ...c }]);
    console.log(`${i} t+${Math.round((row.localDone - subCreatedAt) / 1000)}s ok=${row.ok} ${c.after.slice(0, 8)}`);
    const ev = (await call(`/events?since=${subCreatedAt - 60_000}`)) as { qevents: { repo: string; after: string; recv_at: number }[] };
    const got = ev.qevents.filter((q) => q.repo === name);
    if (got.length) {
      console.log(`first queue event after ${got.length} delivered: ${JSON.stringify(got[0])}`);
      if (got.length >= 3) break;
    }
    await sleep(every);
  }
} else if (cmd === "create") {
  console.log(JSON.stringify((await create(a)).map((m) => ({ name: m.name, createdAt: m.createdAt }))));
} else {
  throw new Error(`unknown command ${cmd}`);
}
