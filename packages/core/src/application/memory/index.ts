import type { Effect } from "effect";
import type { SubjectKey } from "../../domain/coordination/index.ts";
import type { AgentToken } from "../../domain/identity/index.ts";
import type { NothingToExplain, WhyLink } from "../../domain/memory/index.ts";
import { stub } from "../not-implemented.ts";
import type { EntityStore, SubjectRegistry } from "../ports/index.ts";

/** memory use-cases reachable from the API. Signatures are fixed here. */

export type WhyTarget =
  | { readonly kind: "line"; readonly path: string; readonly line: number }
  | { readonly kind: "subject"; readonly subject: SubjectKey };

export const why: (
  principal: AgentToken,
  target: WhyTarget,
) => Effect.Effect<readonly WhyLink[], NothingToExplain, EntityStore | SubjectRegistry> =
  stub("memory/why");

export * from "./change-views.ts";
export * from "./conflict-views.ts";
export * from "./decision-index.ts";
export * from "./escalation-views.ts";
export * from "./feed.ts";
