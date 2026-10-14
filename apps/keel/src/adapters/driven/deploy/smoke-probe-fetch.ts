import type { SmokeAnswer } from "@keeltown/core/domain/delivery";
import { SmokeProbe } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import type { Fetcher } from "./cloudflare-api.ts";

/** How long one smoke request's answer is waited for. */
export const SMOKE_ANSWER_MS = 10_000;
/** How much of an answer's body a smoke check reads: its text is looked for only in this. */
export const SMOKE_BODY_BYTES = 64 * 1024;

/** The first `limit` bytes of a body, as text; the rest is never read. */
async function bodyOf(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  try {
    while (read < limit) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const taken = chunk.value.subarray(0, limit - read);
      read += taken.byteLength;
      text += decoder.decode(taken, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

/**
 * `SmokeProbe` over `fetch`: a GET of the address, with no redirect followed
 * (a 3xx is the answer), given up after `SMOKE_ANSWER_MS`, and the body read
 * only to `SMOKE_BODY_BYTES`. A request that throws or times out is no answer,
 * with its message.
 */
export function SmokeProbeFetch(
  options: { readonly fetch?: Fetcher } = {},
): Layer.Layer<SmokeProbe> {
  const send: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  return Layer.succeed(
    SmokeProbe,
    SmokeProbe.of({
      ask: (url) =>
        Effect.promise(async (): Promise<SmokeAnswer> => {
          try {
            const response = await send(url, {
              method: "GET",
              redirect: "manual",
              signal: AbortSignal.timeout(SMOKE_ANSWER_MS),
            });
            return {
              _tag: "answered",
              status: response.status,
              body: await bodyOf(response, SMOKE_BODY_BYTES),
            };
          } catch (cause) {
            return {
              _tag: "no-answer",
              error: cause instanceof Error ? cause.message : String(cause),
            };
          }
        }),
    }),
  );
}
