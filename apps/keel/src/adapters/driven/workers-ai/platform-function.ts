import { ModelAbstained } from "@keeltown/core/domain/verification";
import { PlatformFunction, type PlatformFunctionCall } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";

/** What the adapter needs of the AI binding: one model run, which it asks to stream. */
export interface StreamingAi {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Each platform function's model, by exact id: never `cloudflare/auto`. */
export type ModelPins = Readonly<Record<string, string>>;

/**
 * The pins from config (`PLATFORM_FUNCTION_PINS`, which wrangler types only
 * as an object): every value an exact `@cf/…` model id. Anything else stops
 * the composition, rather than letting a function run on a model nobody chose.
 */
export const modelPins = (raw: unknown): ModelPins => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("PLATFORM_FUNCTION_PINS is not an object of function → model id");
  const pins: Record<string, string> = {};
  for (const [fn, model] of Object.entries(raw)) {
    if (typeof model !== "string" || !/^@cf\/[\w.-]+\/[\w.-]+$/.test(model))
      throw new Error(
        `PLATFORM_FUNCTION_PINS.${fn} is not an exact @cf/ model id: ${String(model)}`,
      );
    pins[fn] = model;
  }
  return pins;
};

/**
 * The most tokens a call may spend. A slot reply is a few hundred tokens, but
 * the model's output can run far past it: 1 of 10 S-1 drafts was cut at 4096,
 * so the 90th percentile sat at that cap. The deadline still bounds the time.
 */
export const MAX_TOKENS = 8192;

/** How long one call may take, from the request to the stream's last event, before it abstains as a timeout. */
export const PLATFORM_FUNCTION_DEADLINE_MS = 240_000;

const SYSTEM =
  "Reply with exactly one JSON object that satisfies the response schema, and nothing else.";

type Reason = ModelAbstained["reason"];
const abstain = (reason: Reason, detail?: string) =>
  new ModelAbstained(detail === undefined ? { reason } : { reason, detail });

/** A capacity or rate limit answers rate-limited; any other AI failure, unavailable. */
const reasonOf = (error: unknown): Reason =>
  /\b(3040|429)\b|capacity|rate limit/i.test(String(error)) ? "rate-limited" : "unavailable";

/** The text of one streamed event: an OpenAI-style delta, or Workers AI's `response`. */
const pieceOf = (event: unknown): { readonly text: string; readonly finish?: unknown } => {
  const choice: unknown = Reflect.get(Object(Reflect.get(Object(event), "choices")), 0);
  const delta: unknown = Reflect.get(Object(Reflect.get(Object(choice), "delta")), "content");
  const response: unknown = Reflect.get(Object(event), "response");
  return {
    text: typeof delta === "string" ? delta : typeof response === "string" ? response : "",
    finish: Reflect.get(Object(choice), "finish_reason"),
  };
};

/**
 * Reads a server-sent event stream to its end: the concatenated text, and
 * whether the model stopped at its token limit. Events may split anywhere.
 */
async function readStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  signal.addEventListener("abort", () => void reader.cancel(), { once: true });
  let buffered = "";
  let text = "";
  let truncated = false;
  const take = (line: string) => {
    const data = line.trim();
    if (!data.startsWith("data:")) return;
    const body = data.slice("data:".length).trim();
    if (body === "" || body === "[DONE]") return;
    const piece = pieceOf(JSON.parse(body));
    text += piece.text;
    if (piece.finish === "length") truncated = true;
  };
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
    const { done, value } = await reader.read();
    if (done) break;
    buffered += value;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      take(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  take(buffered);
  return { text, truncated };
}

/** One call: the pinned model, streamed with the call's JSON schema, read to its end and parsed. */
async function complete(
  ai: StreamingAi,
  model: string,
  call: PlatformFunctionCall,
  signal: AbortSignal,
): Promise<unknown> {
  const prompt = call.input["prompt"];
  if (typeof prompt !== "string")
    throw new Error(`platform function ${call.name} was called without a prompt`);
  let answer: unknown;
  try {
    answer = await ai.run(model, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_schema", json_schema: call.outputSchema },
      max_tokens: MAX_TOKENS,
      stream: true,
    });
  } catch (error) {
    throw abstain(reasonOf(error));
  }
  if (!(answer instanceof ReadableStream)) throw abstain("unavailable");
  let read: { readonly text: string; readonly truncated: boolean };
  try {
    read = await readStream(answer, signal);
  } catch (error) {
    throw error instanceof SyntaxError
      ? abstain("schema", `a streamed event: ${error.message}`)
      : abstain(reasonOf(error));
  }
  if (read.truncated) throw abstain("truncated", String(MAX_TOKENS));
  try {
    return JSON.parse(read.text);
  } catch (error) {
    throw abstain("schema", error instanceof Error ? error.message : String(error));
  }
}

/**
 * PlatformFunction over Workers AI (ADR 0001: one call, no loop, no tools).
 * Each function runs on the model its pin names, single-shot and streamed,
 * which keeps clear of the synchronous call's timeout (about 235 s, AiError
 * 3046) for models that cannot queue (Kimi K2.7 Code answers AiError 8007).
 * The reply is constrained by the call's JSON schema and parsed; the caller
 * checks it against its own rules. An unpinned function, an AI error, a
 * stream cut at the token limit, unparseable text or the deadline all
 * abstain, so a caller never mistakes no answer for one.
 */
export const PlatformFunctionWorkersAI = (
  ai: StreamingAi,
  pins: ModelPins,
  deadlineMs: number = PLATFORM_FUNCTION_DEADLINE_MS,
) =>
  Layer.succeed(
    PlatformFunction,
    PlatformFunction.of({
      call: (call) => {
        const model = pins[call.name];
        if (model === undefined) return Effect.fail(abstain("unavailable"));
        return Effect.tryPromise({
          try: (signal) => complete(ai, model, call, signal),
          catch: (error) => error,
        }).pipe(
          Effect.timeoutOrElse({
            duration: deadlineMs,
            orElse: () => Effect.fail(abstain("timeout")),
          }),
          Effect.catch((error) =>
            error instanceof ModelAbstained ? Effect.fail(error) : Effect.die(error),
          ),
        );
      },
    }),
  );
