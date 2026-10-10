import { describe, expect, it } from "@effect/vitest";
import { AgentId, Instant } from "@keeltown/core/kernel";
import { type AgentNotice, Inbox } from "@keeltown/core/ports";
import { Effect, Fiber, type Layer, Schema } from "effect";

/**
 * What the `Inbox` suite needs beside the port: a way to get a notice to an
 * agent, as an event it relies on would. Cases assert counts and cursors, not
 * notice text, so an adapter may word its notices its own way.
 */
export interface InboxHarness {
  readonly layer: Layer.Layer<Inbox>;
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

export function describeInboxContract(adapter: string, make: () => InboxHarness) {
  describe(`Inbox contract: ${adapter}`, () => {
    it.live("answers an empty page, with a cursor, for an agent with no notices", () => {
      const harness = make();
      return Effect.gen(function* () {
        const page = yield* (yield* Inbox).read(freshAgent(), undefined, 0);
        expect(page.notices).toEqual([]);
        expect(typeof page.cursor).toBe("string");
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("reads a notice once: the cursor it returns resumes after it", () => {
      const harness = make();
      return Effect.gen(function* () {
        const inbox = yield* Inbox;
        const agentId = freshAgent();
        yield* harness.deliver(agentId, notice("Your change was submitted"));
        const first = yield* inbox.read(agentId, undefined, 0);
        expect(first.notices).toHaveLength(1);
        const again = yield* inbox.read(agentId, first.cursor, 0);
        expect(again.notices).toEqual([]);
        yield* harness.deliver(agentId, notice("Your change landed"));
        expect((yield* inbox.read(agentId, first.cursor, 0)).notices).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("answers a waiting read as soon as a notice arrives", () => {
      const harness = make();
      return Effect.gen(function* () {
        const inbox = yield* Inbox;
        const agentId = freshAgent();
        const started = Date.now();
        const waiting = yield* Effect.forkChild(inbox.read(agentId, undefined, 20));
        yield* Effect.sleep("200 millis");
        yield* harness.deliver(agentId, notice("Your change was submitted"));
        const page = yield* Fiber.join(waiting);
        expect(page.notices).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(10_000);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("answers a waiting read with an empty page when the wait runs out", () => {
      const harness = make();
      return Effect.gen(function* () {
        const started = Date.now();
        const page = yield* (yield* Inbox).read(freshAgent(), undefined, 1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
        expect(page.notices).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
