// The questions Keel has put to a person, listed.

import { HandPalmIcon } from "@phosphor-icons/react";
import { type EscalationFilter, PAGE, escalationsOf } from "../engine/lists.ts";
import { useSelected } from "../engine/react.tsx";
import { CATEGORY } from "../views/Escalation.tsx";
import { Column, EscalationMark, Filters, More, Nothing, Row, Rows } from "../views/List.tsx";
import { ConflictLink, EscalationLink, SubjectLink } from "../views/links.tsx";
import { dateTime } from "../views/parts.tsx";

const FILTERS: { id: EscalationFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
];

const EMPTY: Record<EscalationFilter, [string, string]> = {
  open: [
    "Nothing is waiting for a person",
    "Keel settles almost everything itself. A question arrives here only when proof exists and the answer is a matter of judgement: permission semantics, a destructive migration, an ambiguous requirement.",
  ],
  closed: [
    "No question has been closed yet",
    "A question is closed when a person answers it, and the answer is recorded as a decision that later changes meet as precedent; or when Keel withdraws it before anyone has.",
  ],
};

export function EscalationsPage({ filter, shown }: { filter: EscalationFilter; shown: number }) {
  const list = useSelected((world) => escalationsOf(world, filter, shown), [filter, shown]);
  const [title, body] = EMPTY[filter];
  return (
    <Column>
      <h1 className="sr-only">Escalations</h1>
      <Filters
        label="Escalations, by state"
        options={FILTERS.map((option) => ({ ...option, count: list.counts[option.id] }))}
        active={filter}
        to={(next) => ({ at: "escalations", filter: next, shown: PAGE })}
      />
      {list.rows.length === 0 ? (
        <Nothing title={title}>{body}</Nothing>
      ) : (
        <Rows label="Escalations, newest first">
          {list.rows.map((row) => (
            <Row
              key={row.id}
              mark={<EscalationMark state={row.state} />}
              title={<EscalationLink id={row.id}>{row.question}</EscalationLink>}
              meta={
                <>
                  <b className="font-semibold text-kumo-default">{row.label}</b>
                  <span>{CATEGORY[row.category]}</span>
                  {row.subject !== undefined && (
                    <SubjectLink subject={row.subject} className="a-mono a-link-quiet">
                      {row.subject}
                    </SubjectLink>
                  )}
                  <span>
                    asked <time className="a-num">{dateTime(row.raisedAt)}</time>
                  </span>
                  {row.conflict !== undefined && (
                    <span>
                      raised by conflict{" "}
                      <ConflictLink id={row.conflict.id} className="a-link-quiet font-semibold">
                        {row.conflict.label}
                      </ConflictLink>
                    </span>
                  )}
                </>
              }
              tied={
                <>
                  {row.parked > 0 && (
                    <span className="text-sm text-kumo-default">
                      {row.parked} {row.parked === 1 ? "change is" : "changes are"} parked on this
                    </span>
                  )}
                  {row.ruled !== undefined && (
                    <span
                      className="max-w-[44ch] truncate text-sm text-kumo-default"
                      title={row.ruled}
                    >
                      Ruled: <b className="font-semibold text-kumo-strong">{row.ruled}</b>
                    </span>
                  )}
                  {row.decision !== undefined && (
                    <span
                      className="a-chip"
                      data-tone="quiet"
                      title={`Decision ${row.decision.label}`}
                    >
                      {row.decision.label}
                    </span>
                  )}
                  <span
                    className="a-chip w-24 justify-center"
                    data-tone={row.state === "open" ? "person" : "quiet"}
                  >
                    {row.state === "open" && <HandPalmIcon size={12} weight="fill" />}
                    {row.state}
                  </span>
                </>
              }
            />
          ))}
        </Rows>
      )}
      <More
        shown={shown}
        total={list.total}
        more={list.more}
        noun="escalations"
        to={(next) => ({ at: "escalations", filter, shown: next })}
      />
    </Column>
  );
}
