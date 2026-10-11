import { describe, expect, it } from "@effect/vitest";
import { PlatformFunction, type PlatformFunctionCall } from "@keeltown/core/ports";
import { Effect } from "effect";
import {
  modelPins,
  PlatformFunctionWorkersAI,
  type StreamingAi,
} from "../../src/adapters/driven/workers-ai/platform-function.ts";

const KIMI = "@cf/moonshotai/kimi-k2.7-code";
const PINS = { "keel.probe.freshness": KIMI };
const SCHEMA = { type: "object", properties: { a: { type: "integer" } }, required: ["a"] };
const CALL: PlatformFunctionCall = {
  name: "keel.probe.freshness",
  input: { prompt: "fill the freshness template" },
  outputSchema: SCHEMA,
};

const enc = new TextEncoder();
/** A server-sent event carrying `content` as an OpenAI-style delta. */
const delta = (content: string, finish?: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, ...(finish === undefined ? {} : { finish_reason: finish }) }] })}\n\n`;

/** A fake AI binding: records each run, and answers with `answer()`. */
function fakeAi(answer: () => Promise<unknown>) {
  const runs: { model: string; inputs: Record<string, unknown> }[] = [];
  const ai: StreamingAi = {
    run: (model, inputs) => {
      runs.push({ model, inputs });
      return answer();
    },
  };
  return { ai, runs };
}

/** A stream of `chunks`, which may split an event anywhere. */
const streamOf = (chunks: readonly string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });

const call = (ai: StreamingAi, c: PlatformFunctionCall = CALL, deadlineMs?: number) =>
  Effect.gen(function* () {
    return yield* (yield* PlatformFunction).call(c);
  }).pipe(Effect.provide(PlatformFunctionWorkersAI(ai, PINS, deadlineMs)));

const reasonOf = (ai: StreamingAi, c?: PlatformFunctionCall, deadlineMs?: number) =>
  Effect.flip(call(ai, c, deadlineMs)).pipe(Effect.map((e) => e.reason));

describe("PlatformFunction over Workers AI", () => {
  it.effect(
    "[pf.streams-json] streams the pinned model under the call's schema, and parses what it says",
    () => {
      const whole = delta('{"a"') + delta(":1}") + "data: [DONE]\n\n";
      const { ai, runs } = fakeAi(async () =>
        streamOf([whole.slice(0, 17), whole.slice(17, 60), whole.slice(60)]),
      );
      return Effect.gen(function* () {
        expect(yield* call(ai)).toEqual({ a: 1 });
        expect(runs).toHaveLength(1);
        expect(runs[0]?.model).toBe(KIMI);
        expect(runs[0]?.inputs).toMatchObject({
          stream: true,
          response_format: { type: "json_schema", json_schema: SCHEMA },
          messages: [{ role: "system" }, { role: "user", content: "fill the freshness template" }],
        });
      });
    },
  );

  it.effect("[pf.streams-json] reads Workers AI's own `response` events too", () => {
    const { ai } = fakeAi(async () =>
      streamOf([
        `data: {"response":"{\\"a\\":"}\n\n`,
        `data: {"response":"2}"}\n\ndata: [DONE]\n\n`,
      ]),
    );
    return Effect.gen(function* () {
      expect(yield* call(ai)).toEqual({ a: 2 });
    });
  });

  it.effect(
    "[pf.unpinned] abstains for a function with no pinned model, without calling any",
    () => {
      const { ai, runs } = fakeAi(async () => streamOf([delta('{"a":1}')]));
      return Effect.gen(function* () {
        expect(yield* reasonOf(ai, { ...CALL, name: "keel.probe.free-form" })).toBe("unavailable");
        expect(runs).toHaveLength(0);
      });
    },
  );

  it.effect(
    "[pf.ai-error] abstains on an AI error: rate-limited for capacity, unavailable otherwise",
    () =>
      Effect.gen(function* () {
        const capacity = fakeAi(() =>
          Promise.reject(new Error("AiError: 3040: Capacity temporarily exceeded")),
        );
        expect(yield* reasonOf(capacity.ai)).toBe("rate-limited");
        const other = fakeAi(() => Promise.reject(new Error("AiError: 5007: No such model")));
        expect(yield* reasonOf(other.ai)).toBe("unavailable");
      }),
  );

  it.effect("[pf.unparseable] abstains as schema on text that is not JSON", () => {
    const { ai } = fakeAi(async () =>
      streamOf([delta("Sure! Here is the JSON:"), "data: [DONE]\n\n"]),
    );
    return Effect.gen(function* () {
      expect(yield* reasonOf(ai)).toBe("schema");
    });
  });

  it.effect(
    "[pf.truncated] abstains as truncated when the model stopped at its token limit",
    () => {
      const { ai } = fakeAi(async () => streamOf([delta('{"a":1}', "length")]));
      return Effect.gen(function* () {
        expect(yield* reasonOf(ai)).toBe("truncated");
      });
    },
  );

  // Live: the deadline is wall-clock time, which it.effect's TestClock would hold still.
  it.live("[pf.deadline] abstains as timeout at the deadline, and cancels the stream", () => {
    let cancelled = false;
    const { ai } = fakeAi(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(delta('{"a"')));
          },
          cancel() {
            cancelled = true;
          },
        }),
    );
    return Effect.gen(function* () {
      expect(yield* reasonOf(ai, CALL, 50)).toBe("timeout");
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(cancelled).toBe(true);
    });
  });

  it("[pf.pins] reads exact model ids from config, and refuses an auto or malformed pin", () => {
    expect(modelPins({ "keel.probe.freshness": KIMI })).toEqual(PINS);
    expect(() => modelPins({ "keel.probe.freshness": "cloudflare/auto" })).toThrow(
      /exact @cf\/ model id/,
    );
    expect(() => modelPins({ "keel.probe.freshness": 7 })).toThrow(/exact @cf\/ model id/);
    expect(() => modelPins(["@cf/a/b"])).toThrow(/not an object/);
  });
});
