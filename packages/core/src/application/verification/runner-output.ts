import type { InfraFailure, StepResult } from "../../domain/verification/index.ts";
import { type CredentialScan, leaked } from "./redact.ts";

/**
 * What every Tier 2 runner protocol shares. A runner's command always exits 0
 * (a non-zero exit would make @cloudflare/ci retry the step in a fresh
 * sandbox), so its outcome travels in-band on stdout: the protocol's name on a
 * line of its own, then one `KEEL_<NAME> <value>` line per marker, each
 * exactly once, then `KEEL_END`. Every protocol opens the same way:
 *
 *   KEEL_HYDRATION ok | failed <reason>     the workspace matched the bundle manifest
 *   KEEL_HYDRATION_RETRIED <reason>          the first extract failed for <reason>; one verified refetch hydrated
 *   KEEL_HYDRATION_DIFF <base64>             after a failed extract only: what differed, and a second fetch
 *   KEEL_DEPS ok | missing <why>             the deps bundle's parts were fetched, checked and untarred
 *
 * Values are base64 on one line, so nothing a project prints can forge a marker.
 */

/** A run that stopped before it ran anything, or whose report cannot be read. Each abstains. */
export type RunnerStop =
  | { readonly _tag: "malformed"; readonly reason: string }
  | {
      readonly _tag: "hydration-failed";
      readonly reason: string;
      /** What the runner found wrong, base64; the doorway decodes it into the evidence. */
      readonly diagnosis?: string;
    }
  /** The step's deps bundle did not reach the workspace whole: a part unfetched, or not the part its URL names. */
  | { readonly _tag: "deps-missing"; readonly reason: string };

/** How a run that went ahead hydrated. */
export interface Hydrated {
  /** Why the first extract failed, when one verified refetch hydrated the workspace instead. */
  readonly rehydrated?: string;
  /** The diagnosis of that first extract, base64. */
  readonly diagnosis?: string;
}

export const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Reads the markers of one in-band report: the `KEEL_<NAME> <value>` lines
 * between the one `protocol` line and the last `KEEL_END`, each marker at
 * most once. Any other line is the box's own printing and is ignored. `noun`
 * names the report in why it is malformed. The deps box's report is read the
 * same way (`deps.ts`).
 */
export const readMarkers = (
  stdout: string,
  protocol: string,
  noun: string,
):
  | { readonly _tag: "malformed"; readonly reason: string }
  | { readonly _tag: "markers"; readonly fields: ReadonlyMap<string, string> } => {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const begin = lines.indexOf(protocol);
  const end = lines.lastIndexOf("KEEL_END");
  if (begin === -1 || end === -1 || end < begin)
    return { _tag: "malformed", reason: `no ${noun} report` };
  const body = lines.slice(begin + 1, end);
  const fields = new Map<string, string>();
  for (const line of body) {
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    if (!key.startsWith("KEEL_")) continue;
    if (fields.has(key) || key === protocol || key === "KEEL_END")
      return { _tag: "malformed", reason: `${key} appears twice` };
    fields.set(key, space === -1 ? "" : line.slice(space + 1));
  }
  if (lines.filter((l) => l === protocol).length !== 1)
    return { _tag: "malformed", reason: `more than one ${noun} report` };
  return { _tag: "markers", fields };
};

/**
 * Reads a runner's stdout up to its own markers: exactly one `protocol` report,
 * each marker once, hydrated and with its deps in place. `noun` names the
 * report in why it is malformed. A run that went ahead comes back `open`, with
 * its markers for the protocol to read.
 */
export const openRunnerOutput = (
  stdout: string,
  protocol: string,
  noun: string,
):
  | RunnerStop
  | {
      readonly _tag: "open";
      readonly fields: ReadonlyMap<string, string>;
      readonly hydrated: Hydrated;
    } => {
  const read = readMarkers(stdout, protocol, noun);
  if (read._tag === "malformed") return read;
  const { fields } = read;
  const hydration = fields.get("KEEL_HYDRATION");
  if (hydration === undefined) return { _tag: "malformed", reason: "no KEEL_HYDRATION" };
  const diagnosis = fields.get("KEEL_HYDRATION_DIFF");
  const diagnosed =
    diagnosis !== undefined && diagnosis.length > 0 && BASE64.test(diagnosis) ? { diagnosis } : {};
  if (hydration !== "ok")
    return {
      _tag: "hydration-failed",
      reason: hydration.startsWith("failed ") ? hydration.slice(7) : hydration,
      ...diagnosed,
    };
  const retried = fields.get("KEEL_HYDRATION_RETRIED");
  const hydrated = retried === undefined ? {} : { rehydrated: retried, ...diagnosed };
  const deps = fields.get("KEEL_DEPS");
  if (deps === undefined) return { _tag: "malformed", reason: "no KEEL_DEPS" };
  if (deps.startsWith("missing "))
    return { _tag: "deps-missing", reason: deps.slice("missing ".length) };
  if (deps !== "ok") return { _tag: "malformed", reason: "bad KEEL_DEPS" };
  return { _tag: "open", fields, hydrated };
};

/** Reads the exit code and duration every run reports, or why they are malformed. */
export const readExit = (
  fields: ReadonlyMap<string, string>,
): { readonly exit: number; readonly durationMs: number } | { readonly malformed: string } => {
  const exit = Number(fields.get("KEEL_EXIT"));
  const durationMs = Number(fields.get("KEEL_DURATION_MS"));
  if (!Number.isInteger(exit) || exit < 0) return { malformed: "bad KEEL_EXIT" };
  if (!Number.isFinite(durationMs) || durationMs < 0) return { malformed: "bad KEEL_DURATION_MS" };
  return { exit, durationMs };
};

/** What every Tier 2 step stores as its evidence, whatever it ran. Redacted before it is stored. */
export interface RunnerEvidence {
  readonly stepId: string;
  readonly outcome: StepResult["outcome"];
  readonly why: string;
  /** The end of the runner's console output, as text. */
  readonly tail: string;
  /** Why the first extract failed, when a verified refetch hydrated the workspace instead. */
  readonly rehydrated?: string;
  /** Why the workspace did not hydrate on its first extract, as the runner diagnosed it. */
  readonly diagnosis?: string;
  /** What a scan of the runner's raw output found, as counts only. */
  readonly credentialScan?: CredentialScan;
}

export interface RunnerJudgement<E extends RunnerEvidence> {
  /** A result the verdict can use, with why it abstained when it did. */
  readonly report: StepResult & { readonly failure?: InfraFailure };
  readonly evidence: E;
}

/** Why a run that stopped before it ran anything abstains. */
export const stopped = (
  stop: RunnerStop,
): { readonly failure: InfraFailure; readonly why: string } => {
  if (stop._tag === "malformed")
    return { failure: "schema", why: `the runner's output is malformed: ${stop.reason}` };
  if (stop._tag === "hydration-failed")
    return { failure: "unavailable", why: `hydration-failed: ${stop.reason}` };
  return { failure: "unavailable", why: `deps-unavailable: ${stop.reason}` };
};

/**
 * Finishes a judgement the same way for every protocol: the hydration facts go
 * into the evidence, then the credential scan of the runner's raw output. Any
 * hit abstains as `credential-leak`, whatever the run did, and the counts are
 * kept in the evidence either way.
 */
export const finishJudgement = <E extends RunnerEvidence>(
  judged: RunnerJudgement<E>,
  hydrated: Hydrated,
  decoded: { readonly diagnosis?: string; readonly credentialScan?: CredentialScan },
): RunnerJudgement<E> => {
  const scan = decoded.credentialScan;
  const evidence: E = {
    ...judged.evidence,
    ...(hydrated.rehydrated === undefined ? {} : { rehydrated: hydrated.rehydrated }),
    ...(decoded.diagnosis === undefined ? {} : { diagnosis: decoded.diagnosis }),
  };
  if (scan === undefined) return { ...judged, evidence };
  if (!leaked(scan)) return { ...judged, evidence: { ...evidence, credentialScan: scan } };
  const { failure: _failure, ...report } = judged.report;
  return {
    report: { ...report, outcome: "abstain", failure: "schema" },
    evidence: {
      ...evidence,
      outcome: "abstain",
      why: `credential-leak: the runner's output held ${scan.token} token-shaped strings, ${scan.expiry} expiries, ${scan.remote} remotes, ${scan.host} hosts and ${scan.literal} known secrets`,
      credentialScan: scan,
    },
  };
};
