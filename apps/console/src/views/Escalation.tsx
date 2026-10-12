// One escalation: a question, not a change to read. What is being asked, what
// each answer costs, and the evidence behind it. One tap answers it, and the
// answer becomes a decision.

import { CheckCircleIcon, HandPalmIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { EscalationCategory } from "../contract/events.ts";
import { choicesOf } from "../engine/select.ts";
import type { EscalationEntry, World } from "../engine/world.ts";
import { Detail, Head, Tied } from "./Detail.tsx";
import { CHANGE_TONE, CONFLICT_TONE } from "./List.tsx";
import { Qr } from "./Qr.tsx";
import { ChangeLink, ConflictLink, SubjectLink } from "./links.tsx";
import { EvidenceList, Panel, clockTime, dateTime } from "./parts.tsx";

export const CATEGORY: Record<EscalationCategory, string> = {
  "permission-semantics": "Permission semantics",
  "destructive-migration": "Destructive migration",
  "ambiguous-requirement": "Ambiguous requirement",
  "unprovable-conflict": "Unprovable conflict",
  "overrule-request": "Overrule request",
  "frozen-trunk": "Trunk frozen",
};

/** A question already answered, in a line: what a phone shows beneath the open one. */
export function Ruled({ escalation, world }: { escalation: EscalationEntry; world: World }) {
  const chosen = escalation.options.find((option) => option.id === escalation.ruling?.option);
  const decision = [...world.decisions.values()].find(
    (candidate) => candidate.question === escalation.question,
  );
  return (
    <li className="flex items-baseline gap-3 border-t border-kumo-hairline px-1 py-3 text-base">
      <CheckCircleIcon size={18} weight="fill" className="translate-y-0.5 text-kumo-subtle" />
      <span className="min-w-0 flex-1">
        <b className="font-semibold text-kumo-strong">{escalation.label}</b> {escalation.question}
        <span className="block text-kumo-default">
          Ruled:{" "}
          <b className="font-semibold text-kumo-strong">
            {chosen?.label ?? escalation.ruling?.option}
          </b>
          {decision !== undefined && `. Recorded as Decision ${decision.label}.`}
        </span>
      </span>
      <time className="a-num text-sm text-kumo-subtle">
        {clockTime(escalation.ruling?.at ?? escalation.raisedAt)}
      </time>
    </li>
  );
}

export function Escalation({
  escalation,
  world,
  answerable,
  readOnly,
  phoneUrl,
  onRule,
}: {
  escalation: EscalationEntry;
  world: World;
  /** False when this console may not rule on it. `readOnly` says why. */
  answerable: boolean;
  readOnly: string;
  /** Where a phone can answer this question, when there is a way for it to. */
  phoneUrl?: string;
  onRule: (escalationId: string, option: string) => Promise<void>;
}) {
  const [sending, setSending] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const open = escalation.state === "open";
  const conflict =
    escalation.about.kind === "conflict" ? world.conflicts.get(escalation.about.id) : undefined;
  const subject =
    conflict?.subjectId === undefined ? undefined : world.subjects.get(conflict.subjectId);
  const tied = [...world.changes.values()].filter(
    (change) => change.escalationId === escalation.id,
  );
  const waiting = tied.filter((change) => change.state === "parked");
  const { choices, standing } = choicesOf(escalation);
  const precedents = escalation.precedents.flatMap((id) => world.decisions.get(id) ?? []);
  const chosen = escalation.options.find((option) => option.id === escalation.ruling?.option);
  const decision =
    (conflict?.decisionId === undefined ? undefined : world.decisions.get(conflict.decisionId)) ??
    [...world.decisions.values()].find((candidate) => candidate.question === escalation.question);

  const rule = async (option: string): Promise<void> => {
    setSending(option);
    setRefused(null);
    try {
      await onRule(escalation.id, option);
    } catch (error) {
      // A ruling Keel would not take is said, and the question stays open to be answered again.
      setRefused(error instanceof Error ? error.message : "The answer could not be sent.");
    } finally {
      setSending(null);
    }
  };

  return (
    <Detail>
      <Head
        title={escalation.question}
        label={escalation.label}
        state={
          <span className="a-chip" data-tone={open ? "person" : "quiet"}>
            {open && <HandPalmIcon size={13} weight="fill" />}
            {escalation.state}
          </span>
        }
        meta={
          <>
            <span>{CATEGORY[escalation.category]}</span>
            {subject !== undefined && (
              <span>
                on{" "}
                <SubjectLink subject={subject.key} className="a-mono a-link-quiet font-medium">
                  {subject.key}
                </SubjectLink>
              </span>
            )}
            <span>
              asked <time className="a-num text-kumo-default">{dateTime(escalation.raisedAt)}</time>
            </span>
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-4">
          {open ? (
            <section className="a-question flex flex-col gap-4 p-5" aria-label="Answer">
              <p className="text-base text-kumo-default">
                {waiting.length === 0
                  ? "Nothing is parked on this."
                  : `${waiting.length} ${waiting.length === 1 ? "change is" : "changes are"} parked on this: ${waiting.map((change) => change.label).join(" and ")}.`}{" "}
                Until someone answers: <b className="font-semibold text-kumo-strong">{standing}</b>
              </p>
              <ul className="flex flex-col gap-2.5">
                {choices.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      className="a-option"
                      disabled={!answerable || sending !== null}
                      aria-busy={sending === option.id}
                      onClick={() => void rule(option.id)}
                    >
                      <span className="text-lg font-semibold leading-snug text-kumo-strong">
                        {option.label}
                      </span>
                      <span className="text-base leading-snug text-kumo-default">
                        {option.consequence}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {refused !== null && (
                <p
                  role="alert"
                  className="text-base font-medium"
                  style={{ color: "var(--a-fail-ink)" }}
                >
                  Keel did not take that answer: {refused} The question is still open.
                </p>
              )}
              {!answerable && <p className="text-sm text-kumo-subtle">{readOnly}</p>}
              {phoneUrl !== undefined && (
                <div className="flex items-center gap-4 rounded-lg border border-kumo-hairline p-3">
                  <Qr
                    text={phoneUrl}
                    size={132}
                    label="QR code: answer this question from a phone"
                  />
                  <p className="text-base leading-snug text-kumo-default">
                    <b className="font-semibold text-kumo-strong">Answer from a phone.</b> Scan this
                    to open the question there. It is this page's own address and nothing more:
                    whoever opens it signs in, and Keel decides whether they may answer.{" "}
                    <a className="a-link break-all" href={phoneUrl}>
                      {phoneUrl}
                    </a>
                  </p>
                </div>
              )}
            </section>
          ) : (
            <section className="a-verdict flex flex-col gap-1.5 px-5 py-4" aria-label="Ruling">
              <h2 className="text-2xl font-semibold leading-tight text-kumo-strong">
                {escalation.state === "ruled"
                  ? `Ruled: ${chosen?.label ?? escalation.ruling?.option ?? ""}`
                  : "Withdrawn before anyone answered"}
              </h2>
              {chosen !== undefined && (
                <p className="text-lg text-kumo-default">{chosen.consequence}</p>
              )}
              <p className="text-sm text-kumo-subtle">
                {escalation.ruling !== undefined && (
                  <>
                    Answered <time className="a-num">{dateTime(escalation.ruling.at)}</time>.{" "}
                  </>
                )}
                {decision !== undefined &&
                  `Recorded as decision ${decision.label}: later changes meet it as precedent.`}
              </p>
              {escalation.state === "ruled" && (
                <ul className="mt-2 flex flex-col gap-1 border-t border-kumo-line pt-3 text-base">
                  {choices
                    .filter((option) => option.id !== chosen?.id)
                    .map((option) => (
                      <li key={option.id} className="text-kumo-subtle">
                        Not chosen: <span className="text-kumo-default">{option.label}</span>
                      </li>
                    ))}
                </ul>
              )}
            </section>
          )}

          {precedents.length > 0 && (
            <Panel
              title="Precedents"
              aside="decided before, and bearing on this"
              bodyClassName="p-2"
            >
              <ul>
                {precedents.map((precedent) => (
                  <li key={precedent.id} className="px-3 py-2 text-base">
                    <b className="font-semibold text-kumo-strong">{precedent.label}</b>{" "}
                    {precedent.chosen}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Evidence" aside="by class" bodyClassName="p-3.5">
            {escalation.evidence.length === 0 ? (
              <p className="text-base text-kumo-subtle">
                Keel gave no evidence with this question.
              </p>
            ) : (
              <EvidenceList items={escalation.evidence} />
            )}
          </Panel>
          <aside className="a-side">
            {conflict !== undefined && (
              <Tied title="Raised by">
                <span className="flex flex-wrap items-center gap-2">
                  <ConflictLink id={conflict.id} className="a-link font-semibold">
                    {conflict.label}
                  </ConflictLink>
                  <span className="a-chip" data-tone={CONFLICT_TONE[conflict.state] ?? "quiet"}>
                    {conflict.state === "escalated" ? "proven" : conflict.state}
                  </span>
                </span>
                <span className="leading-snug">{conflict.title}</span>
              </Tied>
            )}
            {tied.length > 0 && (
              <Tied title="Changes">
                {tied.map((change) => (
                  <span key={change.id} className="flex flex-wrap items-center gap-2">
                    <ChangeLink id={change.id} className="a-mono a-link font-semibold">
                      {change.label}
                    </ChangeLink>
                    <span className="min-w-0 flex-1 truncate">{change.goal}</span>
                    <span className="a-chip" data-tone={CHANGE_TONE[change.state] ?? "quiet"}>
                      {change.state}
                    </span>
                  </span>
                ))}
              </Tied>
            )}
          </aside>
        </div>
      </div>
    </Detail>
  );
}
