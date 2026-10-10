// The probe-drafting loop: one draftProbe call, then at most three repair
// attempts, each driven only by deterministic error text (bundle errors,
// harness errors, a missing or invalid JSON line, or an abstention's schema
// error). A wrong outcome in some world is evidence, not an error, and is
// never fed back.
import { admit, MATRIX, RUNS, vacuity, type Admission, type Vacuity, type WorldEvaluation } from "./admission.ts";
import { draftProbe, type DraftCall, type DraftMode, type Message, type ModelSettings } from "./draft.ts";
import type { FreshnessSlots } from "./template.ts";
import { repairPrompt, SYSTEM, userPrompt, type DraftInput } from "./prompt.ts";

export const MAX_REPAIRS = 3;

export interface Evaluation {
  evals: WorldEvaluation[];
  bundleMs: Record<string, number>;
  bytes?: number;
  wallMs: number;
}

export type Evaluate = (probe: string, worlds: string[], runs: number) => Promise<Evaluation>;

export interface Attempt {
  n: number;
  call: Omit<DraftCall, "draft">;
  probe?: string;
  rationale?: string;
  slots?: FreshnessSlots;
  cells?: Admission["cells"];
  /** The deterministic text fed into the next attempt, if any. */
  errors?: string;
  evalMs?: number;
}

export interface DraftJob {
  model: string;
  mode: DraftMode;
  settings: ModelSettings;
  startedAt: string;
  promptChars: number;
  attempts: Attempt[];
  attemptsUsed: number;
  final?: {
    probe: string;
    rationale: string;
    admission: Admission;
    mutant: WorldEvaluation;
    vacuity: Vacuity;
  };
  outcome: "admitted" | "rejected" | "abstained" | "infra-error";
  totals: { modelMs: number; evalMs: number; promptTokens: number; completionTokens: number; wallMs: number };
}

/** Deterministic error text from an evaluation, deduplicated and without world names. */
export function deterministicErrors(evals: readonly WorldEvaluation[]): string | undefined {
  const texts = new Set<string>();
  for (const e of evals) {
    if (e.bundleError !== undefined) texts.add(`bundling probe/probe.test.ts failed:\n${e.bundleError}`);
    for (const r of e.runs) if (r.exit === 2) texts.add(JSON.stringify({ outcome: r.outcome, reason: r.reason }));
  }
  return texts.size ? [...texts].join("\n\n") : undefined;
}

export async function draftLoop(
  ai: Ai,
  settings: ModelSettings,
  input: DraftInput,
  evaluate: Evaluate,
  progress: (o: unknown) => void,
  maxRepairs = MAX_REPAIRS,
  mode: DraftMode = "probe",
): Promise<DraftJob> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const user = userPrompt(input, mode);
  const messages: Message[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
  const attempts: Attempt[] = [];
  const totals = { modelMs: 0, evalMs: 0, promptTokens: 0, completionTokens: 0, wallMs: 0 };
  let last: { probe: string; rationale: string; evals: WorldEvaluation[] } | undefined;
  let infraError = false;

  for (let n = 1; n <= 1 + maxRepairs; n++) {
    const call = await draftProbe(ai, settings, messages, mode);
    totals.modelMs += call.ms;
    totals.promptTokens += call.usage.promptTokens;
    totals.completionTokens += call.usage.completionTokens;
    const { draft, ...callRecord } = call;
    const attempt: Attempt = { n, call: callRecord };
    attempts.push(attempt);
    progress({ attempt: n, ms: call.ms, abstained: call.abstained, infraError: call.infraError });

    if (call.infraError !== undefined) {
      infraError = true;
      break;
    }
    let errors: string | undefined;
    if (draft === undefined) {
      errors = call.abstained;
    } else {
      attempt.probe = draft.probe;
      attempt.rationale = draft.rationale;
      if (draft.slots) attempt.slots = draft.slots;
      const ev = await evaluate(draft.probe, [...MATRIX], RUNS);
      totals.evalMs += ev.wallMs;
      attempt.evalMs = ev.wallMs;
      attempt.cells = admit(ev.evals).cells;
      last = { probe: draft.probe, rationale: draft.rationale, evals: ev.evals };
      errors = deterministicErrors(ev.evals);
      progress({ attempt: n, cells: attempt.cells, errors: errors?.slice(0, 200) });
    }
    if (errors === undefined) break;
    attempt.errors = errors;
    if (n > maxRepairs) break;
    messages.push({ role: "assistant", content: call.content }, { role: "user", content: repairPrompt(errors, mode) });
  }

  let final: DraftJob["final"];
  if (last !== undefined) {
    const admission = admit(last.evals);
    const ev = await evaluate(last.probe, ["mutantA"], RUNS);
    totals.evalMs += ev.wallMs;
    const mutant = ev.evals[0]!;
    final = { probe: last.probe, rationale: last.rationale, admission, mutant, vacuity: vacuity(mutant) };
  }
  totals.wallMs = Date.now() - t0;
  const outcome: DraftJob["outcome"] = final?.admission.admitted
    ? "admitted"
    : final !== undefined
      ? "rejected"
      : infraError
        ? "infra-error"
        : "abstained";
  return {
    model: settings.model,
    mode,
    settings,
    startedAt,
    promptChars: SYSTEM.length + user.length,
    attempts,
    attemptsUsed: attempts.length,
    ...(final ? { final } : {}),
    outcome,
    totals,
  };
}
