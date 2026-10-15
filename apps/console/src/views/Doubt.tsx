// How a premise Keel put in doubt is said: as the status lines of a code host's merge box, one per premise, naming
// the change that put it in doubt and how.

import type { ReactNode } from "react";
import type { Proposition } from "../contract/mfp.ts";
import type { Doubt } from "../domain/state.ts";
import { RELATION_WORD } from "./parts.tsx";

/** What a proposition says of its subject, in one run of text. */
export const saysOf = (proposition: Proposition): string =>
  `${proposition.predicate} ${RELATION_WORD[proposition.relation] ?? proposition.relation} ${String(proposition.value)}${proposition.unit === undefined ? "" : ` ${proposition.unit}`}`;

/** A proposition in one run of text: its subject, then what it says of it. */
export const propositionSaid = (proposition: Proposition): string =>
  `${proposition.subject} / ${saysOf(proposition)}`;

export const doubtKey = (doubt: Doubt): string =>
  [
    doubt.by.id,
    propositionSaid(doubt.premise),
    "effect" in doubt.cause
      ? propositionSaid(doubt.cause.effect)
      : `${doubt.cause.edit.path}#${doubt.cause.edit.symbol ?? ""}`,
  ].join(" ");

/** The line itself, after `by`, the change that put the premise in doubt: a link, or its label inside one. */
export function DoubtSaid({ doubt, by }: { doubt: Doubt; by: ReactNode }) {
  if ("effect" in doubt.cause)
    return (
      <>
        {by}’s effect <span className="a-mono">{propositionSaid(doubt.cause.effect)}</span> may
        contradict this premise.
      </>
    );
  const { path, symbol } = doubt.cause.edit;
  return (
    <>
      {by} changed <span className="a-mono break-all">{path}</span>
      {symbol !== undefined && (
        <>
          {" "}
          (<span className="a-mono">{symbol}</span>)
        </>
      )}
      , which this premise rests on.
    </>
  );
}
