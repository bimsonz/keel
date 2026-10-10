import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeId } from "@keeltown/core/kernel";
import { Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import { backbone, type ChangeServices } from "../../src/composition/do.ts";

export const changeStub = (changeId = makeId("chg", ulid())) =>
  env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`));

/**
 * Runs the Change DO on these driven adapters instead of its composition's.
 * Test-only: it replaces the instance's runtime from inside the object, so
 * production code carries no hook for it. The pool tests share the object's
 * isolate, so an in-memory adapter here is the same one the test inspects.
 */
export function rewire(
  stub: DurableObjectStub<ChangeDO>,
  driven: Layer.Layer<ChangeServices>,
): Promise<void> {
  return runInDurableObject(stub, (instance: ChangeDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), driven)),
    );
  });
}
