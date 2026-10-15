// The project's conflicts, listed.

import { HandPalmIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import { type ConflictFilter, PAGE, conflictsOf } from "../engine/lists.ts";
import { useSelected } from "../engine/react.tsx";
import {
  CONFLICT_TONE,
  Column,
  ConflictMark,
  Filters,
  More,
  Nothing,
  Row,
  Rows,
} from "../views/List.tsx";
import {
  ChangeLink,
  ConflictLink,
  DecisionLink,
  EscalationLink,
  SubjectLink,
} from "../views/links.tsx";
import { dateTime } from "../views/parts.tsx";

const FILTERS: { id: ConflictFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "settled", label: "Settled" },
];

const EMPTY: Record<ConflictFilter, string> = {
  open: "No open conflicts",
  settled: "No settled conflicts",
};

export function ConflictsPage({ filter, shown }: { filter: ConflictFilter; shown: number }) {
  const list = useSelected((world) => conflictsOf(world, filter, shown), [filter, shown]);
  const any = list.counts.open + list.counts.settled > 0;
  const title = any ? EMPTY[filter] : "No conflicts";
  return (
    <Column>
      <h1 className="sr-only">Conflicts</h1>
      <Filters
        label="Conflicts, by state"
        options={FILTERS.map((option) => ({ ...option, count: list.counts[option.id] }))}
        active={filter}
        to={(next) => ({ at: "conflicts", filter: next, shown: PAGE })}
      />
      {list.rows.length === 0 ? (
        <Nothing title={title} />
      ) : (
        <Rows label="Conflicts, newest first">
          {list.rows.map((row) => (
            <Row
              key={row.id}
              mark={<ConflictMark state={row.state} guarded={row.guard !== undefined} />}
              title={
                <ConflictLink id={row.id}>
                  {row.summary === "" ? `Conflict ${row.label}` : `Conflict on ${row.summary}`}
                </ConflictLink>
              }
              meta={
                <>
                  <span className="text-kumo-subtle">{row.label}</span>
                  <span>{row.kind}</span>
                  {row.subject !== undefined && (
                    <SubjectLink subject={row.subject} className="a-mono a-link-quiet">
                      {row.subject}
                    </SubjectLink>
                  )}
                  <span>
                    opened <time className="a-num">{dateTime(row.openedAt)}</time>
                  </span>
                  {row.parties.length > 0 && (
                    <span>
                      between{" "}
                      {row.parties.map((party, index) => (
                        <Fragment key={party.id}>
                          {index > 0 && " and "}
                          <ChangeLink id={party.id} className="a-mono a-link-quiet font-semibold">
                            {party.label}
                          </ChangeLink>
                        </Fragment>
                      ))}
                    </span>
                  )}
                </>
              }
              tied={
                <>
                  {row.probe !== undefined && (
                    <ConflictLink
                      id={row.id}
                      tab="probe"
                      className="a-chip"
                      data-tone="quiet"
                      title={`Probe ${row.probe.label}: ${row.probe.state}`}
                    >
                      {row.probe.label}
                    </ConflictLink>
                  )}
                  {row.guard !== undefined && (
                    <span className="a-chip" data-tone="guarded" title={`Guard ${row.guard.label}`}>
                      <ShieldCheckIcon size={12} weight="fill" />
                      {row.guard.label}
                    </span>
                  )}
                  {row.escalation !== undefined && (
                    <EscalationLink
                      id={row.escalation.id}
                      className="a-chip"
                      data-tone={row.escalation.open ? "person" : "quiet"}
                      title={`Escalation ${row.escalation.label}`}
                    >
                      {row.escalation.open && <HandPalmIcon size={12} weight="fill" />}
                      {row.escalation.label}
                    </EscalationLink>
                  )}
                  {row.decision !== undefined && (
                    <DecisionLink
                      id={row.decision.id}
                      className="a-chip"
                      data-tone="quiet"
                      title={`Decision ${row.decision.label}`}
                    >
                      {row.decision.label}
                    </DecisionLink>
                  )}
                  <span
                    className="a-chip w-24 justify-center"
                    data-tone={CONFLICT_TONE[row.state] ?? "quiet"}
                  >
                    {row.state === "escalated" ? "proven" : row.state}
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
        noun="conflicts"
        to={(next) => ({ at: "conflicts", filter, shown: next })}
      />
    </Column>
  );
}
