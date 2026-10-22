// The project's changes, listed as a code host lists pull requests: open and closed in the list's own header,
// the narrower filters beside them, and a row for each change with its state, who opened it and what it waits on.

import {
  CircleNotchIcon,
  ClockIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HandPalmIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ParkReason } from "../contract/keel/index.ts";
import type { ChangeState } from "../domain/state.ts";
import { pillOf } from "../engine/checks.ts";
import { type ChangeFilter, PAGE, changesOf } from "../engine/lists.ts";
import { useHolderCards, useSelected } from "../engine/react.tsx";
import { Link } from "../router.tsx";
import { CONFLICT_TONE, Column, More, Nothing, Row } from "../views/List.tsx";
import { ChangeLink, ConflictLink, EscalationLink, HolderLink, HeldRun } from "../views/links.tsx";
import { AgentMark, Unverified, agentLine, dateTime } from "../views/parts.tsx";

/** Open and closed, as a code host's list heads its pull requests. */
const MAIN: { id: ChangeFilter; label: string; Icon: typeof GitPullRequestIcon }[] = [
  { id: "open", label: "Open", Icon: GitPullRequestIcon },
  { id: "closed", label: "Closed", Icon: GitMergeIcon },
];

/** The narrower filters beside them. */
const NARROW: { id: ChangeFilter; label: string }[] = [
  { id: "proposals", label: "Proposals" },
  { id: "parked", label: "Waiting on a ruling" },
  { id: "bounced", label: "Bounced" },
  { id: "landed", label: "Landed" },
];

const EMPTY: Record<ChangeFilter, string> = {
  open: "No open changes",
  closed: "No closed changes",
  landed: "No landed changes",
  parked: "No changes waiting on a ruling",
  bounced: "No bounced changes",
  proposals: "No open proposals from forks",
};

/** Where an open change stands, in a word or two, as a code host labels a pull request's status. */
const OPEN_LABEL: Partial<Record<ChangeState, { label: string; tone?: string }>> = {
  declared: { label: "Not pushed" },
  working: { label: "Not pushed" },
  submitted: { label: "Deriving" },
  deriving: { label: "Deriving" },
  drifted: { label: "Drifted", tone: "suspected" },
  queued: { label: "Queued" },
  verifying: { label: "Checks running" },
  integrating: { label: "Landing" },
  parked: { label: "Waiting on a ruling", tone: "person" },
  bounced: { label: "Bounced", tone: "proven" },
};

/** The mark beside a row: open, landed or closed, in a code host's colours. */
function PullMark({ state }: { state: ChangeState }) {
  const pill = pillOf(state);
  if (pill === "landed")
    return <GitMergeIcon size={18} weight="bold" className="a-mark-landed" aria-label="Landed" />;
  return (
    <GitPullRequestIcon
      size={18}
      weight="bold"
      className={pill === "open" ? "a-mark-open" : "a-mark-closed"}
      aria-label={pill === "open" ? "Open" : "Closed"}
    />
  );
}

/** A change parked because its agent's lease lapsed waits on its agent, not on a person. */
const AGENT_LAPSED = { label: "Waiting on its agent" };

/** A proposal from a fork waits for a maintainer's review, as a code host labels a pull request awaiting one. */
const REVIEW_REQUIRED = { label: "Review required", tone: "person" };

/** What an open change waits on, beside its row: its checks, a ruling, a review, or its agent. */
function Waiting({ state, parkedOn }: { state: ChangeState; parkedOn?: ParkReason }) {
  const reviewed = state === "parked" && parkedOn === "awaiting-approval";
  const lapsed = state === "parked" && parkedOn === "lease-lapsed";
  const shown = reviewed ? REVIEW_REQUIRED : lapsed ? AGENT_LAPSED : OPEN_LABEL[state];
  if (shown === undefined) return null;
  return (
    <span className="a-chip" data-tone={"tone" in shown ? shown.tone : "quiet"}>
      {state === "verifying" || state === "integrating" ? (
        <CircleNotchIcon size={12} className="a-spin" />
      ) : state === "parked" && !lapsed ? (
        <HandPalmIcon size={12} weight="fill" />
      ) : state === "bounced" ? (
        <XCircleIcon size={12} weight="fill" />
      ) : (
        <ClockIcon size={12} />
      )}
      {shown.label}
    </span>
  );
}

export function ChangesPage({ filter, shown }: { filter: ChangeFilter; shown: number }) {
  // While the log is read, the list is drawn from Keel's snapshot of its head, where a world folded part way
  // would show each change as it stood when its last entry read so far was written.
  const list = useSelected(
    (world, from) => changesOf(from.seeded ?? world, filter, shown, from.cards),
    [filter, shown],
  );
  useHolderCards(list.rows.map((row) => row.id));
  return (
    <Column>
      <h1 className="sr-only">Changes</h1>
      <section className="a-boxed" aria-label="Changes">
        <header className="a-list-head">
          <nav aria-label="Open or closed" className="flex items-center gap-4">
            {MAIN.map(({ id, label, Icon }) => (
              <Link
                key={id}
                to={{ at: "changes", filter: id, shown: PAGE }}
                aria-current={id === filter ? "true" : undefined}
              >
                <Icon size={16} weight="bold" />
                <span className="a-num">{list.counts[id].toLocaleString("en-US")}</span> {label}
              </Link>
            ))}
          </nav>
          <nav aria-label="Filters" className="flex flex-wrap items-center gap-3">
            {NARROW.map(({ id, label }) => (
              <Link
                key={id}
                to={{ at: "changes", filter: id, shown: PAGE }}
                aria-current={id === filter ? "true" : undefined}
                {...(id === "parked" && list.counts.parked > 0 ? { "data-tone": "person" } : {})}
              >
                {label} <span className="a-num">{list.counts[id].toLocaleString("en-US")}</span>
              </Link>
            ))}
          </nav>
        </header>
        {list.rows.length === 0 ? (
          <Nothing title={EMPTY[filter]} />
        ) : (
          <ul className="a-list" aria-label="Changes, newest first">
            {list.rows.map((row) => (
              <Row
                key={row.id}
                mark={<PullMark state={row.state} />}
                title={<ChangeLink id={row.id}>{row.goal}</ChangeLink>}
                meta={
                  <>
                    <span className="a-num">{row.label}</span>
                    <span>
                      opened <time className="a-num">{dateTime(row.declaredAt)}</time> by
                    </span>
                    <HolderLink
                      held={row.held}
                      className="a-link-quiet inline-flex items-center gap-1.5"
                    >
                      <AgentMark agentClass={row.agentClass} size={12} />
                      {agentLine(row.agent, row.agentClass)}
                    </HolderLink>
                    <HeldRun held={row.held} className="a-link-quiet" />
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
                    {row.escalation?.open === true && (
                      <EscalationLink
                        id={row.escalation.id}
                        className="a-chip"
                        data-tone="person"
                        title={`Question ${row.escalation.label}`}
                      >
                        <HandPalmIcon size={12} weight="fill" />
                        {row.escalation.label}
                      </EscalationLink>
                    )}
                    {row.unverified && <Unverified />}
                    <Waiting
                      state={row.state}
                      {...(row.parkedOn === undefined ? {} : { parkedOn: row.parkedOn })}
                    />
                  </>
                }
              />
            ))}
          </ul>
        )}
      </section>
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
