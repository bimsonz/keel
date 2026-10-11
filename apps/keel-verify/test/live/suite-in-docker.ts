// Runs a Tier 2 step's command in the local ExecBox image against forge-lite
// bundles, exactly as a runner would: extract with --strip-components=1 into
// /workspace, then the command. Judges the output with the production judge.
// The step is the js-ts suite, or the worker-app typecheck when the first
// argument is `typecheck`.
//
//   docker build --platform linux/amd64 -t keel-execbox:local apps/keel-verify/containers/sandbox
//   node apps/keel-verify/test/live/suite-in-docker.ts [typecheck] [base|red|canary|type-red|type-canary|no-tsconfig|truncated|truncated-twice|empty] ...
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_APP_PACK } from "@keeltown/core/application/verification";
import { compile } from "@keeltown/core/domain/verification";
import { CommitSha } from "@keeltown/core/kernel";
import { Effect, Result } from "effect";
import { TIER2_RUNNERS } from "../../../keel/src/adapters/driven/ci/suite-runtime.ts";
import { buildBundle, type Variant } from "./bundles.ts";

const IMAGE = process.env["KEEL_EXECBOX_IMAGE"] ?? "keel-execbox:local";
const typecheck = process.argv[2] === "typecheck";
// The worker-app pack compiles both steps, each tiered by policy as a real plan's would be.
const plan = compile(
  undefined,
  { baseCommit: CommitSha.make("0".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
  WORKER_APP_PACK,
);
if (Result.isFailure(plan)) throw new Error("the worker-app pack does not compile");
const step = plan.success.steps.find(
  (s) => s.id === (typecheck ? "worker-app.typecheck" : "js-ts.suite"),
);
const runner = step === undefined ? undefined : TIER2_RUNNERS[step.id];
if (step === undefined || runner === undefined) throw new Error("no runner for the step");

type Case = Variant | "truncated" | "truncated-twice" | "empty";

const run = async (which: Case) => {
  const cut = which === "truncated" || which === "truncated-twice";
  const bundle = await buildBundle(cut || which === "empty" ? "base" : which);
  const dir = mkdtempSync(join(tmpdir(), "keel-d1-"));
  // A truncated bundle stops mid-archive, as a dropped download would; an empty one never arrives.
  const bytes = cut
    ? bundle.bytes.slice(0, Math.floor(bundle.bytes.length * 0.6))
    : which === "empty"
      ? new Uint8Array()
      : bundle.bytes;
  writeFileSync(join(dir, "bundle.tgz"), bytes);
  // The bundle stays fetchable by its hash, as bundles.keel.internal serves it, for the
  // diagnosis and the one verified refetch; `truncated-twice` serves the cut bytes again.
  writeFileSync(
    join(dir, bundle.hash.slice(7)),
    which === "truncated-twice" ? bytes : bundle.bytes,
  );
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
      "-e",
      `KEEL_BUNDLE_URL=file:///in/${bundle.hash.slice(7)}`,
      IMAGE,
      "-c",
      `${checkout}\n(${runner.command})`,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const wallMs = Date.now() - started;
  const judged = await Effect.runPromise(runner.judge(step, stdout, []));
  const e = judged.evidence;
  // Failures as stored: the redacted document, not the raw evidence.
  const named = (key: string): unknown => Reflect.get(Object(judged.document), key) ?? null;
  console.log(
    JSON.stringify({
      step: step.id,
      case: which,
      bundle: bundle.hash,
      stdoutBytes: stdout.length,
      wallMs,
      outcome: judged.report.outcome,
      failure: judged.report.failure ?? null,
      durationMs: judged.report.durationMs,
      why: e.why,
      ...(typecheck
        ? { errors: named("errors"), errorCount: named("errorCount") }
        : { totals: named("totals"), failing: named("failing") }),
      ...(e.diagnosis === undefined ? {} : { diagnosis: e.diagnosis.split("\n") }),
      credentialScan: e.credentialScan ?? null,
      rehydrated: e.rehydrated ?? null,
    }),
  );
};

const CASES: readonly Case[] = [
  "base",
  "red",
  "canary",
  "type-red",
  "type-canary",
  "no-tsconfig",
  "truncated",
  "truncated-twice",
  "empty",
];
const isCase = (arg: string): arg is Case => CASES.some((c) => c === arg);
const asked = process.argv.slice(2).filter(isCase);
for (const which of asked.length > 0 ? asked : (["base", "red"] as const)) await run(which);
