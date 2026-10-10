// Host-side reading of one probe run against the exit-code contract:
// 0 pass, 1 fail, 3 n/a, 2 harness error, and exactly one JSON line
// {"outcome":"pass"|"fail"|"n/a","reason":"..."} after the observations.

export type Outcome = "pass" | "fail" | "n/a";

export interface RunResult {
  /** 0, 1, 2 or 3. Anything the host cannot read is 2. */
  exit: 0 | 1 | 2 | 3;
  outcome: Outcome;
  reason: string;
  /** Set when exit is 2: the deterministic text a repair attempt is given. */
  harnessError?: string;
  observations: string[];
}

const EXIT_OF: Record<Outcome, 0 | 1 | 3> = { pass: 0, fail: 1, "n/a": 3 };
const OUTCOMES = new Set<string>(["pass", "fail", "n/a"]);

export function harness(text: string, observations: string[] = []): RunResult {
  return { exit: 2, outcome: "fail", reason: `probe harness error: ${text}`, harnessError: text, observations };
}

/** Lines that a JSON reader would take for an outcome line: anything that parses as a JSON object. */
function jsonObjectLines(lines: string[]): number[] {
  const at: number[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t.startsWith("{")) return;
    try {
      const v: unknown = JSON.parse(t);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) at.push(i);
    } catch {
      // not JSON: an ordinary observation
    }
  });
  return at;
}

/**
 * Reads the runner's stdout and exit code. The JSON line must be the last line,
 * be the only JSON object line, carry exactly `outcome` and `reason`, and agree
 * with the exit code. A runner-reported harness error (exit 2) keeps its text.
 */
export function readRun(stdout: string | undefined, exit: number | undefined): RunResult {
  if (stdout === undefined) return harness("missing JSON line: the runner returned no output");
  const lines = stdout.replace(/\n$/, "").split("\n");
  const observations = lines.slice(0, -1);
  const json = jsonObjectLines(lines);
  if (json.length === 0) return harness(`missing JSON line: no {"outcome","reason"} line in output: ${stdout.slice(0, 300)}`, observations);
  if (json.length > 1) {
    return harness(
      `invalid JSON line: expected exactly one JSON line, found ${json.length}: ${json.map((i) => lines[i]).join(" | ").slice(0, 400)}`,
      observations,
    );
  }
  if (json[0] !== lines.length - 1) return harness(`invalid JSON line: the JSON line is not the last line: ${lines[json[0]!]}`, observations);
  const parsed = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  const keys = Object.keys(parsed).toSorted().join(",");
  if (keys !== "outcome,reason" || !OUTCOMES.has(String(parsed.outcome)) || typeof parsed.reason !== "string") {
    return harness(`invalid JSON line: ${lines.at(-1)}`, observations);
  }
  const outcome = parsed.outcome as Outcome;
  const reason = parsed.reason as string;
  if (exit === 2) {
    if (outcome !== "fail" || !reason.startsWith("probe harness error: ")) return harness(`invalid JSON line: exit 2 with ${lines.at(-1)}`, observations);
    return { exit: 2, outcome, reason, harnessError: reason.slice("probe harness error: ".length), observations };
  }
  if (exit !== EXIT_OF[outcome]) return harness(`invalid JSON line: exit ${String(exit)} does not match outcome ${outcome}`, observations);
  return { exit: EXIT_OF[outcome], outcome, reason, observations };
}
