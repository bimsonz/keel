/** What the gate asks of the Director: a slot for one model call, and its return. */
export interface SlotKeeper {
  take(id: string): Promise<{
    readonly granted: boolean;
    readonly reason?: "busy" | "spent";
    readonly retryInMs?: number;
  }>;
  give(id: string): Promise<void>;
}

/** The AI binding as Flue's Workers AI provider calls it. */
export interface ModelRunner {
  run(
    modelId: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Response | Record<string, unknown>>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for a slot; refuses once the run's calls are spent. */
async function slotFor(
  keeper: SlotKeeper,
  id: string,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const taken = await keeper.take(id);
  if (taken.granted) return;
  if (taken.reason === "spent") throw new Error("This run's model calls are spent.");
  await wait(taken.retryInMs ?? 1_000);
  return slotFor(keeper, id, wait);
}

/**
 * The AI binding behind the run's ceilings: each call waits for a slot, a run
 * whose calls are spent is refused, and the slot is given back when the call
 * ends: a streamed answer's when its body has been read to the end.
 */
export function gated(
  ai: ModelRunner,
  keeper: SlotKeeper,
  wait: (ms: number) => Promise<void> = pause,
): ModelRunner {
  return {
    async run(modelId, inputs, options) {
      const id = crypto.randomUUID();
      await slotFor(keeper, id, wait);
      let answer: Response | Record<string, unknown>;
      try {
        answer = await ai.run(modelId, inputs, options);
      } catch (error) {
        await keeper.give(id);
        throw error;
      }
      if (!(answer instanceof Response) || answer.body === null) {
        await keeper.give(id);
        return answer;
      }
      const body = answer.body.pipeThrough(
        new TransformStream({
          async flush() {
            await keeper.give(id);
          },
        }),
      );
      return new Response(body, answer);
    },
  };
}
