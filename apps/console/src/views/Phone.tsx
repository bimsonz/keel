// An escalation on a phone: one question, its options as things to tap, and
// nothing else. It is what a QR code on the console opens.

import { CheckCircleIcon, HandPalmIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { choicesOf, openEscalations } from "../engine/select.ts";
import type { EscalationEntry, World } from "../engine/world.ts";
import { CATEGORY, Ruled } from "./Escalation.tsx";
import { EvidenceList } from "./parts.tsx";

function Question({
  escalation,
  world,
  answerable,
  readOnly,
  onRule,
}: {
  escalation: EscalationEntry;
  world: World;
  answerable: boolean;
  readOnly: string;
  onRule: (escalationId: string, option: string) => Promise<void>;
}) {
  const [sending, setSending] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const waiting = [...world.changes.values()].filter(
    (change) => change.escalationId === escalation.id && change.state === "parked",
  );
  const { choices, standing } = choicesOf(escalation);

  const rule = async (option: string): Promise<void> => {
    setSending(option);
    setRefused(null);
    try {
      await onRule(escalation.id, option);
    } catch (error) {
      setRefused(error instanceof Error ? error.message : "The answer could not be sent.");
    } finally {
      setSending(null);
    }
  };

  return (
    <article className="a-question flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="a-chip" data-tone="person">
            <HandPalmIcon size={13} weight="fill" />
            {escalation.label} · open
          </span>
          <span className="a-chip" data-tone="quiet">
            {CATEGORY[escalation.category]}
          </span>
        </div>
        <h1
          className="text-[24px] font-semibold leading-tight text-kumo-strong"
          style={{ textWrap: "balance" }}
        >
          {escalation.question}
        </h1>
        <p className="text-base text-kumo-default">
          {waiting.length === 0
            ? "Nothing is parked on this."
            : `${waiting.length} ${waiting.length === 1 ? "change is" : "changes are"} parked on this: ${waiting.map((change) => change.label).join(" and ")}.`}{" "}
          Until someone answers: <b className="font-semibold text-kumo-strong">{standing}</b>
        </p>
      </header>

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
              <span className="text-base leading-snug text-kumo-default">{option.consequence}</span>
            </button>
          </li>
        ))}
      </ul>
      {refused !== null && (
        <p role="alert" className="text-base font-medium" style={{ color: "var(--a-fail-ink)" }}>
          {refused}
        </p>
      )}
      {!answerable && <p className="text-sm text-kumo-subtle">{readOnly}</p>}

      <details className="border-t border-kumo-hairline pt-3">
        <summary className="cursor-pointer text-base font-medium text-kumo-strong">
          Evidence, by class
        </summary>
        <div className="pt-3">
          <EvidenceList items={escalation.evidence} />
        </div>
      </details>
    </article>
  );
}

export function Phone({
  world,
  canRule,
  readOnly,
  onRule,
}: {
  world: World;
  canRule: (escalationId: string) => boolean;
  readOnly: string;
  onRule: (escalationId: string, option: string) => Promise<void>;
}) {
  const open = openEscalations(world);
  const ruled = [...world.escalations.values()].filter(
    (escalation) => escalation.state === "ruled",
  );
  const green = world.trunk.redCount === 0;
  return (
    <div className="a-root a-phone">
      <header className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-base font-semibold text-kumo-strong">
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
            <path d="M2.5 5h15L10 17.5Z" fill="var(--text-color-kumo-strong)" />
          </svg>
          Keel
          <span className="font-normal text-kumo-subtle">Mission Control</span>
        </span>
        <span className="flex items-center gap-1.5 text-sm text-kumo-default">
          Trunk red <b className="a-num font-semibold text-kumo-strong">{world.trunk.redCount}</b>
          {green && (
            <CheckCircleIcon
              size={16}
              weight="fill"
              style={{ color: "var(--a-pass)" }}
              aria-label="Trunk is green"
            />
          )}
        </span>
      </header>

      {open.length === 0 ? (
        <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
          <h1 className="text-xl font-semibold text-kumo-strong">
            Nothing is waiting for a person
          </h1>
          <p className="mt-1 text-base text-kumo-default">
            A question arrives here only when proof exists and the answer is a matter of judgement.
          </p>
        </div>
      ) : (
        open.map((escalation) => (
          <Question
            key={escalation.id}
            escalation={escalation}
            world={world}
            answerable={canRule(escalation.id)}
            readOnly={readOnly}
            onRule={onRule}
          />
        ))
      )}

      {ruled.length > 0 && (
        <section>
          <h2 className="pb-1 text-sm font-medium text-kumo-subtle">Answered</h2>
          <ul>
            {ruled.map((escalation) => (
              <Ruled key={escalation.id} escalation={escalation} world={world} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
