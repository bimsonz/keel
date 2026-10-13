// The project's decisions, as Keel remembers them: its own list, a page at a time.

import { GavelIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { type DecisionsRead, decisionRowsOf, readDecisions, turnsOf } from "../engine/decisions.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import { Link } from "../router.tsx";
import { Notice } from "../views/Frame.tsx";
import { Column, Nothing, Row, Rows } from "../views/List.tsx";
import { ConflictLink, DecisionLink, SubjectLink } from "../views/links.tsx";
import { dateTime } from "../views/parts.tsx";

/** What Keel has answered of the list asked for: `of` is which list, so another's answer is never shown as this one's. */
type Listed = { of: string; read: DecisionsRead } | { of: string; refused: string } | undefined;

const STATE_TONE = { active: "guarded", superseded: "quiet", overruled: "quiet" } as const;

export function DecisionsPage({ subject }: { subject?: string }) {
  const player = usePlayer();
  const remembered = player.source.decisions;
  // The project's own log says when Keel's list may have changed: nothing here reads by the clock.
  const turns = useSelected(turnsOf);
  const of = subject ?? "";
  // How many of Keel's pages the reader has asked for of this list: another list starts at its first.
  const [asked, setAsked] = useState({ of, pages: 1 });
  const pages = asked.of === of ? asked.pages : 1;
  const [listed, setListed] = useState<Listed>();

  useEffect(() => {
    if (remembered === undefined) return undefined;
    const stop = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const answer = await readDecisions(remembered, subject, pages, stop.signal);
        if (!stop.signal.aborted) setListed({ of, read: answer });
      } catch (error) {
        if (!stop.signal.aborted)
          setListed({
            of,
            refused: error instanceof Error ? error.message : "Keel did not answer",
          });
      }
    };
    void read();
    return () => stop.abort();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `turns` is the log saying Keel's list may have changed
  }, [remembered, subject, of, pages, turns]);

  const answer = listed?.of === of ? listed : undefined;
  const rows = useSelected(
    (world) =>
      answer !== undefined && "read" in answer ? decisionRowsOf(answer.read.items, world) : [],
    [answer],
  );

  if (remembered === undefined)
    return (
      <Notice title="A test fixture has no memory of decisions">
        Keel remembers a project's decisions, and this is not Keel.
      </Notice>
    );
  return (
    <Column>
      <h1 className="sr-only">Decisions</h1>
      {subject !== undefined && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-kumo-subtle">
          <span>
            Decisions on{" "}
            <SubjectLink subject={subject} className="a-mono a-link-quiet">
              {subject}
            </SubjectLink>
          </span>
          <Link to={{ at: "decisions" }} className="a-link">
            Every decision
          </Link>
        </p>
      )}
      {answer === undefined ? (
        <output className="px-1 py-6 text-sm text-kumo-subtle">
          Reading the decisions Keel remembers…
        </output>
      ) : "refused" in answer ? (
        <Nothing title="Keel did not list this project's decisions">{answer.refused}</Nothing>
      ) : rows.length === 0 ? (
        <Nothing title={subject === undefined ? "No decision yet" : `No decision on ${subject}`}>
          A decision is recorded when a person rules on a question about a proven conflict. Keel
          remembers what the ruling upheld, and the guard drawn from the proof holds it.
        </Nothing>
      ) : (
        <Rows label="Decisions, newest first">
          {rows.map((row) => (
            <Row
              key={row.id}
              mark={
                <GavelIcon
                  size={18}
                  weight={row.state === "active" ? "fill" : "regular"}
                  className={row.state === "active" ? "text-kumo-default" : "text-kumo-subtle"}
                  aria-label={row.state}
                />
              }
              title={<DecisionLink id={row.id}>{row.summary}</DecisionLink>}
              meta={
                <>
                  <b className="font-semibold text-kumo-default">{row.label}</b>
                  <span>
                    decided <time className="a-num">{dateTime(row.decidedAt)}</time>
                  </span>
                  {row.subject !== undefined && (
                    <SubjectLink subject={row.subject} className="a-mono a-link-quiet">
                      {row.subject}
                    </SubjectLink>
                  )}
                  {row.conflict !== undefined && (
                    <span>
                      ruled{" "}
                      <ConflictLink id={row.conflict.id} className="a-link-quiet font-semibold">
                        {row.conflict.label === "" ? "a conflict" : row.conflict.label}
                      </ConflictLink>
                    </span>
                  )}
                </>
              }
              tied={
                <span className="a-chip w-24 justify-center" data-tone={STATE_TONE[row.state]}>
                  {row.state}
                </span>
              }
            />
          ))}
        </Rows>
      )}
      {answer !== undefined && "read" in answer && answer.read.next !== undefined && (
        <p className="flex items-center gap-3 text-sm text-kumo-subtle">
          <span className="a-num">{rows.length.toLocaleString("en-US")} decisions shown</span>
          <button
            type="button"
            className="a-link"
            onClick={() => setAsked({ of, pages: pages + 1 })}
          >
            Show more
          </button>
        </p>
      )}
    </Column>
  );
}
