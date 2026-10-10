import { Context, type Effect } from "effect";
import type { ModelAbstained } from "../../domain/verification/index.ts";

/** One typed question, in the System One shape: yes/no/unclear, a choice (always with `unclear`), or a score. */
export type Question =
  | { readonly id: string; readonly kind: "noul"; readonly text: string }
  | { readonly id: string; readonly kind: "choice"; readonly text: string; readonly options: readonly string[] }
  | { readonly id: string; readonly kind: "score"; readonly text: string; readonly min: number; readonly max: number };

export interface DecisionRequest {
  /** Structured facts. Author narrative stays out. */
  readonly state: Readonly<Record<string, unknown>>;
  /** At most 64, all asked up front. */
  readonly questions: readonly Question[];
}

export interface Answer {
  readonly questionId: string;
  /** Probability per option. */
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface DecisionResponse {
  readonly answers: readonly Answer[];
  /** The pinned model revision that answered, for the calibration ledger. */
  readonly model: string;
}

/** A decision model behind the System One request shape (ADR 0012). Its answers are opinion. */
export class DecisionModel extends Context.Service<DecisionModel, {
  readonly ask: (request: DecisionRequest) => Effect.Effect<DecisionResponse, ModelAbstained>;
}>()("keel/DecisionModel") {}
