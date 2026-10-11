import { readFeed, recordFeed } from "@keeltown/core/application/memory";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore, type Stored, type Transaction } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { ProjectorCodecs, ProjectorRead, type ProjectorRpc } from "../../../rpc/index.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** Where the Projector counts the nudges it has had. */
export const NUDGES = { kind: "projector", id: "nudges" } as const;

/**
 * The Projector DO: every event Keel commits arrives here and joins the feed,
 * which the console reads. It drains the operation log into read models when
 * nudged; every outbox flush nudges it, the one sanctioned exception to
 * "nothing polls". Until the operation log exists a nudge only counts
 * itself. It does not deliver to itself.
 */
export class ProjectorDO extends KeelObjectWith<never> implements ProjectorRpc {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, Layer.empty, { projected: false });
  }

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

  /** Every arrival joins the feed; the receipt's dedupe makes a redelivery a no-op, and `answer` wakes any reader. */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction {
    recordFeed(tx.store, event);
    return { drafts: [] };
  }

  async read(request: typeof ProjectorRead.Encoded) {
    const waiters = this.waiters;
    const program = Schema.decodeUnknownEffect(ProjectorRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ cursor, limit, waitMs }) =>
        waiters.until(waitMs ?? 0, readFeed(cursor, limit), (page) => page.events.length > 0),
      ),
    );
    return this.answer(ProjectorCodecs.read, program);
  }
}
