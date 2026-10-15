// A change as a code host shows a pull request: open, landed or closed, and its checks, each step of the plan
// its verdict was issued under with how that step went. Read from what Keel says of the change and its verdict.

import type { ChangeState } from "../contract/keel/index.ts";
import type { VerdictOutcome } from "../contract/mfp.ts";

/** The three states a code host gives a pull request. */
export type Pill = "open" | "landed" | "closed";

/** A change is open until it lands, or its agent withdraws it, or another change supersedes it. */
export function pillOf(state: ChangeState): Pill {
  if (state === "landed") return "landed";
  if (state === "withdrawn" || state === "superseded") return "closed";
  return "open";
}

/** How one step went, in Keel's words for it. */
export type StepResult = "pass" | "fail" | "escalate" | "annotate" | "abstain";

const RESULTS: readonly StepResult[] = ["pass", "fail", "escalate", "annotate", "abstain"];

/**
 * How a step went, read from the verdict's evidence that names it. Keel writes one line per step's result as
 * `<step>: <outcome> (<class>, tier <n>: <why>)`, then any lines about it besides. Undefined where no line says.
 */
export function stepResultOf(id: string, lines: readonly string[]): StepResult | undefined {
  const head = `${id}: `;
  for (const line of lines) {
    if (!line.startsWith(head)) continue;
    const [word] = line.slice(head.length).split(" ");
    const result = RESULTS.find((known) => known === word);
    if (result !== undefined) return result;
  }
  return undefined;
}

/** Where a change's checks stand, as the box above a pull request's merge button says it. */
export type ChecksState = "passed" | "failed" | "held" | "running" | "queued" | "none";

export interface Checks {
  state: ChecksState;
  /** The steps of the plan the verdict was issued under, in Keel's order. None until Keel issues one. */
  steps: { id: string; result?: StepResult }[];
}

/** The states in which a change's batch is being verified, or its candidate is going onto trunk. */
const RUNNING: ReadonlySet<ChangeState> = new Set(["verifying", "integrating"]);
/** The states in which a change has pushed and waits for Keel to verify it. */
const QUEUED: ReadonlySet<ChangeState> = new Set(["submitted", "deriving", "drifted", "queued"]);

export function checksOf(
  change: { state: ChangeState },
  verdict?: { outcome: VerdictOutcome; plan?: { steps: { id: string; lines: string[] }[] } },
): Checks {
  const steps = (verdict?.plan?.steps ?? []).map((step) => {
    const result = stepResultOf(step.id, step.lines);
    return result === undefined ? { id: step.id } : { id: step.id, result };
  });
  if (verdict === undefined)
    return {
      state: RUNNING.has(change.state) ? "running" : QUEUED.has(change.state) ? "queued" : "none",
      steps,
    };
  if (steps.some((step) => step.result === "fail") || verdict.outcome === "bounce")
    return { state: "failed", steps };
  if (verdict.outcome === "land") return { state: "passed", steps };
  return { state: "held", steps };
}
