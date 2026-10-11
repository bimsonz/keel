import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { armedAlarms, scheduleAlarm } from "../../src/adapters/driving/do/alarm.ts";
import { OUTBOX_FLUSH } from "../../src/adapters/driving/do/keel-object.ts";
import { drainAfter, drainOutbox } from "./helpers.ts";

/**
 * How long a hand-armed flush waits: well past the gap between one case's end
 * and the next one's start, and past `REFUSED_MS`.
 */
const HELD_MS = 5_000;

/**
 * The budget of the drain that must refuse while the flush is held: long
 * enough for at least one look at the object on a loaded machine, so the
 * refusal names the armed flush instead of a bare timeout (300 ms did not
 * hold at a load of 80).
 */
const REFUSED_MS = 2_000;

/** A fresh object with a flush armed `HELD_MS` from now, by hand: what a commit leaves behind, held long enough to see. */
async function heldFlush(): Promise<DurableObjectStub> {
  const stub = env.CHANGE.get(env.CHANGE.idFromName(`change:${makeId("chg", ulid())}`));
  await runInDurableObject(stub, (_instance: unknown, state) =>
    scheduleAlarm(state.storage, {
      kind: "debounce",
      reason: OUTBOX_FLUSH,
      at: Date.now() + HELD_MS,
    }),
  );
  return stub;
}

const armedFlushes = (stub: DurableObjectStub) =>
  runInDurableObject(
    stub,
    (_instance: unknown, state) =>
      armedAlarms(state.storage).filter((alarm) => alarm.reason === OUTBOX_FLUSH).length,
  );

describe("draining an object's outbox before a case ends", () => {
  it("[b12.drain] does not call an object quiet while its flush is armed, and does once it has fired", async () => {
    const stub = await heldFlush();

    await expect(drainOutbox(stub, REFUSED_MS)).rejects.toThrow(/outbox flush/);
    await drainOutbox(stub);
    expect(await armedFlushes(stub)).toBe(0);
  });

  // The next two cases run in order: the first ends with a flush still armed, the second looks at it.
  let left: DurableObjectStub | undefined;

  it("[b12.drain] registers an object whose flush is still armed as its case ends", async () => {
    left = drainAfter(await heldFlush());

    expect(await armedFlushes(left)).toBe(1);
  });

  it("[b12.drain] finds that object flushed as the next case starts, because the case's end drained it", async () => {
    if (left === undefined) throw new Error("the case before this one registers the object");

    expect(await armedFlushes(left)).toBe(0);
  });
});
