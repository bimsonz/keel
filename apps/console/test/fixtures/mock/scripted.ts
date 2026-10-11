// What a fixture's log holds beyond what Keel publishes.

import type { AnyEvent } from "../../../src/contract/events.ts";

/**
 * A scripted event is a published one, and one thing Keel keeps to itself: which earlier event caused it.
 * Keel does not publish that, so nothing the console shows may read it. The fixtures' own checks and
 * counters do.
 */
export type ScriptedEvent = AnyEvent & { causation?: string };
