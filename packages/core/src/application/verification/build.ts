import { Result } from "effect";
import { checkPinnedName, type WranglerFacts, wranglerFacts } from "../../domain/delivery/index.ts";
import type { ContentHash } from "../../domain/kernel/index.ts";
import type { InfraFailure, PlanStep } from "../../domain/verification/index.ts";
import type { CredentialScan } from "./redact.ts";
import {
  BASE64,
  finishJudgement,
  type Hydrated,
  openRunnerOutput,
  readExit,
  type RunnerEvidence,
  type RunnerJudgement,
  type RunnerStop,
  stopped,
} from "./runner-output.ts";

/**
 * The worker-app build run in Tier 2, as its runner reports it on stdout, per
 * the shared runner protocol (`runner-output.ts`): after the hydration and
 * deps markers, between `KEEL_BUILD/1` and `KEEL_END`:
 *
 *   KEEL_CONFIG <file> <bytes> <base64> | none   the wrangler config at the spec's path, its first BUILD_CONFIG_LIMIT bytes
 *   KEEL_BUNDLER ok | none                       the bundler is among the project's dependencies
 *   KEEL_EXIT <n>                                the build's exit code
 *   KEEL_DURATION_MS <n>
 *   KEEL_TAIL <base64> | none                    the end of the build's console
 *   KEEL_BUNDLE <base64 of gzip> | too-large <bytes> | none   the one module it made
 *
 * `none` for the config or the bundler ends the report there.
 */
export const BUILD_PROTOCOL = "KEEL_BUILD/1";

/** The most of a wrangler config the runner prints: a config longer than this is not read. */
export const BUILD_CONFIG_LIMIT = 16_384;

/**
 * The largest gzipped module the runner prints. Base64'd beside the config and
 * the tail it stays under the engine's 300 kB log limit; a larger Worker waits
 * for the box to upload its build.
 */
export const BUILD_BUNDLE_LIMIT = 163_840;

/** The module a build makes, as Keel uploads it: one ES module, the Worker's entry. */
export const BUILD_MAIN_MODULE = "worker.js";

export type BuildBundle =
  | { readonly _tag: "module"; readonly gzip: string }
  | { readonly _tag: "too-large"; readonly bytes: number }
  | { readonly _tag: "none" };

export type BuildOutput =
  | RunnerStop
  | { readonly _tag: "no-config" }
  | { readonly _tag: "no-bundler" }
  | ({
      readonly _tag: "ran";
      readonly config: {
        readonly file: string;
        readonly bytes: number;
        /** Its first BUILD_CONFIG_LIMIT bytes, base64, still encoded. */
        readonly text: string;
      };
      readonly exit: number;
      readonly durationMs: number;
      /** The build console's end, base64; absent when it printed nothing. */
      readonly tail?: string;
      readonly bundle: BuildBundle;
    } & Hydrated);

const CONFIG_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/** Reads the runner's stdout. Anything but exactly one well-formed run is `malformed`, which abstains. */
export const parseBuildOutput = (stdout: string): BuildOutput => {
  const opened = openRunnerOutput(stdout, BUILD_PROTOCOL, "build");
  if (opened._tag !== "open") return opened;
  const { fields, hydrated } = opened;
  const config = fields.get("KEEL_CONFIG");
  if (config === undefined) return { _tag: "malformed", reason: "no KEEL_CONFIG" };
  if (config === "none") return { _tag: "no-config" };
  const [file = "", bytesText = "", text = "", ...rest] = config.split(" ");
  const bytes = Number(bytesText);
  if (
    !CONFIG_FILES.includes(file) ||
    !Number.isInteger(bytes) ||
    bytes < 0 ||
    !BASE64.test(text) ||
    rest.length > 0
  )
    return { _tag: "malformed", reason: "bad KEEL_CONFIG" };
  const bundler = fields.get("KEEL_BUNDLER");
  if (bundler === "none") return { _tag: "no-bundler" };
  if (bundler !== "ok") return { _tag: "malformed", reason: "no KEEL_BUNDLER" };
  const ran = readExit(fields);
  if ("malformed" in ran) return { _tag: "malformed", reason: ran.malformed };
  const tail = fields.get("KEEL_TAIL");
  if (tail === undefined || (tail !== "none" && (tail.length === 0 || !BASE64.test(tail))))
    return { _tag: "malformed", reason: "bad KEEL_TAIL" };
  const printed = fields.get("KEEL_BUNDLE");
  const tooLarge = /^too-large (\d+)$/.exec(printed ?? "");
  const bundle: BuildBundle | undefined =
    printed === "none"
      ? { _tag: "none" }
      : tooLarge !== null
        ? { _tag: "too-large", bytes: Number(tooLarge[1]) }
        : printed !== undefined && printed.length > 0 && BASE64.test(printed)
          ? { _tag: "module", gzip: printed }
          : undefined;
  if (bundle === undefined) return { _tag: "malformed", reason: "bad KEEL_BUNDLE" };
  return {
    _tag: "ran",
    config: { file, bytes, text },
    ...ran,
    ...(tail === "none" ? {} : { tail }),
    bundle,
    ...hydrated,
  };
};

/**
 * What a build stores. A failure names itself in `deploy`, so a bounce cites
 * it; a pass carries what the preview uploads: the Worker's facts from the
 * candidate's config and its one module, gzipped and base64.
 */
export interface BuildEvidence extends RunnerEvidence {
  readonly deploy?: { readonly failure: string };
  readonly worker?: string;
  readonly facts?: Omit<WranglerFacts, "name" | "main">;
  readonly mainModule?: string;
  readonly bundle?: string;
  readonly bundleBytes?: number;
}

export type BuildJudgement = RunnerJudgement<BuildEvidence>;

/**
 * Judges one build. The candidate's own config and code decide, against the
 * spec its base pinned (`step.deploy`):
 * - `fail`: no wrangler config at the spec's path, a config the change made
 *   incomplete or unreadable, one naming another Worker than the spec pins,
 *   or a bundler that exited non-zero, each cited as a failing deploy check;
 * - `abstain`: what Keel cannot carry yet (a key it does not take, TOML, a
 *   config over BUILD_CONFIG_LIMIT, a module over BUILD_BUNDLE_LIMIT, no
 *   bundler among the dependencies), a step with no spec, an infra failure,
 *   or output that does not agree with itself;
 * - `pass`: a module, with the facts the preview uploads it with.
 *
 * The doorway decodes the config's and the tail's text (`config` undefined
 * when it would not decode); `credentialScan` is its scan of the raw output.
 */
export const judgeBuild = (
  step: PlanStep,
  output: BuildOutput,
  decoded: {
    readonly config: string | undefined;
    readonly tail: string;
    readonly diagnosis?: string;
    readonly credentialScan?: CredentialScan;
  },
  resultRef?: ContentHash,
): BuildJudgement =>
  finishJudgement(
    judgeRun(step, output, decoded, resultRef),
    output._tag === "ran" ? output : {},
    decoded,
  );

const judgeRun = (
  step: PlanStep,
  output: BuildOutput,
  decoded: { readonly config: string | undefined; readonly tail: string },
  resultRef?: ContentHash,
): BuildJudgement => {
  const base = {
    stepId: step.id,
    evidenceClass: step.evidenceCeiling,
    tier: step.tier,
    ...(resultRef === undefined ? {} : { resultRef }),
  };
  const durationMs = output._tag === "ran" ? output.durationMs : 0;
  const tail = decoded.tail;
  const abstain = (failure: InfraFailure, why: string): BuildJudgement => ({
    report: { ...base, outcome: "abstain", failure, durationMs },
    evidence: { stepId: step.id, outcome: "abstain", why, tail },
  });
  const fail = (failure: string): BuildJudgement => ({
    report: { ...base, outcome: "fail", durationMs },
    evidence: { stepId: step.id, outcome: "fail", why: failure, deploy: { failure }, tail },
  });
  const spec = step.deploy;
  if (spec === undefined) return abstain("schema", "the plan step carries no deploy spec");
  const where = spec.path ?? "the repo's root";
  if (output._tag === "no-config") return fail(`no wrangler.jsonc or wrangler.json at ${where}`);
  if (output._tag === "no-bundler")
    return abstain(
      "unavailable",
      "no rolldown among the project's dependencies: Keel bundles a Worker with it",
    );
  if (output._tag !== "ran") {
    const { failure, why } = stopped(output);
    return abstain(failure, why);
  }
  const { file, bytes } = output.config;
  if (bytes > BUILD_CONFIG_LIMIT)
    return abstain(
      "truncated",
      `${file} is ${bytes} bytes, over the ${BUILD_CONFIG_LIMIT} Keel reads`,
    );
  if (decoded.config === undefined) return abstain("schema", `${file} did not decode`);
  const facts = wranglerFacts(file, decoded.config);
  if (Result.isFailure(facts))
    return facts.failure.reason === "uncarried-key" || facts.failure.reason === "toml-not-yet"
      ? abstain("unavailable", facts.failure.detail)
      : fail(facts.failure.detail);
  const pinned = checkPinnedName(spec, facts.success);
  if (Result.isFailure(pinned))
    return fail(
      `${file} names the Worker ${pinned.failure.named}, but the base's deploy spec pins ${pinned.failure.pinned}`,
    );
  if (output.exit !== 0) return fail(`the bundler exited ${output.exit}`);
  if (output.bundle._tag === "too-large")
    return abstain(
      "truncated",
      `the bundle is ${output.bundle.bytes} bytes gzipped, over the ${BUILD_BUNDLE_LIMIT} Keel carries in-band`,
    );
  if (output.bundle._tag === "none")
    return abstain("schema", "the bundler exited 0 and made no module");
  const { name: _name, main: _main, ...uploaded } = facts.success;
  return {
    report: { ...base, outcome: "pass", durationMs },
    evidence: {
      stepId: step.id,
      outcome: "pass",
      why: `built ${spec.worker} from ${facts.success.main}`,
      tail,
      worker: spec.worker,
      facts: uploaded,
      mainModule: BUILD_MAIN_MODULE,
      bundle: output.bundle.gzip,
      bundleBytes: Math.floor((output.bundle.gzip.length * 3) / 4),
    },
  };
};
