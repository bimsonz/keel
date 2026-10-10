// Raw smart-HTTP receive-pack client (protocol v1). It sends update commands
// with an old-oid of our choosing, which `git push` will not do, so the
// server's own compare-and-swap can be tested directly.
//
//   REMOTE=... TOKEN=... node scripts/rawpush.ts <mode> [args]
//
// Modes
//   head                         print refs/heads/main as advertised now
//   single <gitdir> <spec>...    one request; spec = old:new:ref, old/new may be
//                                "zero"; add --atomic to request the capability
//   race <gitdir> <trials>       N trials: two commits on the current head, both
//                                POSTed at once with the same old-oid
//   control-race <gitdir> <n>    CONTROL: same, but B's old-oid is A's commit and
//                                B is sent after A returns, so both must succeed
//                                and the classifier must flag it
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const REMOTE = process.env.REMOTE ?? "";
const TOKEN = process.env.TOKEN ?? "";
if (!REMOTE || !TOKEN) throw new Error("REMOTE and TOKEN must be set");
const ZERO = "0".repeat(40);
const auth = { Authorization: `Bearer ${TOKEN}` };

const redact = (s: string): string =>
  s
    .replace(/art_v\d+_[A-Za-z0-9_]+(\?expires=\d+)?/g, "<token>")
    .replace(/[0-9a-f]{32}\.artifacts/g, "<acct>.artifacts");

const pkt = (s: string): Buffer => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0")), b]);
};

function parsePkts(buf: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push("0000");
      i += 4;
      continue;
    }
    out.push(buf.subarray(i + 4, i + len).toString("utf8").replace(/\n$/, ""));
    i += len;
  }
  return out;
}

export async function advertisedRefs(): Promise<Map<string, string>> {
  const r = await fetch(`${REMOTE}/info/refs?service=git-receive-pack`, { headers: auth });
  const lines = parsePkts(Buffer.from(await r.arrayBuffer()));
  const refs = new Map<string, string>();
  for (const l of lines) {
    const m = /^([0-9a-f]{40}) ([^\0]+)/.exec(l);
    if (m && m[2] !== "capabilities^{}") refs.set(m[2], m[1]);
  }
  return refs;
}

export type Cmd = { old: string; new: string; ref: string };
export type Report = { status: number; ms: number; unpack: string; refs: string[]; raw: string };

export async function receivePack(cmds: Cmd[], pack: Buffer | null, atomic = false): Promise<Report> {
  const caps = ["report-status", ...(atomic ? ["atomic"] : []), "agent=keel-spike-01"].join(" ");
  const parts: Buffer[] = cmds.map((c, i) =>
    pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? `\0${caps}` : ""}\n`),
  );
  parts.push(Buffer.from("0000"));
  if (pack) parts.push(pack);
  const t0 = Date.now();
  const r = await fetch(`${REMOTE}/git-receive-pack`, {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/x-git-receive-pack-request",
      Accept: "application/x-git-receive-pack-result",
    },
    body: Buffer.concat(parts),
  });
  const body = Buffer.from(await r.arrayBuffer());
  const ms = Date.now() - t0;
  const lines = parsePkts(body).filter((l) => l !== "0000");
  return {
    status: r.status,
    ms,
    unpack: lines.find((l) => l.startsWith("unpack")) ?? "",
    refs: lines.filter((l) => /^(ok|ng) /.test(l)),
    raw: redact(lines.join(" | ").slice(0, 300)),
  };
}

const git = (gitdir: string, args: string[], input?: string | Buffer): Buffer =>
  execFileSync("git", ["-C", gitdir, ...args], { input, maxBuffer: 1 << 30 });

// Pack of everything reachable from `tips` but not from `exclude`.
export function packFor(gitdir: string, tips: string[], exclude: string[]): Buffer {
  const revs = [...tips, ...exclude.filter((x) => x !== ZERO).map((x) => `^${x}`)].join("\n") + "\n";
  return git(gitdir, ["pack-objects", "--revs", "--stdout", "-q"], revs);
}

// A new commit on `parent` reusing the parent's tree; only the commit object is new.
export function commitOn(gitdir: string, parent: string, msg: string): string {
  const tree = git(gitdir, ["rev-parse", `${parent}^{tree}`]).toString().trim();
  return git(gitdir, ["commit-tree", tree, "-p", parent, "-m", msg]).toString().trim();
}

const resolve = (gitdir: string, x: string): string =>
  x === "zero" ? ZERO : /^[0-9a-f]{40}$/.test(x) ? x : git(gitdir, ["rev-parse", x]).toString().trim();

async function single(gitdir: string, specs: string[], atomic: boolean): Promise<void> {
  const cmds: Cmd[] = specs.map((s) => {
    const [o, n, ref] = s.split(":");
    return { old: resolve(gitdir, o), new: resolve(gitdir, n), ref };
  });
  const tips = cmds.map((c) => c.new).filter((x) => x !== ZERO);
  const ex = Array.from((await advertisedRefs()).values());
  const pack = tips.length ? packFor(gitdir, tips, ex.filter((e) => hasObject(gitdir, e))) : null;
  const rep = await receivePack(cmds, pack, atomic);
  const after = await advertisedRefs();
  console.log(
    JSON.stringify({
      sent: cmds.map((c) => `${c.old.slice(0, 12)}->${c.new.slice(0, 12)} ${c.ref}`),
      atomic,
      http: rep.status,
      ms: rep.ms,
      unpack: rep.unpack,
      result: rep.refs,
      after: Object.fromEntries(cmds.map((c) => [c.ref, (after.get(c.ref) ?? "absent").slice(0, 12)])),
    }),
  );
}

function hasObject(gitdir: string, oid: string): boolean {
  try {
    git(gitdir, ["cat-file", "-e", oid]);
    return true;
  } catch {
    return false;
  }
}

async function race(gitdir: string, trials: number, control: boolean, out?: string): Promise<void> {
  const header = "trial\tmode\tbase\tcA\tcB\tresA\tresB\thead\tskew_ms\tmsA\tmsB\toutcome";
  console.log(header);
  if (out) appendFileSync(out, header + "\n");
  for (let i = 1; i <= trials; i++) {
    const base = (await advertisedRefs()).get("refs/heads/main");
    if (!base) throw new Error("main missing");
    if (!hasObject(gitdir, base)) throw new Error(`local repo lacks ${base}; fetch it first`);
    const cA = commitOn(gitdir, base, `raw A ${i} ${Date.now()}`);
    const cB = commitOn(gitdir, base, `raw B ${i} ${Date.now()}`);
    const pA = packFor(gitdir, [cA], [base]);
    const pB = packFor(gitdir, [cB], [base]);
    const ref = "refs/heads/main";
    let a: Report & { t: number };
    let b: Report & { t: number };
    if (control) {
      // B claims A's commit as its old value and goes second: a legitimate
      // non-fast-forward overwrite that loses A, so both report ok.
      const tA = Date.now();
      a = { ...(await receivePack([{ old: base, new: cA, ref }], pA)), t: tA };
      const tB = Date.now();
      const pB2 = packFor(gitdir, [cB], [base, cA]);
      b = { ...(await receivePack([{ old: cA, new: cB, ref }], pB2)), t: tB };
    } else {
      const tA = Date.now();
      const tB = Date.now();
      const [ra, rb] = await Promise.all([
        receivePack([{ old: base, new: cA, ref }], pA),
        receivePack([{ old: base, new: cB, ref }], pB),
      ]);
      a = { ...ra, t: tA };
      b = { ...rb, t: tB };
    }
    const head = (await advertisedRefs()).get(ref) ?? "absent";
    const okA = a.refs.some((l) => l.startsWith("ok "));
    const okB = b.refs.some((l) => l.startsWith("ok "));
    let outcome = okA && okB ? "VIOLATION_BOTH_OK" : okA ? "A_WON" : okB ? "B_WON" : "NONE_WON";
    if (outcome === "A_WON" && head !== cA) outcome = "VIOLATION_HEAD_NOT_WINNER";
    if (outcome === "B_WON" && head !== cB) outcome = "VIOLATION_HEAD_NOT_WINNER";
    if (head !== cA && head !== cB) outcome = "VIOLATION_HEAD_FOREIGN";
    const row = [
      i,
      control ? "raw-control" : "raw-race",
      base.slice(0, 12),
      cA.slice(0, 12),
      cB.slice(0, 12),
      a.refs.join(";") || a.raw,
      b.refs.join(";") || b.raw,
      head.slice(0, 12),
      Math.abs(a.t - b.t),
      a.ms,
      b.ms,
      outcome,
    ].join("\t");
    console.log(row);
    if (out) appendFileSync(out, row + "\n");
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "head") {
  console.log((await advertisedRefs()).get("refs/heads/main") ?? "absent");
} else if (mode === "refs") {
  for (const [k, v] of await advertisedRefs()) console.log(`${v}\t${k}`);
} else if (mode === "single") {
  const atomic = rest.includes("--atomic");
  const [gitdir, ...specs] = rest.filter((x) => x !== "--atomic");
  await single(gitdir, specs, atomic);
} else if (mode === "race" || mode === "control-race") {
  await race(rest[0], Number(rest[1]), mode === "control-race", rest[2]);
} else {
  throw new Error(`unknown mode ${mode}`);
}
