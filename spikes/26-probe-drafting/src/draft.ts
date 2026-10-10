// draftProbe as a PlatformFunction: one env.AI.run call against a pinned model
// with a JSON-schema response format. Output that does not parse or does not
// match the schema abstains; it is never repaired by guessing.
import { clock } from "./clock.ts";
import { OUTPUT_SCHEMA } from "./prompt.ts";
import { renderFreshness, TEMPLATE_SCHEMA, validateSlots, type FreshnessSlots } from "./template.ts";

export type DraftMode = "probe" | "template";

export interface ModelSettings {
  /** Exact Workers AI catalogue id. Never an alias or a gateway route. */
  model: string;
  temperature: number;
  maxTokens: number;
  /** "openai" for chat-completions style models, "legacy" for the older {response} shape. */
  api: "openai" | "legacy";
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface DraftCall {
  ms: number;
  /** The text the model returned as its answer (not its reasoning). */
  content: string;
  usage: Usage;
  finishReason?: string;
  reasoningChars?: number;
  modelReported?: string;
  infraRetries: number;
  draft?: { probe: string; rationale: string; slots?: FreshnessSlots };
  /** Set when the call abstained: the deterministic reason. */
  abstained?: string;
  /** Set when the platform call itself failed after retries. */
  infraError?: string;
}

const CALL_TIMEOUT_MS = 300_000;

function validate(value: unknown): { probe: string; rationale: string } | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "the reply is not a JSON object";
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => k !== "files" && k !== "rationale");
  if (extra.length) return `unexpected top-level keys: ${extra.join(", ")}`;
  if (typeof v.rationale !== "string") return "rationale must be a string";
  const files = v.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return "files must be an object";
  const f = files as Record<string, unknown>;
  const extraFiles = Object.keys(f).filter((k) => k !== "probe.test.ts");
  if (extraFiles.length) return `unexpected files: ${extraFiles.join(", ")}`;
  if (typeof f["probe.test.ts"] !== "string" || f["probe.test.ts"].trim() === "") return 'files["probe.test.ts"] must be a non-empty string';
  return { probe: f["probe.test.ts"], rationale: v.rationale };
}

interface RawOutput {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: string }>;
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  model?: string;
}

function inputFor(s: ModelSettings, messages: Message[], mode: DraftMode): Record<string, unknown> {
  const schema = mode === "template" ? TEMPLATE_SCHEMA : OUTPUT_SCHEMA;
  if (s.api === "legacy") {
    return {
      messages,
      response_format: { type: "json_schema", json_schema: schema },
      temperature: s.temperature,
      max_tokens: s.maxTokens,
    };
  }
  return {
    messages,
    response_format: { type: "json_schema", json_schema: { name: mode === "template" ? "freshness_slots" : "probe_draft", schema, strict: true } },
    temperature: s.temperature,
    max_completion_tokens: s.maxTokens,
  };
}

async function runOnce(ai: Ai, s: ModelSettings, messages: Message[], mode: DraftMode): Promise<RawOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS);
  });
  try {
    // oxlint-disable-next-line typescript/no-explicit-any -- catalogue ids newer than the bundled type list
    return (await Promise.race([(ai as any).run(s.model, inputFor(s, messages, mode)), timeout])) as RawOutput;
  } finally {
    clearTimeout(timer);
  }
}

/** One schema-constrained call. Platform failures are retried (not counted as attempts); bad output abstains. */
export async function draftProbe(ai: Ai, s: ModelSettings, messages: Message[], mode: DraftMode = "probe"): Promise<DraftCall> {
  const t0 = await clock();
  let raw: RawOutput | undefined;
  let infraRetries = 0;
  let lastError = "";
  for (let i = 0; i < 3 && raw === undefined; i++) {
    try {
      raw = await runOnce(ai, s, messages, mode);
    } catch (e) {
      lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      infraRetries = i + 1;
      if (i < 2) await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  const ms = (await clock()) - t0;
  if (raw === undefined) {
    return { ms, content: "", usage: { promptTokens: 0, completionTokens: 0 }, infraRetries, infraError: lastError };
  }
  const usage: Usage = {
    promptTokens: raw.usage?.prompt_tokens ?? 0,
    completionTokens: raw.usage?.completion_tokens ?? 0,
    ...(raw.usage?.prompt_tokens_details?.cached_tokens ? { cachedTokens: raw.usage.prompt_tokens_details.cached_tokens } : {}),
  };
  const choice = raw.choices?.[0];
  const answer: unknown = choice ? choice.message?.content : raw.response;
  const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  const base: DraftCall = {
    ms,
    content: typeof answer === "string" ? answer : JSON.stringify(answer ?? null),
    usage,
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    ...(typeof reasoning === "string" ? { reasoningChars: reasoning.length } : {}),
    ...(raw.model ? { modelReported: raw.model } : {}),
    infraRetries,
  };
  let parsed: unknown = answer;
  if (typeof answer === "string") {
    try {
      parsed = JSON.parse(answer);
    } catch (e) {
      return { ...base, abstained: `the reply is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (mode === "template") {
    const slots = validateSlots(parsed);
    if (typeof slots === "string") return { ...base, abstained: `the reply does not match the output schema: ${slots}` };
    return { ...base, draft: { probe: renderFreshness(slots), rationale: slots.rationale, slots } };
  }
  const v = validate(parsed);
  if (typeof v === "string") return { ...base, abstained: `the reply does not match the output schema: ${v}` };
  return { ...base, draft: v };
}
