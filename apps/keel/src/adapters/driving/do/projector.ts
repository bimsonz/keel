import type { Stored } from "@keeltown/core/ports";
import { EntityStore } from "@keeltown/core/ports";
import { Effect } from "effect";
import { ProjectorCodecs, type ProjectorRpc } from "../../../rpc/index.ts";
import { KeelObject } from "./keel-object.ts";

/** Where the Projector counts the nudges it has had. */
export const NUDGES = { kind: "projector", id: "nudges" } as const;

/**
 * The Projector DO: drains the operation log into read models when nudged.
 * Every outbox flush nudges it, the one sanctioned exception to "nothing
 * polls". Until the operation log exists a nudge only counts itself.
 */
export class ProjectorDO extends KeelObject implements ProjectorRpc {
  async nudge() {
    const program = Effect.gen(function* () {
      const store = yield* EntityStore;
      store.transaction(() => {
        const seen: Stored = store.get(NUDGES.kind, NUDGES.id) ?? 0;
        store.put(NUDGES.kind, NUDGES.id, (typeof seen === "number" ? seen : 0) + 1);
      });
      return { drained: 0 };
    });
    return this.answer(ProjectorCodecs.nudge, program);
  }
}
