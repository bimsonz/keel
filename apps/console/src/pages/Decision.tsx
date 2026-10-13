// One decision: what a person's ruling chose, what Keel holds of it, and the
// guard that keeps a later change from undoing it.

import { useEffect, useState } from "react";
import type { DecisionView } from "../contract/keel/index.ts";
import { decisionDetailOf, turnsOf } from "../engine/decisions.ts";
import { decisionNamed } from "../engine/lists.ts";
import { usePlayer, usePublicOnly, useSelected } from "../engine/react.tsx";
import { Head } from "../views/Detail.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column } from "../views/List.tsx";
import { ChangeLink, ConflictLink, EscalationLink, SubjectLink } from "../views/links.tsx";
import { Panel, PropositionLine, dateTime } from "../views/parts.tsx";

/** Keel's answer for the decision asked for: `of` is whose it is, so another's is never shown as this one's. */
type Read = { of: string; view: DecisionView | null } | { of: string; refused: string } | undefined;

const NONE = "text-base text-kumo-subtle";

export function DecisionPage({ name }: { name: string }) {
  const player = usePlayer();
  const remembered = player.source.decisions;
  const hidden = usePublicOnly();
  // The log names the decision an address calls `D-n`; Keel reads one by its id.
  const id = useSelected((world) => decisionNamed(world, name)?.id, [name]);
  const turns = useSelected(turnsOf);
  const [read, setRead] = useState<Read>();

  useEffect(() => {
    if (remembered === undefined || id === undefined) return undefined;
    const stop = new AbortController();
    const ask = async (): Promise<void> => {
      try {
        const view = await remembered.getDecision(id, stop.signal);
        if (!stop.signal.aborted) setRead({ of: id, view });
      } catch (error) {
        if (!stop.signal.aborted)
          setRead({
            of: id,
            refused: error instanceof Error ? error.message : "Keel did not answer",
          });
      }
    };
    void ask();
    return () => stop.abort();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `turns` is the log saying Keel's read may have changed
  }, [remembered, id, turns]);

  const answer = read?.of === id ? read : undefined;
  const detail = useSelected(
    (world) =>
      answer !== undefined && "view" in answer && answer.view !== null
        ? decisionDetailOf(answer.view, world, hidden)
        : undefined,
    [answer, hidden],
  );

  if (remembered === undefined)
    return (
      <Notice title="A test fixture has no memory of decisions">
        Keel remembers a project's decisions, and this is not Keel.
      </Notice>
    );
  if (id === undefined || (answer !== undefined && "view" in answer && answer.view === null))
    return (
      <Notice title={`There is no decision ${name} in what Keel has said so far`}>
        A decision is recorded when a person rules on a question about a proven conflict.
      </Notice>
    );
  if (answer !== undefined && "refused" in answer)
    return <Notice title={`Keel did not read decision ${name}`}>{answer.refused}</Notice>;
  if (detail === undefined)
    return (
      <Column>
        <h1 className="sr-only">Decision {name}</h1>
        <output className="px-1 py-6 text-sm text-kumo-subtle">
          Reading what Keel remembers of {name}…
        </output>
      </Column>
    );
  return (
    <Column>
      <Head
        title={detail.summary}
        label={detail.label}
        state={
          <span className="a-chip" data-tone={detail.state === "active" ? "guarded" : "quiet"}>
            {detail.state}
          </span>
        }
        meta={
          <>
            <span>
              decided <time className="a-num">{dateTime(detail.decidedAt)}</time>
            </span>
            <span>
              option <span className="a-mono">{detail.option}</span>
            </span>
            {detail.subject !== undefined && (
              <SubjectLink subject={detail.subject} className="a-mono a-link-quiet">
                {detail.subject}
              </SubjectLink>
            )}
            {detail.conflict !== undefined && (
              <span>
                ruled{" "}
                <ConflictLink id={detail.conflict.id} className="a-link-quiet font-semibold">
                  {detail.conflict.label === "" ? "a conflict" : detail.conflict.label}
                </ConflictLink>
              </span>
            )}
          </>
        }
      />

      <Panel title="What the ruling upheld" aside="Keel's own propositions">
        {detail.holds.length === 0 ? (
          <p className={NONE}>
            Keel holds no proposition for this ruling: it upheld neither side of the conflict.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="What the ruling upheld">
            {detail.holds.map((proposition) => (
              <li key={JSON.stringify(proposition)}>
                <PropositionLine proposition={proposition} />
                {proposition.gloss !== undefined && proposition.gloss !== "" && (
                  <p className="text-sm text-kumo-default">“{proposition.gloss}”</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="The guard that holds it">
        <div className="flex flex-col gap-2" data-part="guard" data-standing={detail.standing}>
          {detail.guards.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Guards that hold this decision">
              {detail.guards.map((guard) => (
                <li key={guard.id}>
                  {guard.conflictId === undefined ? (
                    <span className="a-chip" data-tone="guarded">
                      {guard.label}
                    </span>
                  ) : (
                    <ConflictLink
                      id={guard.conflictId}
                      tab="probe"
                      className="a-chip"
                      data-tone="guarded"
                      title={`Guard ${guard.label}: the probe it was admitted from`}
                    >
                      {guard.label}
                    </ConflictLink>
                  )}
                </li>
              ))}
            </ul>
          )}
          {detail.standing === "blocks" ? (
            <p className="text-base text-kumo-default">
              A change that fails this guard is bounced, whatever this project's policy for the
              predicate.
            </p>
          ) : detail.standing === "ended" ? (
            <p className={NONE}>
              This decision was {detail.state}, so its guard no longer blocks for it.
            </p>
          ) : (
            <p className={NONE}>Keel names no guard that holds this decision.</p>
          )}
        </div>
      </Panel>

      <Panel title="Went against">
        {detail.against.length === 0 ? (
          <p className={NONE}>Keel names no change this ruling went against.</p>
        ) : (
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1"
            aria-label="Changes the ruling went against"
          >
            {detail.against.map((change) => (
              <li key={change.id}>
                <ChangeLink id={change.id} className="a-mono a-link-quiet font-semibold">
                  {change.label}
                </ChangeLink>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Bounced citing it" aside="from this project's log">
        {detail.bounced.length === 0 ? (
          <p className={NONE}>No change has been bounced citing this decision.</p>
        ) : (
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1"
            aria-label="Changes bounced citing this decision"
          >
            {detail.bounced.map((change) => (
              <li key={change.id}>
                <ChangeLink id={change.id} className="a-mono a-link-quiet font-semibold">
                  {change.label}
                </ChangeLink>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {detail.question !== undefined && (
        <Panel title="The question it answered">
          <EscalationLink id={detail.question.id} className="a-link">
            {detail.question.label === "" ? "The question" : detail.question.label}
          </EscalationLink>
        </Panel>
      )}
    </Column>
  );
}
