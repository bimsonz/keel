// The project's changes, listed.

import { HandPalmIcon } from "@phosphor-icons/react";
import { type ChangeFilter, PAGE, changesOf } from "../engine/lists.ts";
import { useHolderCards, useSelected } from "../engine/react.tsx";
import {
  CHANGE_TONE,
  CONFLICT_TONE,
  ChangeMark,
  Column,
  Filters,
  More,
  Nothing,
  Row,
  Rows,
} from "../views/List.tsx";
import {
  ChangeLink,
  ConflictLink,
  EscalationLink,
  HolderLink,
  HeldRun,
  SubjectLink,
} from "../views/links.tsx";
import { AgentMark, Unverified, agentLine, dateTime } from "../views/parts.tsx";

const FILTERS: { id: ChangeFilter; label: string }[] = [
  { id: "in-flight", label: "In flight" },
  { id: "parked", label: "Parked" },
  { id: "bounced", label: "Bounced" },
  { id: "landed", label: "Landed" },
  { id: "not-landed", label: "Not landed" },
];

const EMPTY: Record<ChangeFilter, [string, string]> = {
  "in-flight": [
    "Nothing is in flight",
    "Every change declared so far has landed, is parked on a question, has bounced, or will not land.",
  ],
  parked: [
    "Nothing is parked",
    "A change parks when it waits on a person's answer. None is waiting now.",
  ],
  bounced: [
    "Nothing has bounced",
    "A change bounces when Keel's verdict refuses it as it stands. It is still open: its agent may revise it.",
  ],
  landed: [
    "Nothing has landed yet",
    "A change lands when Keel has verified it against everything it could have broken.",
  ],
  "not-landed": [
    "Every change may still land, or has",
    "A change that was withdrawn or superseded will not land, and is listed here.",
  ],
};

export function ChangesPage({ filter, shown }: { filter: ChangeFilter; shown: number }) {
  const list = useSelected(
    (world, from) => changesOf(world, filter, shown, from.cards),
    [filter, shown],
  );
  useHolderCards(list.rows.map((row) => row.id));
  const any = Object.values(list.counts).some((count) => count > 0);
  const [title, body] = any
    ? EMPTY[filter]
    : [
        "No change has been declared yet",
        "A change appears here when an agent declares an intent: what it means to do, before it writes any code.",
      ];
  return (
    <Column>
      <h1 className="sr-only">Changes</h1>
      <Filters
        label="Changes, by state"
        options={FILTERS.map((option) => ({ ...option, count: list.counts[option.id] }))}
        active={filter}
        to={(next) => ({ at: "changes", filter: next, shown: PAGE })}
      />
      {list.rows.length === 0 ? (
        <Nothing title={title}>{body}</Nothing>
      ) : (
        <Rows label="Changes, newest first">
          {list.rows.map((row) => (
            <Row
              key={row.id}
              mark={<ChangeMark state={row.state} />}
              title={<ChangeLink id={row.id}>{row.goal}</ChangeLink>}
              meta={
                <>
                  <b className="a-mono font-semibold text-kumo-default">{row.label}</b>
                  <span>
                    declared <time className="a-num">{dateTime(row.declaredAt)}</time> by
                  </span>
                  <HolderLink
                    held={row.held}
                    className="a-link-quiet inline-flex items-center gap-1.5"
                  >
                    <AgentMark agentClass={row.agentClass} size={12} />
                    {agentLine(row.agent, row.agentClass)}
                  </HolderLink>
                  <HeldRun held={row.held} className="a-link-quiet" />
                  {row.subject !== undefined && (
                    <SubjectLink subject={row.subject} className="a-mono a-link-quiet">
                      {row.subject}
                    </SubjectLink>
                  )}
                </>
              }
              tied={
                <>
                  {row.conflicts.map((conflict) => (
                    <ConflictLink
                      key={conflict.id}
                      id={conflict.id}
                      className="a-chip"
                      data-tone={CONFLICT_TONE[conflict.state] ?? "quiet"}
                      title={`Conflict ${conflict.label}`}
                    >
                      {conflict.label}
                    </ConflictLink>
                  ))}
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
                  {row.unverified && <Unverified />}
                  <span
                    className="a-chip w-24 justify-center"
                    data-tone={CHANGE_TONE[row.state] ?? "quiet"}
                  >
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
        noun="changes"
        to={(next) => ({ at: "changes", filter, shown: next })}
      />
    </Column>
  );
}
