// One subject, opened beside the live graph: what is relied on there, the conflicts
// on it, what guards it, what has been decided, and the changes open on it.

import { HandPalmIcon, ShieldCheckIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ConflictState } from "../domain/state.ts";
import type { Tone } from "../engine/lanes.ts";
import type { SubjectDetail } from "../engine/subject.ts";
import { PAGE } from "../engine/lists.ts";
import { Link } from "../router.tsx";
import { ChangeLink, ConflictLink } from "./links.tsx";
import { AgentMark, agentLine, clockTime } from "./parts.tsx";

const STANDING: Record<Tone, string> = {
  person: "a person is being asked",
  proven: "a conflict is proven",
  suspected: "contested",
  pass: "guarded",
  plain: "calm",
};

// As on the graph: a conflict a person is being asked about is proven, and reads so. Orange is the question's.
const CONFLICT_TONE: Partial<Record<ConflictState, string>> = {
  suspected: "suspected",
  probing: "suspected",
  proven: "proven",
  escalated: "proven",
};

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-kumo-hairline px-5 py-4">
      <header className="flex items-baseline justify-between gap-3 pb-2">
        <h3 className="a-h">{title}</h3>
        {aside !== undefined && <span className="text-sm text-kumo-subtle">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

const NONE = "text-sm text-kumo-subtle";

export function SubjectPanel({ detail }: { detail: SubjectDetail }) {
  const live = detail.premises.reduce((sum, premise) => sum + premise.live, 0);
  const landed = detail.premises.reduce((sum, premise) => sum + premise.landed, 0);
  const open = detail.conflicts.filter(
    (conflict) => conflict.state !== "resolved" && conflict.state !== "dismissed",
  ).length;
  const unlisted = detail.changes.total - detail.changes.listed.length;
  return (
    <aside className="a-subject a-scroll" aria-label={`Subject ${detail.key}`}>
      <header className="flex items-start gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="a-fn-kind">Subject</p>
          <h2 className="a-mono break-all text-lg font-semibold text-kumo-strong">{detail.key}</h2>
          <p className="mt-0.5 text-base text-kumo-default">{detail.gloss}</p>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className="a-chip"
              data-tone={
                detail.tone === "pass" ? "guarded" : detail.tone === "plain" ? "quiet" : detail.tone
              }
            >
              {detail.tone === "person" && <HandPalmIcon size={13} weight="fill" />}
              {detail.tone === "pass" && <ShieldCheckIcon size={13} weight="fill" />}
              {STANDING[detail.tone]}
            </span>
            {detail.tenets > 0 && (
              <span className="text-sm text-kumo-subtle">{plural(detail.tenets, "tenet")}</span>
            )}
          </p>
        </div>
        <Link
          to={{ at: "mission-control" }}
          className="a-icon-button"
          aria-label="Close the subject"
        >
          <XIcon size={16} />
        </Link>
      </header>

      <Section
        title="Premises"
        aside={`${plural(live, "change")} open · ${landed.toLocaleString("en-US")} landed`}
      >
        {detail.premises.length === 0 ? (
          <p className={NONE}>Nothing relies on this subject yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {detail.premises.map((premise) => (
              <li
                key={`${premise.predicate} ${premise.relation} ${premise.value}`}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="text-base text-kumo-strong">
                  {premise.predicate} {premise.relation.replace("-", " ")}{" "}
                  <b className="font-semibold">{premise.value}</b>
                </span>
                <span className="a-num shrink-0 text-sm text-kumo-subtle">
                  {premise.live.toLocaleString("en-US")} open ·{" "}
                  {premise.landed.toLocaleString("en-US")} landed
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Conflicts"
        aside={
          detail.conflicts.length === 0
            ? undefined
            : `${open} open · ${detail.conflicts.length - open} settled`
        }
      >
        {detail.conflicts.length === 0 ? (
          <p className={NONE}>No two changes have disagreed here.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.conflicts.map((conflict) => (
              <li key={conflict.id}>
                <ConflictLink id={conflict.id} className="a-subject-row">
                  <span className="flex items-center gap-2">
                    <b className="font-semibold text-kumo-strong">{conflict.label}</b>
                    <span className="a-chip" data-tone={CONFLICT_TONE[conflict.state] ?? "quiet"}>
                      {conflict.state === "escalated" ? "proven" : conflict.state}
                    </span>
                    <span className="text-sm text-kumo-subtle">{conflict.kind}</span>
                    <time className="a-num ml-auto text-sm text-kumo-subtle">
                      {clockTime(conflict.openedAt)}
                    </time>
                  </span>
                  <span className="text-sm leading-snug text-kumo-default">{conflict.summary}</span>
                </ConflictLink>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Guards">
        {detail.guards.length === 0 ? (
          <p className={NONE}>No probe has been admitted as a guard here.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {detail.guards.map((guard) => (
              <li key={guard.id} className="flex items-baseline gap-2 text-base">
                <ShieldCheckIcon
                  size={15}
                  weight="fill"
                  className="translate-y-0.5"
                  style={{
                    color: guard.state === "admitted" ? "var(--a-pass)" : "var(--a-na-line)",
                  }}
                />
                <b className="font-semibold text-kumo-strong">{guard.label}</b>
                <span className="text-sm text-kumo-default">
                  {guard.state}, from probe {guard.probe} of conflict {guard.conflict}
                </span>
                <time className="a-num ml-auto text-sm text-kumo-subtle">
                  {clockTime(guard.admittedAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Decisions">
        {detail.decisions.length === 0 ? (
          <p className={NONE}>No person has ruled on this subject.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {detail.decisions.map((decision) => (
              <li key={decision.id} className="flex items-baseline gap-2 text-base">
                <b className="font-semibold text-kumo-strong">{decision.label}</b>
                <span className="min-w-0 text-sm text-kumo-default">
                  {decision.chosen}
                  {decision.state !== "active" && ` (${decision.state})`}
                </span>
                <time className="a-num ml-auto shrink-0 text-sm text-kumo-subtle">
                  {clockTime(decision.decidedAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Changes" aside={`${detail.changes.total.toLocaleString("en-US")} open`}>
        {detail.changes.total === 0 ? (
          <p className={NONE}>No change is open on this subject.</p>
        ) : (
          <>
            <p className="pb-2 text-sm text-kumo-default">
              {detail.changes.byState.map(([state, count]) => `${count} ${state}`).join(" · ")}
            </p>
            <ul className="flex flex-col gap-1">
              {detail.changes.listed.map((change) => (
                <li key={change.id}>
                  <ChangeLink id={change.id} className="a-subject-row">
                    <span className="flex items-center gap-2">
                      <b className="a-mono font-semibold text-kumo-strong">{change.label}</b>
                      <span className="min-w-0 truncate text-sm text-kumo-default">
                        {change.goal}
                      </span>
                      <span
                        className="a-chip ml-auto"
                        data-tone={
                          change.state === "parked"
                            ? "person"
                            : change.state === "bounced"
                              ? "proven"
                              : "quiet"
                        }
                      >
                        {change.state}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
                      <AgentMark agentClass={change.agentClass} size={12} />
                      {agentLine(change.agent, change.agentClass)}
                    </span>
                  </ChangeLink>
                </li>
              ))}
            </ul>
            {unlisted > 0 && (
              <p className="pt-2 text-sm text-kumo-subtle">
                and {plural(unlisted, "more change")}, in{" "}
                <Link to={{ at: "changes", filter: "in-flight", shown: PAGE }} className="a-link">
                  Changes
                </Link>
              </p>
            )}
          </>
        )}
      </Section>
    </aside>
  );
}
