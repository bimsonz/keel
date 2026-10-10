// Pre-call token estimator for Clef requests.
//
// It rebuilds the prompt text the way the published reference encoder does
// (system prompt, STATE, rendered state, SCHEMA FIELDS, options) and divides
// its UTF-8 byte length by a bytes-per-token floor. The tokenizer is
// byte-level BPE, so every token covers at least one byte: with floor 1 the
// estimate is a hard upper bound. A calibrated floor (measured against
// usage.input_tokens) is tighter but only an empirical bound.

// Effective caps measured in S17: usage.input_tokens never exceeds these and
// the state is cut to fit. The model pages list 65,536 and 24,576; the
// difference appears to be reserved output tokens.
export const CONTEXT_LIMIT = { clef: 64_000, "clef-flash": 24_000 } as const;
export type ClefModel = keyof typeof CONTEXT_LIMIT;

/** Hard bound: one byte per token at minimum. */
export const GUARANTEED_BYTES_PER_TOKEN = 1;
/**
 * Calibrated floor. Measured minimum: 3.26 bytes/token over the 40 dataset
 * requests and 2.95 for the synthetic filler (results/truncation.json); 2.5
 * leaves a margin below both. Empirical, not a proof: dense non-ASCII or
 * random content can tokenise tighter.
 */
export const CALIBRATED_BYTES_PER_TOKEN = 2.5;

const SYSTEM_PROMPT =
  "Read the complete state and schema. Decide every field jointly. Each answer must be exactly one of that field's allowed options.";

/** JSON with sorted keys and compact separators, matching the reference render(). */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .toSorted()
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonical(obj[k]))
      .join(",") +
    "}"
  );
}

export function render(value: unknown): string {
  return typeof value === "string" ? value : canonical(value);
}

interface Question {
  type: "noul" | "choice" | "score";
  instructions: unknown;
  criteria?: Record<string, unknown> | unknown[];
}

export function promptText(input: { state: unknown; questions: Record<string, Question> }): string {
  const parts = [`<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\nSTATE:\n`, render(input.state), "\n\nSCHEMA FIELDS:\n"];
  Object.entries(input.questions).forEach(([id, q], i) => {
    parts.push(`\nFIELD ${i + 1}\nID: ${id}\nTYPE: ${q.type}\nINSTRUCTION: `, render(q.instructions ?? id), "\nALLOWED OPTIONS:\n");
    const options: [string, unknown][] =
      q.type === "noul"
        ? [["true", "The proposition is true or the answer is yes."], ["false", "The proposition is false or the answer is no."]]
        : q.type === "choice"
          ? Object.entries(q.criteria as Record<string, unknown>).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          : (q.criteria as unknown[]).map((c, j) => [String(j), c]);
    options.forEach(([optionId, description], j) => {
      parts.push(`OPTION ${j + 1}: `, render(description == null ? { option_id: optionId } : { option_id: optionId, description }), "\n");
    });
    parts.push("END FIELD\n");
  });
  parts.push("\n<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\nJOINT SCHEMA DECISIONS:");
  return parts.join("");
}

export function promptBytes(input: Parameters<typeof promptText>[0]): number {
  return new TextEncoder().encode(promptText(input)).length;
}

export interface Estimate {
  bytes: number;
  estimatedTokens: number;
  limit: number;
  oversize: boolean;
}

/** Oversize means the estimate reaches the limit: an exact fill is indistinguishable from truncation afterwards. */
export function estimate(
  input: Parameters<typeof promptText>[0],
  model: ClefModel,
  bytesPerToken: number = CALIBRATED_BYTES_PER_TOKEN,
): Estimate {
  const bytes = promptBytes(input);
  const estimatedTokens = Math.ceil(bytes / bytesPerToken);
  const limit = CONTEXT_LIMIT[model];
  return { bytes, estimatedTokens, limit, oversize: estimatedTokens >= limit };
}

/** Post-call check: the service reports input_tokens after truncation, which then equals the limit. */
export function truncatedAfterCall(usage: { input_tokens: number }, model: ClefModel): boolean {
  return usage.input_tokens >= CONTEXT_LIMIT[model];
}
