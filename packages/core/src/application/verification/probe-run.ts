import type { ProbeOutcome } from "../../domain/verification/index.ts";

/**
 * One probe run as its runner reports it. The runner prints the probe's
 * observations, then exactly one JSON line `{"outcome","reason"}`, and exits
 * by the outcome:
 *
 *   0 pass    1 fail    3 n/a    2 harness error (outcome "fail", reason "probe harness error: …")
 *
 * A harness error is never a cell of the world matrix: it says the probe or
 * its harness is broken, not what the world does. n/a is never a pass.
 */
export type ProbeRun =
  | {
      readonly _tag: "ran";
      readonly outcome: ProbeOutcome;
      readonly reason: string;
      readonly observations: readonly string[];
    }
  | {
      readonly _tag: "harness-error";
      /** Deterministic text, the only thing a repair attempt is given. */
      readonly reason: string;
      readonly observations: readonly string[];
    };

/** The exit code each outcome must come with. */
export const PROBE_EXIT: Readonly<Record<ProbeOutcome, number>> = { pass: 0, fail: 1, "n/a": 3 };
export const PROBE_HARNESS_EXIT = 2;
const HARNESS_PREFIX = "probe harness error: ";

const harness = (reason: string, observations: readonly string[] = []): ProbeRun => ({
  _tag: "harness-error",
  reason,
  observations,
});

const isOutcome = (value: unknown): value is ProbeOutcome =>
  value === "pass" || value === "fail" || value === "n/a";

/** A line a JSON reader would take for an outcome line: anything that parses as a JSON object. */
const isJsonObject = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
};

/**
 * Reads a probe runner's stdout and exit code. The JSON line must be the only
 * line that parses as a JSON object and the last line, carry exactly
 * `outcome` and `reason`, and agree with the exit code; anything else is a
 * harness error, with why. A harness error the runner reported itself (exit
 * 2) keeps its text.
 */
export const readProbeRun = (stdout: string | undefined, exit: number | undefined): ProbeRun => {
  if (stdout === undefined) return harness("missing JSON line: the runner returned no output");
  const lines = stdout.replace(/\n$/, "").split("\n");
  const observations = lines.slice(0, -1);
  const json = lines.flatMap((line, i) => (isJsonObject(line) ? [i] : []));
  if (json.length === 0)
    return harness(
      `missing JSON line: no {"outcome","reason"} line in the output: ${stdout.slice(0, 300)}`,
      observations,
    );
  if (json.length > 1)
    return harness(
      `invalid JSON line: expected exactly one JSON line, found ${json.length}`,
      observations,
    );
  const last = lines.at(-1) ?? "";
  if (json[0] !== lines.length - 1)
    return harness(
      `invalid JSON line: the JSON line is not the last line: ${lines[json[0] ?? 0]}`,
      observations,
    );
  const parsed: unknown = JSON.parse(last);
  const outcome: unknown = Reflect.get(Object(parsed), "outcome");
  const reason: unknown = Reflect.get(Object(parsed), "reason");
  if (
    Object.keys(Object(parsed)).toSorted().join(",") !== "outcome,reason" ||
    !isOutcome(outcome) ||
    typeof reason !== "string"
  )
    return harness(`invalid JSON line: ${last.slice(0, 300)}`, observations);
  if (exit === PROBE_HARNESS_EXIT)
    return outcome === "fail" && reason.startsWith(HARNESS_PREFIX)
      ? harness(reason.slice(HARNESS_PREFIX.length), observations)
      : harness(`invalid JSON line: exit 2 with ${last.slice(0, 300)}`, observations);
  if (exit !== PROBE_EXIT[outcome])
    return harness(
      `invalid JSON line: exit ${String(exit)} does not match outcome ${outcome}`,
      observations,
    );
  return { _tag: "ran", outcome, reason, observations };
};
