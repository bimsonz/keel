import { describe, expect, it } from "@effect/vitest";
import { SmokeProbe } from "@keeltown/core/ports";
import { Effect } from "effect";
import {
  SMOKE_ANSWER_MS,
  SMOKE_BODY_BYTES,
  SmokeProbeFetch,
} from "../../src/adapters/driven/deploy/smoke-probe-fetch.ts";

const ask = (url: string, fetch: (url: string, init: RequestInit) => Promise<Response>) =>
  Effect.flatMap(SmokeProbe, (probe) => probe.ask(url)).pipe(
    Effect.provide(SmokeProbeFetch({ fetch })),
  );

describe("SmokeProbeFetch", () => {
  it.effect(
    "[smoke-probe.asks-once] a GET that follows no redirect and gives up in ten seconds, answered with its status and body",
    () =>
      Effect.gen(function* () {
        const asked: { url: string; init: RequestInit }[] = [];
        const answer = yield* ask("https://abc-worker.owner.workers.dev/health", async (url, init) => {
          asked.push({ url, init });
          return new Response("ok", { status: 302, headers: { location: "https://elsewhere" } });
        });
        expect(answer).toEqual({ _tag: "answered", status: 302, body: "ok" });
        expect(SMOKE_ANSWER_MS).toBe(10_000);
        expect(asked).toHaveLength(1);
        expect(asked[0]?.url).toBe("https://abc-worker.owner.workers.dev/health");
        expect(asked[0]?.init.method).toBe("GET");
        expect(asked[0]?.init.redirect).toBe("manual");
        expect(asked[0]?.init.signal).toBeInstanceOf(AbortSignal);
      }),
  );

  it.effect(
    "[smoke-probe.body-capped] a body is read only to 64 KiB, so a check's text past it is not found, and a longer one is not read on",
    () =>
      Effect.gen(function* () {
        expect(SMOKE_BODY_BYTES).toBe(65_536);
        const long = `${"a".repeat(65_536)}NEEDLE`;
        const answer = yield* ask("https://x.owner.workers.dev/", async () => new Response(long));
        expect(answer._tag).toBe("answered");
        if (answer._tag !== "answered") return;
        expect(answer.body).toHaveLength(65_536);
        expect(answer.body).not.toContain("NEEDLE");
        // A megabyte body, sent 16 KiB at a time, is read no further than the cap.
        let pulled = 0;
        const endless = new ReadableStream<Uint8Array>({
          pull: (controller) => {
            pulled += 1;
            if (pulled > 64) controller.close();
            else controller.enqueue(new Uint8Array(16 * 1024).fill(97));
          },
        });
        const capped = yield* ask("https://x.owner.workers.dev/", async () => new Response(endless));
        expect(capped._tag === "answered" ? capped.body.length : 0).toBe(65_536);
        expect(pulled).toBeLessThanOrEqual(6);
      }),
  );

  it.effect(
    "[smoke-probe.no-answer] a request that throws or times out is no answer, with its message",
    () =>
      Effect.gen(function* () {
        const answer = yield* ask("https://x.owner.workers.dev/", async () => {
          throw new Error("The operation was aborted due to timeout");
        });
        expect(answer).toEqual({
          _tag: "no-answer",
          error: "The operation was aborted due to timeout",
        });
      }),
  );
});
