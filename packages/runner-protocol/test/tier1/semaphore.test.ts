import { describe, expect, it } from "vitest";
import { Semaphore } from "../../src/tier1/semaphore.ts";
import { fc } from "../support/fast-check.ts";

const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("Semaphore", () => {
  it("[semaphore.bounded-fifo] never holds more than its size, finishes every task, and starts waiters in arrival order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.record({ arriveAfter: fc.nat(3), holdFor: fc.nat(6) }), {
          minLength: 1,
          maxLength: 12,
        }),
        async (size, tasks) => {
          const semaphore = new Semaphore(size);
          let inFlight = 0;
          let most = 0;
          const queuedArrivals: number[] = [];
          const queuedStarts: number[] = [];
          const finished: number[] = [];
          const runs: Array<Promise<void>> = [];
          for (const [i, task] of tasks.entries()) {
            await ticks(task.arriveAfter);
            if (semaphore.inFlight === semaphore.size) queuedArrivals.push(i);
            runs.push(
              semaphore.run(async (queued) => {
                if (queued) queuedStarts.push(i);
                inFlight++;
                most = Math.max(most, inFlight);
                await ticks(task.holdFor);
                inFlight--;
                finished.push(i);
              }),
            );
          }
          await Promise.all(runs);
          expect(most).toBeLessThanOrEqual(size);
          expect(finished.toSorted((a, b) => a - b)).toEqual(tasks.map((_, i) => i));
          expect(queuedStarts).toEqual(queuedArrivals);
          expect(semaphore.inFlight).toBe(0);
        },
      ),
    );
  });

  it("queues the fifth of five at once on four slots, and runs it once a slot frees", async () => {
    const semaphore = new Semaphore(4);
    const permits = await Promise.all([1, 2, 3, 4].map(() => semaphore.acquire()));
    expect(permits.map((p) => p.queued)).toEqual([false, false, false, false]);
    const fifth = semaphore.acquire();
    await ticks(3);
    expect(semaphore.waiting).toBe(1);
    permits[0]?.release();
    permits[0]?.release();
    expect((await fifth).queued).toBe(true);
    expect(semaphore.inFlight).toBe(4);
    expect(semaphore.waiting).toBe(0);
  });

  it("releases the slot when the task throws", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(semaphore.inFlight).toBe(0);
  });

  it("refuses a size below one", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});
