// Client for the keel-spike-26-probe Worker. BASE and TOKEN come from the
// environment and are never written to a file.
//
//   node scripts/drive.ts setup <scratch-dir>                 upload worlds.json + draft-input.json
//   node scripts/drive.ts prompt <out.json>                   save the rendered prompt
//   node scripts/drive.ts eval <probe.ts> <out.json> [--rewrite-imports]
//   node scripts/drive.ts draft <label> <model> <api> <n> <concurrency> <out-dir> [temperature] [maxTokens]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { staticCheck } from "./static-check.ts";

const BASE = process.env.BASE;
const TOKEN = process.env.TOKEN;
if (!BASE || !TOKEN) throw new Error("set BASE and TOKEN");

async function call(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-spike-token": TOKEN!, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  if ((res.headers.get("content-type") ?? "").includes("ndjson")) {
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = lines.findLast((l) => "result" in l || "error" in l);
    if (!last || "error" in last) throw new Error(`${path}: ${JSON.stringify(last ?? lines.at(-1)).slice(0, 1000)}`);
    return last.result;
  }
  return JSON.parse(text);
}

function summarizeEval(r: Record<string, any>): string {
  const rows = (r.evals as any[]).map((e) => {
    const obs = e.bundleError ? `bundle error: ${String(e.bundleError).split("\n")[0]}` : e.runs.map((x: any) => (x.exit === 2 ? "harness-error" : x.outcome)).join("/");
    const reason = e.runs?.[0]?.reason ?? "";
    return `${e.world.padEnd(8)} ${obs.padEnd(26)} ${String(reason).slice(0, 110)}`;
  });
  return [
    ...rows,
    `admitted=${r.admission.admitted} failures=[${r.admission.failures.join(",")}] vacuous=${r.vacuity.vacuous}${r.vacuity.why ? ` (${r.vacuity.why})` : ""}`,
    `bundle ms ${JSON.stringify(r.bundleMs)} bytes ${r.bytes} wall ${r.wallMs} ms`,
  ].join("\n");
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "setup": {
    const dir = args[0]!;
    const worlds = JSON.parse(readFileSync(join(dir, "worlds.json"), "utf8"));
    const input = JSON.parse(readFileSync(join(dir, "draft-input.json"), "utf8"));
    console.log(JSON.stringify(await call("/setup", { worlds, input })));
    break;
  }
  case "prompt": {
    const r = (await call("/prompt")) as { chars: number };
    writeFileSync(args[0]!, JSON.stringify(r, null, 2));
    console.log(`prompt chars ${r.chars}`);
    break;
  }
  case "eval": {
    let probe = readFileSync(args[0]!, "utf8");
    // The fixture's probe lives in scenarios/s1/; in Tier 1 the probe sits at probe/.
    if (args.includes("--rewrite-imports")) probe = probe.replaceAll('"../../src/', '"../src/');
    const r = (await call("/evaluate", { probe })) as Record<string, any>;
    const check = staticCheck(probe);
    writeFileSync(args[1]!, JSON.stringify({ ...r, staticCheck: check }, null, 2));
    console.log(summarizeEval(r));
    console.log(`static: deleteSites=${check.deleteSites.length} unasserted=${check.unasserted.length}${check.unasserted.length ? ` ${JSON.stringify(check.unasserted)}` : ""}`);
    break;
  }
  case "draft": {
    const [label, model, api, nStr, cStr, outDir, temp, maxTok] = args;
    const n = Number(nStr);
    const settings = { model, api, temperature: Number(temp ?? 0.6), maxTokens: Number(maxTok ?? 16000) };
    const mode = process.env.MODE === "template" ? "template" : "probe";
    mkdirSync(outDir!, { recursive: true });
    let next = 0;
    await Promise.all(
      Array.from({ length: Number(cStr) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= n) return;
          const file = join(outDir!, `${label}-${String(i + 1).padStart(2, "0")}.json`);
          if (existsSync(file)) continue;
          const t0 = Date.now();
          try {
            const job = (await call("/draft", { settings, mode, tag: `${label}-${i + 1}-${Date.now()}` })) as Record<string, any>;
            if (job.final) job.final.staticCheck = staticCheck(job.final.probe);
            writeFileSync(file, JSON.stringify(job, null, 2));
            const f = job.final;
            console.log(
              `${label} #${i + 1}: ${job.outcome} attempts=${job.attemptsUsed} ` +
                `${f ? Object.entries(f.admission.cells).map(([w, c]: [string, any]) => `${w}=${c.observed.join("/")}`).join(" ") : ""} ` +
                `vacuous=${f?.vacuity.vacuous} wall=${Math.round((Date.now() - t0) / 1000)}s`,
            );
          } catch (e) {
            console.log(`${label} #${i + 1}: driver error ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }),
    );
    break;
  }
  default:
    throw new Error(`unknown command ${String(cmd)}`);
}
