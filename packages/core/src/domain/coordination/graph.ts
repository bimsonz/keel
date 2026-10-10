import type { ChangeId, GuardId, TenetId } from "../kernel/index.ts";
import type { Intent } from "./change.ts";
import type { DerivedEffect } from "./derivation.ts";
import type { Proposition } from "./proposition.ts";

/** A premise as the premise graph holds it: what one change relies on. */
export type HeldPremise = { readonly holder: ChangeId; readonly proposition: Proposition };

/**
 * A tenet as the Subject DO compares it: the guarded claim written as a
 * proposition on the subject's key, and the guards that back it.
 */
export type GuardedTenet = { readonly id: TenetId; readonly proposition: Proposition; readonly guards: readonly GuardId[] };

/** Another change still in flight, with what it declared and what Keel derived from it. */
export type LiveChange = { readonly id: ChangeId; readonly intent: Intent; readonly derived: readonly DerivedEffect[] };
