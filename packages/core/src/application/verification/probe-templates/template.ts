import type { Result } from "effect";
import type { NoopRecipe } from "../world-matrix.ts";

/** A probe file Keel renders: its path under `.keel/`, and its text. */
export interface ProbeFile {
  readonly path: string;
  readonly text: string;
}

/**
 * A predicate's probe template (spike S26): a model fills only its slots,
 * constrained by `schema`, through the PlatformFunction `fn`. Keel checks the
 * reply with `validate`, whose failure text is deterministic and is all a
 * repair is told, then renders the probe itself, so its code is Keel's.
 */
export interface ProbeTemplate<S> {
  /** Which template, and which version of it: part of what a drafted probe was drafted from. */
  readonly id: string;
  /** The PlatformFunction that fills it, pinned to its model in config. */
  readonly fn: string;
  readonly schema: Readonly<Record<string, unknown>>;
  /** How to fill it: what the template does with each slot, and the reply's shape. */
  readonly instructions: string;
  readonly validate: (reply: unknown) => Result.Result<S, string>;
  readonly render: (slots: S) => readonly ProbeFile[];
  /**
   * How the slots build A-noop from A's tree. A
   * template without one can never have a probe admitted: its matrix is
   * never complete, so the conflict escalates as unprovable.
   */
  readonly noop?: (slots: S) => NoopRecipe;
}
