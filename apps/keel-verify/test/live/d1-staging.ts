// KeelVerify's live proofs on staging, through the deployed KeelVerify Workflow and
// keel-verify's KeelSandbox: upload forge-lite bundles to the bundle bucket,
// start KeelVerify instances, and read back what each step persisted.
//
//   CLOUDFLARE_ACCOUNT_ID=… node apps/keel-verify/test/live/d1-staging.ts <command> …
//     upload                         build base, red and canary bundles and put them in R2
//     run <variant> <instance-id>    start one KeelVerify run and print its verdict and timings
//     show <instance-id>...          print a run's verdict and timings again
//     grep <instance-id>...          grep each instance's persisted output, decoded, for credentials
//     series <n> <prefix>            n sequential base runs, then the timing distribution
//
// There is no Lane DO answering recordVerdict yet, so each run's
// `record` step fails after its retries: the evidence stops at the verdict.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { L1_SUITE_PLAN } from "@keeltown/core/application/verification";
import { BatchId, CandidateId, ContentHash } from "@keeltown/core/kernel";
import { Option, Schema } from "effect";
import { keelVerifyParams } from "../../../keel/src/rpc/keel-verify.ts";
import { buildBundle, CANARY_ENV, CANARY_TOKEN, type Variant } from "./bundles.ts";

const KEEL = join(import.meta.dirname, "../../../keel");
const WORKFLOW = "keel-verify-batch";
const BUCKET = "keel-staging-bundles";
const ARCHIVE = "keel-staging-archive";
const account = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
if (!/^[0-9a-f]{32}$/.test(account)) throw new Error("set CLOUDFLARE_ACCOUNT_ID");

const wrangler = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: KEEL,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_userconfig: "/dev/null" },
  });

const bundles = new Map<Variant, string>();
const hashOf = async (variant: Variant) => {
  const known = bundles.get(variant);
  if (known !== undefined) return known;
  const bundle = await buildBundle(variant);
  bundles.set(variant, bundle.hash);
  return bundle.hash;
};

const upload = async () => {
  for (const variant of ["base", "red", "canary"] as const) {
    const bundle = await buildBundle(variant);
    const file = join(mkdtempSync(join(tmpdir(), "keel-d1-")), "bundle.tgz");
    writeFileSync(file, bundle.bytes);
    wrangler(
      "r2",
      "object",
      "put",
      `${BUCKET}/bundles/${bundle.hash.slice(7)}`,
      "--file",
      file,
      "--remote",
    );
    console.log(JSON.stringify({ variant, bundle: bundle.hash, bytes: bundle.bytes.length }));
  }
};

const params = async (variant: Variant, id: string) =>
  keelVerifyParams({
    jobId: id,
    laneId: "lane:prj_d1:default",
    candidateId: Schema.decodeUnknownSync(CandidateId)("cnd_01JZD1D1D1D1D1D1D1D1D1D1D1"),
    bundle: Schema.decodeUnknownSync(ContentHash)(await hashOf(variant)),
    fence: {
      batchId: Schema.decodeUnknownSync(BatchId)("bat_01JZD1D1D1D1D1D1D1D1D1D1D1"),
      attempt: 1,
      chainEpoch: 0,
    },
    planHash: L1_SUITE_PLAN.planHash,
  });

const Step = Schema.Struct({
  name: Schema.String,
  start: Schema.optional(Schema.NullOr(Schema.String)),
  end: Schema.optional(Schema.NullOr(Schema.String)),
  success: Schema.optional(Schema.NullOr(Schema.Boolean)),
  output: Schema.optional(Schema.Unknown),
});
type Step = typeof Step.Type;
/** A step's name as the Workflow code gave it: the API suffixes each with its call count (`verdict-1`). */
const nameOf = (s: Step) => s.name.replace(/-\d+$/, "");
const Described = Schema.Struct({ status: Schema.String, steps: Schema.Array(Schema.Unknown) });
const Envelope = Schema.Struct({ result: Described });
const RunnerLogs = Schema.Struct({ logs: Schema.Struct({ stdout: Schema.String }) });

const describe = (id: string): { status: string; steps: Step[] } => {
  const json: unknown = JSON.parse(
    wrangler(
      "workflows",
      "instances",
      "describe",
      WORKFLOW,
      id,
      "--json",
      "--truncate-output-limit",
      "1000000",
    ),
  );
  const wrapped = Schema.decodeUnknownOption(Envelope)(json);
  const body = Option.isSome(wrapped)
    ? wrapped.value.result
    : Schema.decodeUnknownSync(Described)(json);
  const steps = body.steps.flatMap((s) => {
    const step = Schema.decodeUnknownOption(Step)(s);
    return Option.isSome(step) ? [step.value] : [];
  });
  return { status: body.status, steps };
};

const ms = (s: Step | undefined) =>
  typeof s?.start === "string" && typeof s.end === "string"
    ? Date.parse(s.end) - Date.parse(s.start)
    : null;

const waitForVerdict = async (id: string) => {
  for (let i = 0; i < 120; i++) {
    const d = describe(id);
    const verdict = d.steps.find((s) => nameOf(s) === "verdict" && typeof s.end === "string");
    if (verdict !== undefined || d.status === "errored" || d.status === "complete") return d;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`${id} has no verdict after 4 minutes`);
};

const summarise = (id: string, d: { status: string; steps: Step[] }) => {
  const step = (name: string) => d.steps.find((s) => nameOf(s) === name);
  const plan = step("plan");
  const runner = step(L1_SUITE_PLAN.steps[0]?.id ?? "");
  const verdict = step("verdict");
  return {
    id,
    status: d.status,
    verdict: verdict?.output ?? null,
    runnerMs: ms(runner),
    verifyMs:
      typeof plan?.start === "string" && typeof verdict?.end === "string"
        ? Date.parse(verdict.end) - Date.parse(plan.start)
        : null,
    steps: d.steps.map((s) => ({ name: s.name, ms: ms(s), success: s.success ?? null })),
  };
};

const run = async (variant: Variant, id: string) => {
  wrangler("workflows", "trigger", WORKFLOW, JSON.stringify(await params(variant, id)), "--id", id);
  return summarise(id, await waitForVerdict(id));
};

/** Everything a runner's persisted output says, with its encoded fields decoded so a grep can see them. */
const persisted = (d: { steps: Step[] }) => {
  const runner = d.steps.find((s) => nameOf(s) === L1_SUITE_PLAN.steps[0]?.id);
  const logs = Schema.decodeUnknownOption(RunnerLogs)(runner?.output);
  const stdout = Option.isSome(logs) ? logs.value.logs.stdout : "";
  const field = (key: string) =>
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key} `))
      ?.slice(key.length + 1);
  const tail = Buffer.from(field("KEEL_TAIL") ?? "", "base64").toString("utf8");
  const report = field("KEEL_REPORT");
  const decoded =
    report === undefined || report === "none"
      ? ""
      : gunzipSync(Buffer.from(report, "base64")).toString("utf8");
  return [
    JSON.stringify(runner?.output ?? null),
    tail,
    decoded,
    JSON.stringify(d.steps.map((s) => s.output ?? null)),
  ].join("\n");
};

const PATTERNS: readonly [string, RegExp][] = [
  ["artifacts token", /art_v\d+_[A-Za-z0-9_.~+/=-]+/g],
  ["expiry", /[?&]expires=\d+/g],
  ["artifacts remote", /[A-Za-z0-9-]+\.artifacts\.cloudflare\.net/g],
  ["account id", new RegExp(account, "g")],
  [
    "cloudflare api token var",
    /CLOUDFLARE_API_TOKEN|CF_TOKEN|ARTIFACTS_TOKEN|SOURCE_CONTROL_TOKEN|R2_SECRET_ACCESS_KEY/g,
  ],
];

const grep = (text: string) =>
  PATTERNS.map(([name, re]) => {
    const hits = [...new Set(text.match(re) ?? [])];
    return {
      name,
      hits: hits.length,
      canary: hits.filter((h) => h.includes("KEELCANARY")).length,
      sample: hits.slice(0, 3),
    };
  });

const evidenceOf = (d: { steps: Step[] }) => {
  const ref = d.steps.find((s) => nameOf(s).endsWith(":evidence"))?.output;
  if (typeof ref !== "string") return "";
  return wrangler(
    "r2",
    "object",
    "get",
    `${ARCHIVE}/evidence/${ref.slice(7)}`,
    "--remote",
    "--pipe",
  );
};

/** A distribution of durations, in milliseconds. */
const dist = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s.at(-1), all: s };
};

const VARIANTS: readonly Variant[] = ["base", "red", "canary"];
const variantOf = (arg: string | undefined): Variant => VARIANTS.find((v) => v === arg) ?? "base";

const [command, ...args] = process.argv.slice(2);
if (command === "upload") await upload();
else if (command === "run")
  console.log(
    JSON.stringify(
      await run(variantOf(args[0]), args[1] ?? `keel-verify-d1-${Date.now()}`),
      null,
      1,
    ),
  );
else if (command === "show")
  for (const id of args) console.log(JSON.stringify(summarise(id, describe(id)), null, 1));
else if (command === "grep")
  for (const id of args) {
    const d = describe(id);
    console.log(
      JSON.stringify(
        {
          id,
          persisted: grep(persisted(d)),
          evidence: grep(evidenceOf(d)),
          planted: { token: CANARY_TOKEN, env: CANARY_ENV },
        },
        null,
        1,
      ),
    );
  }
else if (command === "series") {
  const n = Number(args[0] ?? 10);
  const prefix = args[1] ?? `keel-verify-d1-p50-${Date.now()}`;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = await run("base", `${prefix}-${i}`);
    rows.push(row);
    const outcome = Schema.decodeUnknownOption(Schema.Struct({ outcome: Schema.String }))(
      row.verdict,
    );
    console.log(
      JSON.stringify({
        i,
        outcome: Option.isSome(outcome) ? outcome.value.outcome : null,
        runnerMs: row.runnerMs,
        verifyMs: row.verifyMs,
      }),
    );
  }

  console.log(
    JSON.stringify(
      {
        runner: dist(rows.map((r) => r.runnerMs).filter((x): x is number => x !== null)),
        verify: dist(rows.map((r) => r.verifyMs).filter((x): x is number => x !== null)),
      },
      null,
      1,
    ),
  );
} else
  throw new Error(
    "usage: upload | run <variant> <id> | show <id>... | grep <id>... | series <n> <prefix>",
  );
