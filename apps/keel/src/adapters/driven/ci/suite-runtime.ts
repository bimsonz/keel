import {
  BUILD_BUNDLE_LIMIT,
  BUILD_CONFIG_LIMIT,
  BUILD_PROTOCOL,
  type BuildJudgement,
  COMMAND_PROTOCOL,
  COMMAND_REPORT_LIMIT,
  COMMAND_TAIL_LIMIT,
  type CommandJudgement,
  type DepsAnswer,
  depsStop,
  failingTestsOf,
  JS_TS_SUITE,
  judgeBuild,
  judgeCommand,
  judgeSuite,
  judgeTypecheck,
  parseBuildOutput,
  parseCommandOutput,
  parseSuiteOutput,
  parseTypecheckOutput,
  redact,
  type RunnerEvidence,
  type RunnerJudgement,
  scanCredentials,
  SUITE_PROTOCOL,
  type SuiteJudgement,
  TYPECHECK_OUTPUT_LIMIT,
  TYPECHECK_PROTOCOL,
  type TypecheckJudgement,
  WORKER_APP_BUILD,
  WORKER_APP_TYPECHECK,
} from "@keeltown/core/application/verification";
import type { ContentHash, Json, NamespaceId } from "@keeltown/core/kernel";
import type { PlanStep, StepResult, StepRun } from "@keeltown/core/domain/verification";
import { EvidenceStore, VerifierRuntime } from "@keeltown/core/ports";
import {
  BUNDLE_URL_TTL_SECONDS,
  DEPS_DROP_SH,
  DEPS_FETCH_SH,
  HYDRATE_SH,
  signedBundleUrl,
  signedDepsPartUrl,
} from "@keeltown/runner-protocol";
import { Clock, Effect, Layer } from "effect";
import { BUILD_SCRIPT, ROLLDOWN_IN_WORKSPACE } from "./build-script.ts";

/**
 * Puts the step's deps bundle into the hydrated workspace from the parts'
 * signed URLs in `$KEEL_DEPS_PARTS` (`keel_deps_fetch`), and says
 * `KEEL_DEPS ok`. A bundle that cannot be put there stops the run as
 * `KEEL_DEPS missing <why>`, with whatever was extracted removed. The list is
 * expanded unquoted and a signed URL holds a `?`, so no glob may read it
 * (`set -f`).
 */
export const DEPS_IN_PLACE = [
  "set -f",
  'why=$(keel_deps_fetch $K /workspace ${KEEL_DEPS_PARTS:-}) || { keel_deps_drop /workspace; echo "KEEL_DEPS missing $why"; echo KEEL_END; exit 0; }',
  "set +f",
  "echo KEEL_DEPS ok",
].join("\n");

/**
 * pnpm 11 checks a project's dependencies before every `pnpm run`, `pnpm
 * exec` and `pnpm -r run`, and when the check fails (as it does on a
 * checkout whose package.json files are newer than the install) it starts
 * `pnpm install`. A Tier 2 box has no route out, so that install can never
 * succeed: it only hangs until the step times out. The dependencies in the
 * box are Keel's own guarantee instead (built for the candidate's install
 * digest, every part checked by its hash), so every Tier 2 command switches
 * the check off, overriding a project's own `verifyDepsBeforeRun` only here,
 * where no setting of it can work. Exported, so it reaches a nested `pnpm run`.
 */
export const NO_DEPS_CHECK = "export pnpm_config_verify_deps_before_run=false";

/**
 * The js-ts suite command (POSIX sh). It always exits 0: a non-zero exit would
 * make the engine throw and retry in a fresh sandbox. The outcome travels
 * in-band per SUITE_PROTOCOL instead:
 * 1. hydration: /workspace must match the bundle's manifest, by hash and by
 *    file count, because the engine never checks its archive checkout. A
 *    mismatch is diagnosed (`KEEL_HYDRATION_DIFF`) and refetched once from
 *    `$KEEL_BUNDLE_URL`, accepted only by its content address
 *    (`KEEL_HYDRATION_RETRIED`); see HYDRATE_SH;
 * 2. the deps bundle built for the candidate's install digest is fetched
 *    part by part, each checked against the hash its URL names, and untarred
 *    into the workspace (DEPS_IN_PLACE);
 * 3. vitest must be among them: with none the command says `KEEL_VITEST none`
 *    and drops the deps, as it does after a run;
 * 4. vitest runs with its JSON reporter; its console goes to a file, so test
 *    output can never forge a marker, and only a base64 tail is printed;
 * 5. the fetched deps are removed (`keel_deps_drop`): the engine snapshots
 *    the workspace of a runner that exits 0, and they are not a run's to keep.
 */
export const JS_TS_SUITE_COMMAND = [
  "set -u",
  "K=/tmp/keel; rm -rf $K; mkdir -p $K",
  `echo ${SUITE_PROTOCOL}`,
  'stop() { echo "KEEL_HYDRATION failed $1"; echo KEEL_END; exit 0; }',
  HYDRATE_SH,
  DEPS_FETCH_SH,
  DEPS_DROP_SH,
  "cd /workspace 2>/dev/null || stop no-workspace",
  'keel_hydrate $K "${KEEL_BUNDLE_URL:-}" || { echo KEEL_END; exit 0; }',
  DEPS_IN_PLACE,
  NO_DEPS_CHECK,
  "if [ ! -f node_modules/vitest/vitest.mjs ]; then keel_deps_drop /workspace; echo KEEL_VITEST none; echo KEEL_END; exit 0; fi",
  "echo KEEL_VITEST ok",
  "start=$(date +%s%3N)",
  "node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=$K/report.json >$K/console.log 2>&1",
  "code=$?",
  "end=$(date +%s%3N)",
  'echo "KEEL_EXIT $code"',
  'echo "KEEL_DURATION_MS $((end - start))"',
  'echo "KEEL_TAIL $(tail -c 4096 $K/console.log | base64 -w0)"',
  'if [ -s $K/report.json ]; then echo "KEEL_REPORT $(gzip -c $K/report.json | base64 -w0)"; else echo "KEEL_REPORT none"; fi',
  "keel_deps_drop /workspace",
  "echo KEEL_END",
  "exit 0",
].join("\n");

/**
 * The worker-app typecheck command (POSIX sh), per TYPECHECK_PROTOCOL. It
 * hydrates and fetches the deps bundle exactly as the suite command does, and
 * removes it as that does, whichever way it ends. Between the two it runs the project's own TypeScript (`tsc --noEmit --pretty false`, so
 * each error is one `file(line,col): error TSnnnn: message` line). tsc's
 * output goes to a file and only its first TYPECHECK_OUTPUT_LIMIT bytes are
 * printed, gzipped and base64'd, so nothing it prints can forge a marker.
 * With no tsconfig.json at the root tsc would only print its help, so the
 * command says so instead. It always exits 0.
 */
export const TYPECHECK_COMMAND = [
  "set -u",
  "K=/tmp/keel; rm -rf $K; mkdir -p $K",
  `echo ${TYPECHECK_PROTOCOL}`,
  'stop() { echo "KEEL_HYDRATION failed $1"; echo KEEL_END; exit 0; }',
  HYDRATE_SH,
  DEPS_FETCH_SH,
  DEPS_DROP_SH,
  "cd /workspace 2>/dev/null || stop no-workspace",
  'keel_hydrate $K "${KEEL_BUNDLE_URL:-}" || { echo KEEL_END; exit 0; }',
  DEPS_IN_PLACE,
  NO_DEPS_CHECK,
  "if [ ! -f tsconfig.json ]; then keel_deps_drop /workspace; echo KEEL_TSCONFIG none; echo KEEL_END; exit 0; fi",
  "echo KEEL_TSCONFIG ok",
  "start=$(date +%s%3N)",
  "node node_modules/typescript/bin/tsc --noEmit --pretty false >$K/tsc.log 2>&1",
  "code=$?",
  "end=$(date +%s%3N)",
  'echo "KEEL_EXIT $code"',
  'echo "KEEL_DURATION_MS $((end - start))"',
  `echo "KEEL_OUTPUT_BYTES $(wc -c <$K/tsc.log | tr -d ' ')"`,
  `if [ -s $K/tsc.log ]; then echo "KEEL_OUTPUT $(head -c ${TYPECHECK_OUTPUT_LIMIT} $K/tsc.log | gzip -c | base64 -w0)"; else echo "KEEL_OUTPUT none"; fi`,
  "keel_deps_drop /workspace",
  "echo KEEL_END",
  "exit 0",
].join("\n");

/** Base64 of a string's UTF-8 bytes, on one line. */
const base64Of = (text: string): string =>
  btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));

/** The lines that print a step's JUnit report per COMMAND_PROTOCOL, then remove it. */
const readReport = (path: string): readonly string[] => [
  `R=$(echo ${base64Of(path)} | base64 -d)`,
  'if [ -L "$R" ] || [ ! -f "$R" ]; then echo "KEEL_REPORT none missing";',
  `elif [ "$(wc -c <"$R" | tr -d ' ')" -gt ${COMMAND_REPORT_LIMIT} ]; then echo "KEEL_REPORT none too-large";`,
  'else echo "KEEL_REPORT $(gzip -c "$R" | base64 -w0)"; fi',
  'rm -f "$R"',
];

/**
 * The command (POSIX sh) for a step command of the project's own
 * (`PlanStep.run`), per COMMAND_PROTOCOL. It hydrates, puts the deps in place
 * and drops them as the suite command does, and always exits 0. The project's
 * command goes in as one base64 literal, so nothing in it is quoted or read
 * by this shell, and it runs as a script under its own `sh` with no stdin:
 * an `exit` or a `set` in it ends only that `sh`. Its output goes to a file
 * and only its last COMMAND_TAIL_LIMIT bytes are printed, base64'd, so
 * nothing it prints can forge a marker.
 *
 * A step naming a JUnit report has it read back after the command: a regular
 * file of at most COMMAND_REPORT_LIMIT bytes is printed gzipped and base64'd;
 * a missing one, a link or anything else is `none missing`, a larger one
 * `none too-large`. The path goes in as base64 too, and the file is removed
 * either way, so the workspace's snapshot never keeps it.
 */
export const projectCommand = (run: StepRun): string =>
  [
    "set -u",
    "K=/tmp/keel; rm -rf $K; mkdir -p $K",
    `echo ${COMMAND_PROTOCOL}`,
    'stop() { echo "KEEL_HYDRATION failed $1"; echo KEEL_END; exit 0; }',
    HYDRATE_SH,
    DEPS_FETCH_SH,
    DEPS_DROP_SH,
    "cd /workspace 2>/dev/null || stop no-workspace",
    'keel_hydrate $K "${KEEL_BUNDLE_URL:-}" || { echo KEEL_END; exit 0; }',
    DEPS_IN_PLACE,
    NO_DEPS_CHECK,
    `echo ${base64Of(run.command)} | base64 -d >$K/command.sh`,
    "start=$(date +%s%3N)",
    "sh $K/command.sh >$K/output.log 2>&1 </dev/null",
    "code=$?",
    "end=$(date +%s%3N)",
    'echo "KEEL_EXIT $code"',
    'echo "KEEL_DURATION_MS $((end - start))"',
    `if [ -s $K/output.log ]; then echo "KEEL_TAIL $(tail -c ${COMMAND_TAIL_LIMIT} $K/output.log | base64 -w0)"; else echo "KEEL_TAIL none"; fi`,
    ...(run.report === undefined ? [] : readReport(run.report.junit)),
    "keel_deps_drop /workspace",
    "echo KEEL_END",
    "exit 0",
  ].join("\n");

/**
 * The worker-app build command (POSIX sh), per BUILD_PROTOCOL, for the Worker
 * at `path` (the base's deploy spec's, which its pattern keeps to `[\w./-]`
 * with no `..`; the repo's root when absent). It hydrates, puts the deps in
 * place and drops them as the suite command does, and always exits 0. The
 * wrangler config is the first of wrangler.jsonc, wrangler.json and
 * wrangler.toml there that is a plain file (a symlink is not followed), and its
 * first BUILD_CONFIG_LIMIT bytes are printed for Keel to judge. The build
 * script goes in as one base64 literal and runs under node with no stdin; its
 * console goes to a file and only a base64 tail is printed, so nothing it
 * prints can forge a marker. The module is printed gzipped and base64'd, or
 * `too-large` past BUILD_BUNDLE_LIMIT.
 */
export const buildCommand = (path: string | undefined): string =>
  [
    "set -u",
    "K=/tmp/keel; rm -rf $K; mkdir -p $K",
    `echo ${BUILD_PROTOCOL}`,
    'stop() { echo "KEEL_HYDRATION failed $1"; echo KEEL_END; exit 0; }',
    "finish() { keel_deps_drop /workspace; echo KEEL_END; exit 0; }",
    HYDRATE_SH,
    DEPS_FETCH_SH,
    DEPS_DROP_SH,
    "cd /workspace 2>/dev/null || stop no-workspace",
    'keel_hydrate $K "${KEEL_BUNDLE_URL:-}" || { echo KEEL_END; exit 0; }',
    DEPS_IN_PLACE,
    NO_DEPS_CHECK,
    `D='/workspace/${path ?? "."}'`,
    'cfg=""; for f in wrangler.jsonc wrangler.json wrangler.toml; do if [ -f "$D/$f" ] && [ ! -L "$D/$f" ]; then cfg=$f; break; fi; done',
    'if [ -z "$cfg" ]; then echo "KEEL_CONFIG none"; finish; fi',
    `echo "KEEL_CONFIG $cfg $(wc -c <"$D/$cfg" | tr -d ' ') $(head -c ${BUILD_CONFIG_LIMIT} "$D/$cfg" | base64 -w0)"`,
    `R=${ROLLDOWN_IN_WORKSPACE}`,
    'if [ ! -f "$R" ]; then echo "KEEL_BUNDLER none"; finish; fi',
    "echo KEEL_BUNDLER ok",
    `echo ${base64Of(BUILD_SCRIPT)} | base64 -d >$K/build.mjs`,
    "start=$(date +%s%3N)",
    'node $K/build.mjs "$R" "$D/$cfg" $K/worker.js >$K/build.log 2>&1 </dev/null',
    "code=$?",
    "end=$(date +%s%3N)",
    'echo "KEEL_EXIT $code"',
    'echo "KEEL_DURATION_MS $((end - start))"',
    'if [ -s $K/build.log ]; then echo "KEEL_TAIL $(tail -c 4096 $K/build.log | base64 -w0)"; else echo "KEEL_TAIL none"; fi',
    `if [ $code -eq 0 ] && [ -s $K/worker.js ]; then gzip -c $K/worker.js >$K/worker.js.gz; n=$(wc -c <$K/worker.js.gz | tr -d ' '); if [ "$n" -gt ${BUILD_BUNDLE_LIMIT} ]; then echo "KEEL_BUNDLE too-large $n"; else echo "KEEL_BUNDLE $(base64 -w0 <$K/worker.js.gz)"; fi; else echo "KEEL_BUNDLE none"; fi`,
    "finish",
  ].join("\n");

/** What a suite runner is asked: never a credential, one infra retry, bounded time, short-lived snapshots. */
export interface SuiteRunnerOptions {
  readonly name: string;
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly config: {
    readonly retries: {
      readonly limit: number;
      readonly delay: number;
      readonly backoff: "constant";
    };
    readonly timeout: number;
    readonly commandTimeoutMs: number;
    readonly snapshotRetentionSeconds: number;
  };
  readonly cloudflareCredentials: false;
  readonly sourceControlCredentials: false;
}

/**
 * exec passes on only PATH, so HOME is given explicitly, with the signed URL
 * of the namespace's bundle for a hydration diagnosis and its one refetch,
 * and the signed URLs of its deps bundle's parts, in order and separated by
 * spaces; nothing else is.
 */
export const suiteEnv = (
  bundleUrl: string,
  partUrls: readonly string[],
): SuiteRunnerOptions["env"] => ({
  HOME: "/root",
  KEEL_BUNDLE_URL: bundleUrl,
  KEEL_DEPS_PARTS: partUrls.join(" "),
});

export const SUITE_CONFIG: SuiteRunnerOptions["config"] = {
  // The command exits 0 whatever the tests do, so a retry only ever follows an infra failure.
  retries: { limit: 1, delay: 5_000, backoff: "constant" },
  timeout: 5 * 60_000,
  commandTimeoutMs: 4 * 60_000,
  snapshotRetentionSeconds: 3_600,
};

/** One Tier 2 runner call through the CI engine. It persists the raw logs as its own step output. */
export type SuiteRunner = (
  options: SuiteRunnerOptions,
) => Promise<{ readonly logs: { readonly stdout: string | ReadableStream<Uint8Array> } }>;

/** Stores evidence as a durable Workflow step: a replay returns the first hash instead of storing again. */
export type Durable = (
  name: string,
  effect: Effect.Effect<ContentHash>,
) => Effect.Effect<ContentHash>;

const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const textOf = (b64: string): string => new TextDecoder().decode(bytesOf(b64));
/** The text base64 encodes, or undefined when it does not decode. */
const decodedText = (b64: string): string | undefined => {
  try {
    return textOf(b64);
  } catch {
    return undefined;
  }
};

const gunzipText = (b64: string | undefined): Effect.Effect<string | undefined> =>
  b64 === undefined
    ? Effect.succeed(undefined)
    : Effect.promise(async () => {
        try {
          const stream = new Blob([bytesOf(b64).slice()]).stream();
          return await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).text();
        } catch {
          return undefined;
        }
      });

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const redactJson = (value: Json, literals: readonly string[]): Json => {
  if (typeof value === "string") return redact(value, { literals });
  if (Array.isArray(value)) return value.map((v) => redactJson(v, literals));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJson(v, literals)]));
  return value;
};

/** A failed or retried hydration's diagnosis, decoded from the base64 the runner printed. */
const diagnosisOf = (output: {
  readonly _tag: string;
  readonly diagnosis?: string;
}): { diagnosis?: string } =>
  (output._tag === "ran" || output._tag === "hydration-failed") && output.diagnosis !== undefined
    ? { diagnosis: textOf(output.diagnosis) }
    : {};

/** A judgement with its evidence redacted, ready to store. */
export type StorableJudgement = RunnerJudgement<RunnerEvidence> & { readonly document: Json };

/**
 * Reads one suite runner's stdout into a judgement: parse the in-band report,
 * decode what the runner encoded, scan all of it raw for credentials (any hit
 * abstains, and only the counts are kept), judge it, and redact the evidence
 * so it is safe to store. Pure but for decompression.
 */
export const judgeSuiteOutput = (
  step: PlanStep,
  stdout: string,
  literals: readonly string[],
): Effect.Effect<SuiteJudgement & { readonly document: Json }> =>
  Effect.gen(function* () {
    const output = parseSuiteOutput(stdout);
    const reportText = output._tag === "ran" ? yield* gunzipText(output.report) : undefined;
    const diagnosis = diagnosisOf(output);
    const decoded: { report: unknown; tail: string; diagnosis?: string } = {
      ...(output._tag === "ran"
        ? { report: parseJson(reportText), tail: textOf(output.tail) }
        : { report: undefined, tail: "" }),
      ...diagnosis,
    };
    const credentialScan = scanCredentials(
      [stdout, decoded.tail, reportText ?? "", decoded.diagnosis ?? ""],
      { literals },
    );
    const judged = judgeSuite(step, output, { ...decoded, credentialScan });
    // vitest names files absolutely; cite them relative to the candidate's root.
    const evidence = {
      ...judged.evidence,
      failing: judged.evidence.failing.map((f) => ({
        ...f,
        file: f.file.replace(/^\/workspace\//, ""),
      })),
    };
    return { ...judged, evidence, document: redactJson(evidence, literals) };
  });

/**
 * Reads one typecheck runner's stdout into a judgement, the same way: parse,
 * decode tsc's output, scan it all raw, judge, redact. tsc names files
 * relative to the workspace already.
 */
export const judgeTypecheckOutput = (
  step: PlanStep,
  stdout: string,
  literals: readonly string[],
): Effect.Effect<TypecheckJudgement & { readonly document: Json }> =>
  Effect.gen(function* () {
    const output = parseTypecheckOutput(stdout);
    const text = output._tag === "ran" ? yield* gunzipText(output.output) : undefined;
    const diagnosis = diagnosisOf(output);
    const credentialScan = scanCredentials([stdout, text ?? "", diagnosis.diagnosis ?? ""], {
      literals,
    });
    const judged = judgeTypecheck(step, output, { output: text, ...diagnosis, credentialScan });
    const evidence = { ...judged.evidence, errors: judged.evidence.errors.map((e) => ({ ...e })) };
    return { ...judged, evidence, document: redactJson(evidence, literals) };
  });

/**
 * Reads one project command runner's stdout into a judgement, as for a
 * typecheck: parse, decode the output's tail, scan it all raw, judge, redact.
 */
export const judgeCommandOutput = (
  step: PlanStep,
  stdout: string,
  literals: readonly string[],
): Effect.Effect<CommandJudgement & { readonly document: Json }> =>
  Effect.gen(function* () {
    const output = parseCommandOutput(stdout);
    const tail =
      output._tag === "ran" && output.tail !== undefined ? decodedText(output.tail) : undefined;
    const report = output._tag === "ran" ? yield* gunzipText(output.report) : undefined;
    const diagnosis = diagnosisOf(output);
    // Of the report, only the failing tests' names are kept, so only they are scanned:
    // a failure message quoting a test's sample key never abstains the step.
    const cited = report === undefined ? "" : JSON.stringify(failingTestsOf(report) ?? []);
    const credentialScan = scanCredentials([stdout, tail ?? "", cited, diagnosis.diagnosis ?? ""], {
      literals,
    });
    const judged = judgeCommand(step, output, {
      tail,
      ...(report === undefined ? {} : { report }),
      ...diagnosis,
      credentialScan,
    });
    // A report may name files absolutely; cite them relative to the candidate's root.
    const evidence =
      judged.evidence.failing === undefined
        ? judged.evidence
        : {
            ...judged.evidence,
            failing: judged.evidence.failing.map((f) => ({
              ...f,
              file: f.file.replace(/^\/workspace\//, ""),
            })),
          };
    return { ...judged, evidence, document: redactJson({ ...evidence }, literals) };
  });

/**
 * Reads one build runner's stdout into a judgement, as for a command: parse,
 * decode the config's and the tail's text, scan it raw, judge, redact. The
 * evidence of a pass carries the module, for the preview to upload.
 *
 * The module is an artefact, not a log. Credential shapes are scanned for and
 * redacted in the build's log only (stdout with the module taken out, the
 * config, the tail), so a dependency's sample key never abstains its app.
 * The module, unzipped, is checked only for the run's own literals, the
 * values Keel handed the box, which no third-party code can hold: a hit
 * abstains. It is never redacted, so the version uploaded is the one built.
 */
export const judgeBuildOutput = (
  step: PlanStep,
  stdout: string,
  literals: readonly string[],
): Effect.Effect<BuildJudgement & { readonly document: Json }> =>
  Effect.gen(function* () {
    const output = parseBuildOutput(stdout);
    const config = output._tag === "ran" ? decodedText(output.config.text) : undefined;
    const tail =
      output._tag === "ran" && output.tail !== undefined ? (decodedText(output.tail) ?? "") : "";
    const diagnosis = diagnosisOf(output);
    const gzip =
      output._tag === "ran" && output.bundle._tag === "module" ? output.bundle.gzip : undefined;
    const log = gzip === undefined ? stdout : stdout.split(gzip).join("");
    const logged = scanCredentials([log, tail, config ?? "", diagnosis.diagnosis ?? ""], {
      literals,
    });
    const module = yield* gunzipText(gzip);
    const inModule = scanCredentials([module ?? "", gzip ?? ""], { literals }).literal;
    const credentialScan = { ...logged, literal: logged.literal + inModule };
    const judged = judgeBuild(step, output, { config, tail, ...diagnosis, credentialScan });
    const { bundle, ...evidence } = judged.evidence;
    const redacted = Object.entries(evidence).map(([key, value]) => [
      key,
      redactJson(value, literals),
    ]);
    return {
      ...judged,
      document: Object.fromEntries(
        bundle === undefined ? redacted : [...redacted, ["bundle", bundle]],
      ),
    };
  });

/**
 * A Tier 2 step this runtime can run: the command a runner executes (the same
 * for every step, or made from the plan step, as a build is from its deploy
 * spec's path), and how its stdout is judged.
 */
export interface Tier2Runner {
  readonly command: string | ((step: PlanStep) => string);
  readonly judge: (
    step: PlanStep,
    stdout: string,
    literals: readonly string[],
  ) => Effect.Effect<StorableJudgement>;
}

/** Every Tier 2 step this runtime can run, by step id. Any other step abstains here. */
export const TIER2_RUNNERS: Readonly<Record<string, Tier2Runner>> = {
  [JS_TS_SUITE.id]: { command: JS_TS_SUITE_COMMAND, judge: judgeSuiteOutput },
  [WORKER_APP_TYPECHECK.id]: { command: TYPECHECK_COMMAND, judge: judgeTypecheckOutput },
  [WORKER_APP_BUILD.id]: {
    command: (step) => buildCommand(step.deploy?.path),
    judge: judgeBuildOutput,
  },
};

/**
 * The runner for a Tier 2 step, with the time it is given: the plan's own
 * command when the step carries one (whatever its id, so it wins over a
 * pack's runner of the same id), else the pack's runner for its id.
 */
export const tier2RunnerFor = (
  step: PlanStep,
):
  | (Tier2Runner & { readonly command: string; readonly config: SuiteRunnerOptions["config"] })
  | undefined => {
  if (step.run !== undefined)
    return {
      command: projectCommand(step.run),
      judge: judgeCommandOutput,
      config: {
        ...SUITE_CONFIG,
        commandTimeoutMs: step.run.timeoutMs,
        timeout: step.run.timeoutMs + SUITE_CONFIG.timeout - SUITE_CONFIG.commandTimeoutMs,
      },
    };
  const runner = TIER2_RUNNERS[step.id];
  return runner === undefined
    ? undefined
    : {
        ...runner,
        command: typeof runner.command === "string" ? runner.command : runner.command(step),
        config: SUITE_CONFIG,
      };
};

const abstained = (step: PlanStep): StepResult => ({
  stepId: step.id,
  outcome: "abstain",
  evidenceClass: step.evidenceCeiling,
  tier: step.tier,
  durationMs: 0,
});

/**
 * `VerifierRuntime` for Tier 2 steps, over the CI engine's runner. Each step
 * in TIER2_RUNNERS is one runner (a fresh sandbox hydrated from the job's
 * bundle, the namespace's, with the deps bundle its Workflow ensured); its
 * in-band report is parsed and judged by that step's judge, and the
 * judgement's evidence is redacted and stored durably before the result
 * cites it. A step handed no deps bundle asks no runner: it stores why and
 * answers as core's `depsStop` says, a fail for dependencies that were
 * refused and an abstain for ones that are unavailable. A runner the engine
 * gave up on abstains, and so does any step this runtime has no runner for.
 *
 * `literals` are secret values to redact wherever they appear (the account id).
 * `signingKey` signs the URLs each runner is handed, its own bundle's and its
 * deps parts', for a step's life.
 */
export const SuiteRuntimeCi = (deps: {
  readonly runner: SuiteRunner;
  readonly durable: Durable;
  readonly literals: readonly string[];
  readonly signingKey: string;
}) =>
  Layer.effect(
    VerifierRuntime,
    Effect.gen(function* () {
      const evidence = yield* EvidenceStore;
      const runStep =
        (namespace: NamespaceId, bundle: ContentHash, handed: DepsAnswer) => (step: PlanStep) =>
          Effect.gen(function* () {
            const tier2 = tier2RunnerFor(step);
            if (tier2 === undefined || step.tier.tier !== 2) return abstained(step);
            if (handed._tag !== "DepsReady") {
              const stop = depsStop(step, handed);
              const stopRef = yield* deps.durable(
                `${step.id}:evidence`,
                evidence.put(namespace, redactJson({ ...stop.evidence }, deps.literals)),
              );
              return { ...stop.report, resultRef: stopRef } satisfies StepResult;
            }
            const expires =
              Math.floor((yield* Clock.currentTimeMillis) / 1000) + BUNDLE_URL_TTL_SECONDS;
            const url = yield* Effect.promise(() =>
              signedBundleUrl(deps.signingKey, namespace, bundle, expires),
            );
            const parts = yield* Effect.promise(() =>
              Promise.all(
                handed.parts.map((part) =>
                  signedDepsPartUrl(deps.signingKey, namespace, part.sha256, expires),
                ),
              ),
            );
            const stdout = yield* Effect.tryPromise(() =>
              deps.runner({
                name: step.id,
                command: tier2.command,
                env: suiteEnv(url, parts),
                config: tier2.config,
                cloudflareCredentials: false,
                sourceControlCredentials: false,
              }),
            ).pipe(
              // A log over 300 kB arrives as a stream: never a well-formed report, so it reads as malformed.
              Effect.map((r) => (typeof r.logs.stdout === "string" ? r.logs.stdout : "")),
              Effect.catch(() => Effect.succeed(undefined)),
            );
            if (stdout === undefined) return abstained(step);
            const judged = yield* tier2.judge(step, stdout, deps.literals);
            const resultRef = yield* deps.durable(
              `${step.id}:evidence`,
              evidence.put(namespace, judged.document),
            );
            const { failure: _failure, ...result } = judged.report;
            return { ...result, resultRef } satisfies StepResult;
          });
      return VerifierRuntime.of({
        run: (namespace, job, handed) =>
          Effect.forEach(job.steps, runStep(namespace, job.bundle, handed)),
      });
    }),
  );
