// Drives the deployed host from this machine and writes results/<phase>-<tag>.json.
//   HOST_URL=https://keel-spike-18-host.<subdomain>.workers.dev node scripts/bench.ts <phase>...
// phases: dynamic | pad | probes | static
// Timings come from the host (Date.now() around the loader/service-binding call, which
// advances at I/O boundaries) and CPU/outcome from tail events; client RTT is recorded too.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.HOST_URL;
if (!HOST) throw new Error("HOST_URL is required");
const TAG = process.env.TAG ?? `b${Date.now().toString(36)}`;
const COLD_N = Number(process.env.COLD_N ?? "5");
const WARM_N = Number(process.env.WARM_N ?? "20");
const STATIC_ROUNDS = Number(process.env.STATIC_ROUNDS ?? "2");

const TOOLS = ["ruff", "clang", "hcl", "treesitter"] as const;
type Tool = (typeof TOOLS)[number];
const FIXTURE: Record<Tool, string> = { ruff: "sample.py", clang: "sample.c", hcl: "main.tf", treesitter: "sample.ts" };
const reference = JSON.parse(readFileSync(join(root, "results", "reference.json"), "utf8")) as Record<string, unknown>;
const manifest = JSON.parse(readFileSync(join(root, "build", "wasm", "manifest.json"), "utf8")) as {
  files: Record<string, { bytes: number; gzipBytes: number }>;
  expectedProbe: Record<string, number>;
};
const fixture = (t: Tool) => readFileSync(join(root, "fixtures", FIXTURE[t]), "utf8");

// Canonical JSON so key order cannot fake a mismatch (or a match).
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b)))
      : x,
  );

type Call = { status: number; rttMs: number; colo: string | null; json: Record<string, any> };
async function call(path: string, body?: string): Promise<Call> {
  const t = performance.now();
  const res = await fetch(HOST + path, { method: body === undefined ? "GET" : "POST", body });
  const text = await res.text();
  const rttMs = Math.round(performance.now() - t);
  let json: Record<string, any>;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, rttMs, colo: res.headers.get("cf-ray")?.split("-")[1] ?? null, json };
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tail = { url: string | null; outcome: string; cpuTime: number; wallTime: number; eventTimestamp: number | null; exceptions: unknown[] };
async function tails(prefix: string, expect: number): Promise<Tail[]> {
  // Tail events land asynchronously after each invocation; poll until they stop arriving.
  let last = -1;
  let events: Tail[] = [];
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const r = await call(`/tails?prefix=${encodeURIComponent(prefix)}`);
    events = (r.json as unknown as Array<{ events: Tail[] }>).flatMap((x) => x.events);
    if (events.length >= expect || events.length === last) break;
    last = events.length;
  }
  return events.toSorted((a, b) => (a.eventTimestamp ?? 0) - (b.eventTimestamp ?? 0));
}
const idOf = (t: Tail) => (t.url ? new URL(t.url).searchParams.get("id") ?? new URL(t.url).searchParams.get("run") : null);

function save(phase: string, data: unknown) {
  const f = join(root, "results", `${phase}-${TAG}.json`);
  writeFileSync(f, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${f.slice(root.length + 1)}`);
}

async function dynamicPhase() {
  // Per tool: COLD_N cold loads (new id each, via the plain host), one in-request
  // series (repeat=WARM_N+1 on a new id: 1 cold + WARM_N warm calls on the same stub),
  // and WARM_N+1 external requests pinned through the LoaderHost Durable Object.
  const out: Record<string, unknown> = {};
  const rows: string[] = [];
  for (const tool of TOOLS) {
    const src = fixture(tool);
    const cold: Call[] = [];
    for (let i = 0; i < COLD_N; i++) cold.push(await call(`/run?tool=${tool}&id=${TAG}-${tool}-c${i}`, src));
    const series = await call(`/run?tool=${tool}&id=${TAG}-${tool}-series&repeat=${WARM_N + 1}`, src);
    const viaDo: Call[] = [];
    for (let i = 0; i <= WARM_N; i++) viaDo.push(await call(`/do-run?tool=${tool}&id=${TAG}-${tool}-do`, src));
    out[tool] = { cold, series, viaDo };
  }
  const ev = await tails(`child/${TAG}-`, TOOLS.length * (COLD_N + 2 * (WARM_N + 1)));
  for (const tool of TOOLS) {
    const { cold, series, viaDo } = out[tool] as { cold: Call[]; series: Call; viaDo: Call[] };
    const responses = [...cold, series, ...viaDo];
    const correct = responses.filter((c) => c.json.child?.ok && canon(c.json.child.result) === canon(reference[tool])).length;
    const seriesTails = ev.filter((e) => idOf(e) === `${TAG}-${tool}-series`);
    const doTails = ev.filter((e) => idOf(e) === `${TAG}-${tool}-do`);
    const coldTails = [
      ...cold.map((_, i) => ev.find((e) => idOf(e) === `${TAG}-${tool}-c${i}`)),
      seriesTails[0],
      doTails[0],
    ].filter((t): t is Tail => Boolean(t));
    const warmTails = [...seriesTails.slice(1), ...doTails.slice(1)];
    const doWarm = viaDo.slice(1).filter((c) => c.json.cold === false);
    const repeatMs = (series.json.repeatMs as number[] | undefined) ?? [];
    const coldLoad = [...cold, series, viaDo[0]].map((c) => c.json.loadAndRunMs as number);
    const summary = {
      wasmBytes: Object.entries(manifest.files)
        .filter(([f]) => (tool === "treesitter" ? f.startsWith("tree-sitter") : f.startsWith(tool === "clang" ? "clang" : tool)))
        .reduce((a, [, v]) => a + v.bytes, 0),
      coldTotalMs: [...cold, series, viaDo[0]].map((c) => c.json.totalMs),
      coldR2Ms: [...cold, series, viaDo[0]].map((c) => c.json.r2Ms),
      coldLoadAndRunMs: coldLoad,
      coldLoadAndRunP50Ms: pct(coldLoad, 50),
      coldCpuMs: coldTails.map((t) => t.cpuTime),
      warmInRequestP50Ms: pct(repeatMs, 50),
      warmInRequestP95Ms: pct(repeatMs, 95),
      warmInRequestSameResult: `${series.json.repeatSameResult}/${repeatMs.length}`,
      warmViaDoHits: `${doWarm.length}/${viaDo.length - 1}`,
      warmViaDoP50Ms: pct(doWarm.map((c) => c.json.totalMs), 50),
      warmViaDoP95Ms: pct(doWarm.map((c) => c.json.totalMs), 95),
      warmCpuP50Ms: pct(warmTails.map((t) => t.cpuTime), 50),
      warmCpuP95Ms: pct(warmTails.map((t) => t.cpuTime), 95),
      outcomes: [...new Set(ev.filter((e) => idOf(e)?.startsWith(`${TAG}-${tool}-`)).map((t) => t.outcome))],
      clientRttWarmViaDoP50Ms: pct(viaDo.slice(1).map((c) => c.rttMs), 50),
      wasmMemoryBytes: cold[0]?.json.child?.wasmMemoryBytes ?? null,
      correct: `${correct}/${responses.length}`,
      colo: cold[0]?.colo,
      tailEvents: ev.filter((e) => idOf(e)?.startsWith(`${TAG}-${tool}-`)).length,
    };
    (out[tool] as Record<string, unknown>).summary = summary;
    rows.push(
      `| ${tool} | ${summary.wasmBytes} | ${summary.coldLoadAndRunMs.join("/")} | ${summary.coldR2Ms.join("/")} | ${summary.coldCpuMs.join("/")} | ${summary.warmInRequestP50Ms}/${summary.warmInRequestP95Ms} | ${summary.warmViaDoP50Ms}/${summary.warmViaDoP95Ms} (${summary.warmViaDoHits}) | ${summary.warmCpuP50Ms}/${summary.warmCpuP95Ms} | ${summary.outcomes.join(",")} | ${summary.correct} + ${summary.warmInRequestSameResult} | ${summary.wasmMemoryBytes} |`,
    );
  }
  out.tails = ev;
  save("dynamic", out);
  console.log("| tool | wasm B | cold load+run ms | cold R2 ms | cold CPU ms | warm in-req p50/p95 | warm via DO p50/p95 (hits) | warm CPU p50/p95 | outcomes | correct | wasm mem B |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
}

async function padPhase() {
  const out: Record<string, unknown> = {};
  const rows: string[] = [];
  const cases: Array<[number, "active" | "passive"]> = [];
  const sizes = (process.env.PAD_SIZES ?? "10,30,60").split(",").map(Number);
  for (const mb of sizes) for (const mode of ["active", "passive"] as const) cases.push([mb, mode]);
  for (const [mb, mode] of cases) {
    const name = `pad${mb}${mode}`;
    const cold: Call[] = [];
    for (let i = 0; i < 2; i++) cold.push(await call(`/run?tool=pad&mb=${mb}&mode=${mode}&id=${TAG}-${name}-c${i}`));
    const warm: Call[] = [];
    for (let i = 0; i < 3; i++) warm.push(await call(`/run?tool=pad&mb=${mb}&mode=${mode}&id=${TAG}-${name}-c0`));
    out[name] = { cold, warm };
  }
  const ev = await tails(`child/${TAG}-pad`, cases.length * 5);
  for (const [mb, mode] of cases) {
    const name = `pad${mb}${mode}`;
    const { cold, warm } = out[name] as { cold: Call[]; warm: Call[] };
    const want = mode === "active" ? manifest.expectedProbe[`pad-${mb}-active`] : 42;
    const okProbe = [...cold, ...warm].filter((c) => c.json.child?.result?.probe === want).length;
    const mine = ev.filter((e) => idOf(e)?.startsWith(`${TAG}-${name}-`));
    const errors = [...new Set([...cold, ...warm].map((c) => c.json.hostError ?? c.json.child?.error ?? c.json.raw).filter(Boolean))];
    const summary = {
      bytes: manifest.files[`pad-${mb}-${mode}.wasm`].bytes,
      coldTotalMs: cold.map((c) => c.json.totalMs),
      coldR2Ms: cold.map((c) => c.json.r2Ms),
      coldLoadAndRunMs: cold.map((c) => c.json.loadAndRunMs),
      warmMs: warm.map((c) => c.json.totalMs),
      warmHits: warm.filter((c) => c.json.cold === false).length,
      probeOk: `${okProbe}/${cold.length + warm.length}`,
      wasmMemoryBytes: cold[0]?.json.child?.wasmMemoryBytes ?? null,
      outcomes: mine.map((t) => t.outcome),
      cpuMs: mine.map((t) => t.cpuTime),
      httpStatus: [...cold, ...warm].map((c) => c.status),
      errors,
    };
    (out[name] as Record<string, unknown>).summary = summary;
    rows.push(
      `| ${mb} MiB ${mode} | ${summary.bytes} | ${summary.probeOk} | ${summary.coldLoadAndRunMs.join("/")} | ${summary.coldR2Ms.join("/")} | ${summary.warmMs.join("/")} | ${summary.cpuMs.join("/")} | ${[...new Set(summary.outcomes)].join(",")} | ${summary.wasmMemoryBytes} | ${errors.join(" ; ").slice(0, 160)} |`,
    );
  }
  out.tails = ev;
  save("pad", out);
  console.log("| module | bytes | probe ok | cold load+run ms | cold R2 ms | warm ms | CPU ms (tail) | outcomes | wasm mem B | errors |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
}

async function probesPhase() {
  const runs: Record<string, Call> = {
    memgrow512: await call(`/run?tool=memgrow&stepMb=16&targetMb=512&id=${TAG}-memgrow512`),
    memgrow64: await call(`/run?tool=memgrow&stepMb=16&targetMb=64&id=${TAG}-memgrow64`),
    fetchNull: await call(`/run?tool=fetchprobe&egress=null&id=${TAG}-fetchnull`),
    fetchIntercept: await call(`/run?tool=fetchprobe&egress=intercept&id=${TAG}-fetchintercept`),
    compileDynamic: await call(`/run?tool=compileprobe&id=${TAG}-compile`),
    compileStatic: await call(`/static?tool=compileprobe&run=${TAG}-compilestatic`),
  };
  const ev = await tails(`child/${TAG}-`, 5);
  for (const [k, v] of Object.entries(runs)) {
    const id = `${TAG}-${k.toLowerCase().replace("dynamic", "")}`;
    const t = ev.filter((e) => idOf(e) === id);
    console.log(`\n## ${k}  http ${v.status}  tail ${t.map((x) => `${x.outcome} cpu=${x.cpuTime}ms wall=${x.wallTime}ms`).join(" | ") || "-"}`);
    console.log(JSON.stringify(v.json).slice(0, 1200));
  }
  save("probes", { runs, tails: ev });
}

function deployTools(): string {
  const outp = execFileSync("pnpm", ["exec", "wrangler", "deploy", "-c", "wrangler.tools.jsonc"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = (re: RegExp) => outp.split("\n").find((l) => re.test(l))?.trim() ?? "";
  return `${line(/Total Upload/)} | ${line(/Startup Time/)} | ${line(/Version ID/)}`;
}

async function staticPhase() {
  const out: Record<string, unknown> = { deploys: [] as string[] };
  for (let round = 0; round < STATIC_ROUNDS; round++) {
    for (const tool of TOOLS) {
      // A fresh deploy per tool: the first request after it is the cold one, and no
      // other tool has warmed the shared isolate yet.
      (out.deploys as string[]).push(`${tool} r${round}: ${deployTools()}`);
      const src = fixture(tool);
      const cold = await call(`/static?tool=${tool}&run=${TAG}-s${round}-${tool}-cold`, src);
      // Warm: one host request calling the static Worker WARM_N+1 times over its binding.
      const series = await call(`/static?tool=${tool}&run=${TAG}-s${round}-${tool}-w&repeat=${WARM_N + 1}`, src);
      out[`${tool}-r${round}`] = { cold, series };
    }
  }
  const ev = (await tails("static/", STATIC_ROUNDS * TOOLS.length * (WARM_N + 2))).filter((e) => idOf(e)?.startsWith(`${TAG}-s`));
  console.log("| tool | cold ms (host, per round) | cold CPU ms | warm p50/p95 ms | warm CPU p50/p95 | outcomes | correct |");
  console.log("|---|---|---|---|---|---|---|");
  for (const tool of TOOLS) {
    const rounds = [...Array(STATIC_ROUNDS).keys()].map((r) => out[`${tool}-r${r}`] as { cold: Call; series: Call });
    const all = rounds.flatMap((r) => [r.cold, r.series]);
    const correct = all.filter((c) => c.json.child?.ok && canon(c.json.child.result) === canon(reference[tool])).length;
    const coldCpu = rounds.map((_, r) => ev.find((e) => idOf(e) === `${TAG}-s${r}-${tool}-cold`)?.cpuTime ?? "?");
    const warmEv = ev.filter((e) => idOf(e)?.startsWith(`${TAG}-s`) && idOf(e)?.endsWith(`-${tool}-w`));
    const warmMs = rounds.flatMap((r) => (r.series.json.repeatMs as number[] | undefined) ?? []);
    const summary = {
      coldMs: rounds.map((r) => r.cold.json.totalMs),
      coldCpuMs: coldCpu,
      warmP50Ms: pct(warmMs, 50),
      warmP95Ms: pct(warmMs, 95),
      warmCpuP50Ms: pct(warmEv.map((e) => e.cpuTime), 50),
      warmCpuP95Ms: pct(warmEv.map((e) => e.cpuTime), 95),
      outcomes: [...new Set(ev.filter((e) => idOf(e)?.includes(`-${tool}-`)).map((e) => e.outcome))],
      correct: `${correct}/${all.length}`,
      warmSameResult: rounds.map((r) => `${r.series.json.repeatSameResult}/${(r.series.json.repeatMs as number[] | undefined)?.length}`),
    };
    out[`${tool}-summary`] = summary;
    console.log(
      `| ${tool} | ${summary.coldMs.join("/")} | ${summary.coldCpuMs.join("/")} | ${summary.warmP50Ms}/${summary.warmP95Ms} | ${summary.warmCpuP50Ms}/${summary.warmCpuP95Ms} | ${summary.outcomes.join(",")} | ${summary.correct} + ${summary.warmSameResult.join(",")} |`,
    );
  }
  console.log((out.deploys as string[]).join("\n"));
  out.tails = ev;
  save("static", out);
}

const phases = process.argv.slice(2);
console.log(`tag ${TAG}`);
for (const p of phases) {
  if (p === "dynamic") await dynamicPhase();
  else if (p === "pad") await padPhase();
  else if (p === "probes") await probesPhase();
  else if (p === "static") await staticPhase();
  else throw new Error(`unknown phase ${p}`);
}
