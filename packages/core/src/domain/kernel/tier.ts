import { Schema } from "effect";

/**
 * Where a step runs: 0 is pure git inside a Durable Object, 1 a throwaway
 * isolate, 2 a container (ADR 0006). Every step records its tier and why.
 */
export const Tier = Schema.Literals([0, 1, 2]);
export type Tier = typeof Tier.Type;

export const TierChoice = Schema.Struct({ tier: Tier, reason: Schema.NonEmptyString });
export type TierChoice = typeof TierChoice.Type;
