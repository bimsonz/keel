// Runs the js-ts suite command in the local ExecBox image against forge-lite
// bundles, exactly as a runner would: extract with --strip-components=1 into
// /workspace, then the command. Judges the output with the production parser.
//
//   docker build --platform linux/amd64 -t keel-execbox:local apps/keel-verify/containers/sandbox
//   node apps/keel-verify/test/live/suite-in-docker.ts [base|red|canary|truncated|empty] ...
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L1_SUITE_PLAN } from "@keeltown/core/application/verification";
import { Effect } from "effect";
import {
  JS_TS_SUITE_COMMAND,
  judgeRunnerOutput,
} from "../../../keel/src/adapters/driven/ci/suite-runtime.ts";
import { buildBundle, type Variant } from "./bundles.ts";

const IMAGE = process.env["KEEL_EXECBOX_IMAGE"] ?? "keel-execbox:local";
const step = L1_SUITE_PLAN.steps[0];
if (step === undefined) throw new Error("the L1 plan has no step");

type Case = Variant | "truncated" | "empty";

const run = async (which: Case) => {
  const bundle = await buildBundle(which === "truncated" || which === "empty" ? "base" : which);
  const dir = mkdtempSync(join(tmpdir(), "keel-d1-"));
  // A truncated bundle stops mid-archive, as a dropped download would; an empty one never arrives.
  const bytes =
    which === "truncated"
      ? bundle.bytes.slice(0, Math.floor(bundle.bytes.length * 0.6))
      : which === "empty"
        ? new Uint8Array()
        : bundle.bytes;
  writeFileSync(join(dir, "bundle.tgz"), bytes);
  const checkout =
    "rm -rf /workspace && mkdir -p /workspace && tar -xz --strip-components=1 -C /workspace -f /in/bundle.tgz; true";
  const started = Date.now();
  const stdout = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--entrypoint",
      "sh",
      "-v",
      `${dir}:/in:ro`,
      IMAGE,
      "-c",
      `${checkout}\n(${JS_TS_SUITE_COMMAND})`,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const wallMs = Date.now() - started;
  const judged = await Effect.runPromise(judgeRunnerOutput(step, stdout, []));
  const e = judged.evidence;
  console.log(
    JSON.stringify({
      case: which,
      bundle: bundle.hash,
      stdoutBytes: stdout.length,
      wallMs,
      outcome: judged.report.outcome,
      failure: judged.report.failure ?? null,
      why: e.why,
      totals: e.totals ?? null,
      failing: e.failing.slice(0, 3).map((f) => `${f.file} > ${f.test ?? "(file)"}`),
      failingCount: e.failing.length,
    }),
  );
};

const CASES: readonly Case[] = ["base", "red", "canary", "truncated", "empty"];
const isCase = (arg: string): arg is Case => CASES.some((c) => c === arg);
const asked = process.argv.slice(2).filter(isCase);
for (const which of asked.length > 0 ? asked : (["base", "red"] as const)) await run(which);
