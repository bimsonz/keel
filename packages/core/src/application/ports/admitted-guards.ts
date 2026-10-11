import { Context, type Effect, Schema } from "effect";
import type { ProjectId } from "../../domain/kernel/index.ts";
import type { AdmittedGuard } from "../../domain/verification/index.ts";

/**
 * A guard the guard repo holds that cannot run: its `guard.json` is missing,
 * unreadable, or names no proposition. It is never skipped silently: Precheck
 * keeps it in the run, saying why.
 */
export interface GuardRefused {
  readonly guardId: string;
  readonly reason: string;
}

/** A project's admitted guards, and the guards in its guard repo that could not be admitted to a plan. */
export interface AdmittedGuardList {
  readonly admitted: readonly AdmittedGuard[];
  readonly refused: readonly GuardRefused[];
}

/** The guard repo could not be read at all. Precheck refuses rather than compile a plan without its guards. */
export class GuardsUnreadable extends Schema.TaggedError<GuardsUnreadable>()("GuardsUnreadable", {
  reason: Schema.String,
}) {}

/**
 * A project's admitted guards, read from their one home, the project's guard
 * repo: each `<guardId>/guard.json` names the guard, the probe bundle it runs
 * (by content hash) and the proposition it guards. Compile selects from these
 * the guards a change is exposed to. A project whose guard repo does not
 * exist has admitted no guard, so its list is empty.
 */
export class AdmittedGuards extends Context.Service<
  AdmittedGuards,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<AdmittedGuardList, GuardsUnreadable>;
  }
>()("keel/AdmittedGuards") {}
