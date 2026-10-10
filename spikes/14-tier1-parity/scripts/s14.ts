// Client for the keel-spike-14-verify host Worker.
//   BASE=https://... TOKEN=... node scripts/s14.ts <command> [args]
// Commands:
//   bundle <projectDir> <key> [isolate=true] [break=<matcher>] [tests=a,b]
//   run <key> <mode cold|warm> <n> <concurrency> [do=<name>] [out=<file>]
//   fanout <key> <mode> <m> <n> <concurrency>
//   post <path> <json>
//   tails <prefix>
//   parity <vitest.json> <tier1.json> [projectRoot]
//   probe <vitest.json|tier1.json>   -> pass | fail | n/a
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:8787";
const TOKEN = process.env.TOKEN ?? "";

function readProject(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|json)$/.test(name)) out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

async function call(path: string, body?: unknown): Promise<unknown> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-spike-token": TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const clientMs = Math.round(performance.now() - t0);
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return { ...json, httpStatus: res.status, clientMs };
  } catch {
    return { httpStatus: res.status, clientMs, text: text.slice(0, 2000) };
  }
}

type Status = "pass" | "fail" | "skip";
interface Row {
  file: string;
  name: string;
  status: Status;
}

function fromVitestJson(path: string, root: string): Row[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as {
    testResults: Array<{ name: string; message?: string; assertionResults: Array<{ ancestorTitles: string[]; title: string; status: string }> }>;
  };
  const rows: Row[] = [];
  for (const f of j.testResults) {
    const file = f.name.startsWith("/") ? relative(root, f.name) : f.name;
    if (f.assertionResults.length === 0) rows.push({ file, name: "<file load>", status: "fail" });
    for (const a of f.assertionResults) {
      const status: Status = a.status === "passed" ? "pass" : a.status === "failed" ? "fail" : "skip";
      rows.push({ file, name: [...a.ancestorTitles, a.title].join(" > "), status });
    }
  }
  return rows;
}

function parity(node: Row[], tier1: Row[]) {
  const key = (r: Row) => `${r.file} :: ${r.name}`;
  const count = (rows: Row[]) => {
    const m = new Map<string, Status[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r.status]);
    return m;
  };
  const a = count(node);
  const b = count(tier1);
  const mismatches: Array<{ test: string; node: string; tier1: string }> = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = (a.get(k) ?? []).join(",") || "missing";
    const y = (b.get(k) ?? []).join(",") || "missing";
    if (x !== y) mismatches.push({ test: k, node: x, tier1: y });
  }
  const tally = (rows: Row[]) => rows.reduce<Record<string, number>>((t, r) => ((t[r.status] = (t[r.status] ?? 0) + 1), t), {});
  return { nodeTests: node.length, tier1Tests: tier1.length, node: tally(node), tier1: tally(tier1), identical: mismatches.length === 0, mismatches };
}

function kv(args: string[]): Record<string, string> {
  return Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
}

const [cmd, ...rest]: string[] = process.argv.slice(2);
const opts = kv(rest);
const pos = rest.filter((a) => !a.includes("="));

switch (cmd) {
  case "bundle": {
    const [dir, key] = pos;
    const files = readProject(dir!);
    const r = await call("/bundle", {
      key,
      files,
      isolate: opts.isolate !== "false",
      breakMatcher: opts.break,
      tests: opts.tests ? opts.tests.split(",") : undefined,
    });
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  case "run": {
    const [key, mode, n, c] = pos;
    const r = (await call("/run", { key, mode, n: Number(n), concurrency: Number(c), doName: opts.do ?? `run-${key}` })) as Record<string, unknown>;
    if (opts.out) writeFileSync(opts.out, JSON.stringify(r.results ?? [], null, 2));
    const { results, ...meta } = r;
    console.log(JSON.stringify({ ...meta, resultCount: Array.isArray(results) ? results.length : 0 }, null, 2));
    break;
  }
  case "fanout": {
    const [key, mode, m, n, c] = pos;
    console.log(JSON.stringify(await call("/fanout", { key, mode, m: Number(m), n: Number(n), concurrency: Number(c) }), null, 2));
    break;
  }
  case "post": {
    const [path, json] = pos;
    console.log(JSON.stringify(await call(path!, JSON.parse(json ?? "{}")), null, 2));
    break;
  }
  case "tails": {
    console.log(JSON.stringify(await call(`/tails?prefix=${encodeURIComponent(pos[0] ?? "")}`), null, 2));
    break;
  }
  case "parity": {
    const [nodeJson, tier1Json, root] = pos;
    const node = fromVitestJson(nodeJson!, root ?? process.cwd());
    const tier1 = JSON.parse(readFileSync(tier1Json!, "utf8")) as Row[];
    const p = parity(node, tier1);
    console.log(JSON.stringify(p, null, 2));
    process.exitCode = p.identical ? 0 : 1;
    break;
  }
  case "probe": {
    // n/a is signalled by a thrown error whose message starts with this marker.
    const marker = "probe not applicable:";
    const j = JSON.parse(readFileSync(pos[0]!, "utf8")) as unknown;
    let outcomes: string[];
    if (Array.isArray(j)) {
      outcomes = (j as Array<{ status: Status; error?: string }>).map((r) =>
        r.status === "pass" ? "pass" : r.status === "fail" && (r.error ?? "").includes(marker) ? "n/a" : r.status,
      );
    } else {
      const v = j as { testResults: Array<{ assertionResults: Array<{ status: string; failureMessages: string[] }> }> };
      outcomes = v.testResults.flatMap((f) =>
        f.assertionResults.map((a) =>
          a.status === "passed"
            ? "pass"
            : a.status === "failed"
              ? a.failureMessages.join("\n").includes(marker)
                ? "n/a"
                : "fail"
              : "skip",
        ),
      );
    }
    console.log(outcomes.length === 1 ? outcomes[0] : `unexpected: ${JSON.stringify(outcomes)}`);
    break;
  }
  default:
    console.error("unknown command");
    process.exitCode = 2;
}
