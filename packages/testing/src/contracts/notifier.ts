import { describe, expect, it } from "@effect/vitest";
import { AgentId, Instant } from "@keeltown/core/kernel";
import { type AgentNotice, Inbox, Notifier } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/**
 * What the `Notifier` suite needs: the piggyback and the inbox over the same
 * notices, and a way to get a notice to an agent. Cases assert counts, order
 * and cursors, not notice text, so an adapter may word its notices its own way.
 */
export interface NotifierHarness {
  readonly layer: Layer.Layer<Notifier | Inbox>;
  readonly deliver: (agentId: AgentId, notice: AgentNotice) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const freshAgent = () =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${[...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("")}`,
  );

const notice = (title: string): AgentNotice => ({
  id: crypto.randomUUID(),
  at: Instant(Date.UTC(2026, 9, 11)),
  kind: "change.moved",
  title,
});

export function describeNotifierContract(adapter: string, make: () => NotifierHarness) {
  describe(`Notifier contract: ${adapter}`, () => {
    it.live("takes nothing for an agent with no notices", () => {
      const harness = make();
      return Effect.gen(function* () {
        expect(yield* (yield* Notifier).take(freshAgent(), 3)).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("takes at most three, oldest first, each once and with its cursor", () => {
      const harness = make();
      return Effect.gen(function* () {
        const notifier = yield* Notifier;
        const agentId = freshAgent();
        for (const n of [1, 2, 3, 4, 5]) yield* harness.deliver(agentId, notice(`n${n}`));
        const first = yield* notifier.take(agentId, 10);
        expect(first).toHaveLength(3);
        const second = yield* notifier.take(agentId, 3);
        expect(second).toHaveLength(2);
        expect(yield* notifier.take(agentId, 3)).toEqual([]);
        const ids = [...first, ...second].map((taken) => taken.id);
        expect(new Set(ids).size).toBe(5);
        // Oldest first: the inbox, read from the start, lists them in the same order.
        const page = yield* (yield* Inbox).read(agentId, undefined, 0);
        expect(page.notices.map((read) => read.id)).toEqual(ids);
        // Each carries its cursor: reading the inbox from it returns only what is newer.
        const third = first[2];
        expect(third?.cursor).toBeTypeOf("string");
        const after = yield* (yield* Inbox).read(agentId, third?.cursor, 0);
        expect(after.notices.map((read) => read.id)).toEqual(second.map((taken) => taken.id));
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("never takes a notice an inbox read already returned", () => {
      const harness = make();
      return Effect.gen(function* () {
        const notifier = yield* Notifier;
        const agentId = freshAgent();
        yield* harness.deliver(agentId, notice("read in the inbox"));
        yield* harness.deliver(agentId, notice("read in the inbox too"));
        expect((yield* (yield* Inbox).read(agentId, undefined, 0)).notices).toHaveLength(2);
        expect(yield* notifier.take(agentId, 3)).toEqual([]);
        yield* harness.deliver(agentId, notice("new since the read"));
        expect(yield* notifier.take(agentId, 3)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
