import { describe, expect, it } from "vitest";
import { admitted } from "../src/admin.ts";
import { gated, type ModelRunner, type SlotKeeper } from "../src/run/gate.ts";

/** A keeper that answers from a script and records every give. */
function keeper(answers: Awaited<ReturnType<SlotKeeper["take"]>>[]) {
  const given: string[] = [];
  const taken: string[] = [];
  const k: SlotKeeper = {
    take: async (id) => {
      taken.push(id);
      return answers.shift() ?? { granted: true };
    },
    give: async (id) => void given.push(id),
  };
  return { k, given, taken };
}

const answering = (answer: () => Promise<Response | Record<string, unknown>>): ModelRunner => ({
  run: answer,
});
const noWait = async () => undefined;

describe("the model's gate", () => {
  it("[swarm.gate-wait] waits while every slot is held, then calls once its slot is granted", async () => {
    const { k, given, taken } = keeper([
      { granted: false, reason: "busy", retryInMs: 5 },
      { granted: true },
    ]);
    const waits: number[] = [];
    let calls = 0;
    const ai = gated(
      answering(async () => ({ calls: ++calls })),
      k,
      async (ms) => void waits.push(ms),
    );
    expect(await ai.run("@cf/m", {})).toEqual({ calls: 1 });
    expect(waits).toEqual([5]);
    expect(taken).toHaveLength(2);
    expect(given).toEqual([taken[0]]);
  });

  it("[swarm.gate-spent] refuses a call once the run's calls are spent, and calls nothing", async () => {
    const { k } = keeper([{ granted: false, reason: "spent", retryInMs: 0 }]);
    let calls = 0;
    const ai = gated(
      answering(async () => ({ calls: ++calls })),
      k,
      noWait,
    );
    await expect(ai.run("@cf/m", {})).rejects.toThrow(/spent/);
    expect(calls).toBe(0);
  });

  it("[swarm.gate-give] gives the slot back when a call fails, and when a streamed answer has been read, not before", async () => {
    const failing = keeper([]);
    await expect(
      gated(
        answering(async () => Promise.reject(new Error("model down"))),
        failing.k,
        noWait,
      ).run("@cf/m", {}),
    ).rejects.toThrow("model down");
    expect(failing.given).toHaveLength(1);

    const streaming = keeper([]);
    const answer = await gated(
      answering(async () => new Response("data: one\n\ndata: two\n\n")),
      streaming.k,
      noWait,
    ).run("@cf/m", {});
    if (!(answer instanceof Response)) throw new Error("a streamed answer is a Response");
    expect(streaming.given).toHaveLength(0);
    expect(await answer.text()).toBe("data: one\n\ndata: two\n\n");
    expect(streaming.given).toHaveLength(1);
  });
});

describe("the admin bearer", () => {
  it("[swarm.admin] admits only the exact bearer, and nothing at all when no secret is set", async () => {
    expect(await admitted("Bearer s3cret", "s3cret")).toBe("admitted");
    expect(await admitted("Bearer s3cre", "s3cret")).toBe("refused");
    expect(await admitted("s3cret", "s3cret")).toBe("refused");
    expect(await admitted(undefined, "s3cret")).toBe("refused");
    expect(await admitted("Bearer ", "")).toBe("unset");
    expect(await admitted("Bearer anything", undefined)).toBe("unset");
  });
});
