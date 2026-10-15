// The questions Keel has put to a person, listed.

import { rulingWords } from "../engine/ruling.ts";
import { HandPalmIcon } from "@phosphor-icons/react";
import { membersOf } from "../engine/audience.ts";
import { type EscalationFilter, PAGE, escalationsOf } from "../engine/lists.ts";
import { usePublicOnly, useSelected } from "../engine/react.tsx";
import { useWhere } from "../router.tsx";
import { CATEGORY } from "../views/Escalation.tsx";
import { Column, EscalationMark, Filters, More, Nothing, Row, Rows } from "../views/List.tsx";
import { ConflictLink, DecisionLink, EscalationLink, SubjectLink } from "../views/links.tsx";
import { dateTime } from "../views/parts.tsx";

const FILTERS: { id: EscalationFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
];

const EMPTY: Record<EscalationFilter, string> = {
  open: "No open questions",
  closed: "No closed questions",
};

/**
 * What a reader is told where Keel shows them none of a project's questions: that they are its members' to
 * read, never that there are none.
 */
export function ForMembers({ what }: { what: "list" | "question" }) {
  const { namespace, kind } = useWhere();
  const members = membersOf({ handle: namespace, ...(kind === undefined ? {} : { kind }) });
  // An org has members to sign in as. A person's namespace, or an agent's, is its owner's alone.
  const way = kind === "org" ? ` Sign in as a member of ${namespace} to ` : null;
  return (
    <Nothing title={what === "list" ? "Questions are visible to members" : "Visible to members"}>
      {`Readers: ${members}.${way === null ? "" : `${way}${what === "list" ? "read and answer them" : "answer"}.`}`}
    </Nothing>
  );
}

/** A question as a person reads it: in words, where Keel says which changes it is about. */
function QuestionTitle({ id, fallback }: { id: string; fallback: string }) {
  const title = useSelected(
    (world) => {
      const entry = world.escalations.get(id);
      return entry === undefined ? undefined : rulingWords(world, entry).title;
    },
    [id],
  );
  return <>{title ?? fallback}</>;
}

export function EscalationsPage({ filter, shown }: { filter: EscalationFilter; shown: number }) {
  const list = useSelected((world) => escalationsOf(world, filter, shown), [filter, shown]);
  const hidden = usePublicOnly();
  const title = EMPTY[filter];
  if (hidden)
    return (
      <Column>
        <h1 className="sr-only">Questions</h1>
        <ForMembers what="list" />
      </Column>
    );
  return (
    <Column>
      <h1 className="sr-only">Questions</h1>
      <Filters
        label="Questions, by state"
        options={FILTERS.map((option) => ({ ...option, count: list.counts[option.id] }))}
        active={filter}
        to={(next) => ({ at: "escalations", filter: next, shown: PAGE })}
      />
      {list.rows.length === 0 ? (
        <Nothing title={title} />
      ) : (
        <Rows label="Questions, newest first">
          {list.rows.map((row) => (
            <Row
              key={row.id}
              mark={<EscalationMark state={row.state} />}
              title={
                <EscalationLink id={row.id}>
                  <QuestionTitle id={row.id} fallback={row.question} />
                </EscalationLink>
              }
              meta={
                <>
                  <span className="text-kumo-subtle">{row.label}</span>
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
