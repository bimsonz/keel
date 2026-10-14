// Small pieces every frame of direction A shares: the console's encodings,
// drawn one way everywhere.

import { CheckIcon, CircleNotchIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { EvidenceClass } from "../contract/mfp.ts";
import type { EvidenceItem, Outcome, Pending, ShownClass } from "../domain/state.ts";

// ─── Outcome ────────────────────────────────────────────────────────────────

const OUTCOME_WORD: Record<Outcome | Pending, string> = {
  pass: "pass",
  fail: "fail",
  "n/a": "n/a",
  running: "running",
  pending: "not run yet",
};

/**
 * One run of a probe: a 44 px mark that carries an icon or the letters "n/a". In the control world a probe
 * is meant to fail, so a fail there is drawn plainly, not in the critical colour.
 */
export function RunMark({
  outcome,
  run,
  size = 44,
  control = false,
}: {
  outcome: Outcome | Pending;
  run: number;
  size?: number;
  control?: boolean;
}) {
  const icon = Math.round(size / 2);
  return (
    <span
      className="a-run"
      data-outcome={outcome}
      data-control={control ? "true" : undefined}
      style={{ width: size, height: size }}
    >
      <span className="sr-only">
        Run {run}: {OUTCOME_WORD[outcome]}
        {control && outcome === "fail" ? ", as it must here" : ""}
      </span>
      {outcome === "pass" && <CheckIcon size={icon} weight="bold" aria-hidden />}
      {outcome === "fail" && <XIcon size={icon} weight="bold" aria-hidden />}
      {outcome === "n/a" && <span aria-hidden>n/a</span>}
      {outcome === "running" && (
        <CircleNotchIcon size={icon - 2} weight="bold" className="a-spin" aria-hidden />
      )}
    </span>
  );
}

/** An outcome as an icon and its word, inline. `n/a` is hollow, hatched and spelled out. */
export function OutcomeWord({ outcome, size = 16 }: { outcome: Outcome | Pending; size?: number }) {
  if (outcome === "n/a") return <span className="a-na">n/a</span>;
  if (outcome === "pass") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-semibold"
        style={{ color: "var(--a-pass-ink)" }}
      >
        <CheckIcon size={size} weight="bold" />
        pass
      </span>
    );
  }
  if (outcome === "fail") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-semibold"
        style={{ color: "var(--a-fail-ink)" }}
      >
        <XIcon size={size} weight="bold" />
        fail
      </span>
    );
  }
  if (outcome === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-kumo-default">
        <CircleNotchIcon size={size} weight="bold" className="a-spin" />
        running
      </span>
    );
  }
  return <span className="text-kumo-subtle">not run yet</span>;
}

// ─── Evidence class ─────────────────────────────────────────────────────────

export const EVIDENCE_ORDER: EvidenceClass[] = ["proof", "ruling", "testimony", "opinion"];

export const EVIDENCE_META: Record<
  EvidenceClass,
  { label: string; weight: string; blocks: boolean }
> = {
  proof: { label: "Proof", weight: "Executed by Keel. Can block.", blocks: true },
  ruling: {
    label: "Ruling",
    weight: "A deterministic judgement, or a person's. Can block.",
    blocks: true,
  },
  testimony: {
    label: "Testimony",
    weight: "A claim from outside Keel. Routes only.",
    blocks: false,
  },
  opinion: { label: "Opinion", weight: "Model output. Routes only.", blocks: false },
};

/** Solid for the classes that can block, hollow for the ones that only route. */
export function ClassMark({
  evidenceClass,
  size = 12,
}: {
  evidenceClass: EvidenceClass;
  size?: number;
}) {
  const common = { width: size, height: size, viewBox: "0 0 12 12", "aria-hidden": true } as const;
  if (evidenceClass === "proof") {
    return (
      <svg {...common}>
        <rect x="1" y="1" width="10" height="10" rx="1.5" fill="currentColor" />
      </svg>
    );
  }
  if (evidenceClass === "ruling") {
    return (
      <svg {...common}>
        <path d="M6 0.4 11.6 6 6 11.6 0.4 6Z" fill="currentColor" />
      </svg>
    );
  }
  if (evidenceClass === "testimony") {
    return (
      <svg {...common}>
        <rect
          x="1.75"
          y="1.75"
          width="8.5"
          height="8.5"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** The class as its mark and its name, written out. */
export function ClassTag({ evidenceClass }: { evidenceClass: EvidenceClass }) {
  const meta = EVIDENCE_META[evidenceClass];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm ${
        meta.blocks ? "font-semibold text-kumo-strong" : "font-normal text-kumo-subtle"
      }`}
    >
      <ClassMark evidenceClass={evidenceClass} />
      {meta.label}
    </span>
  );
}

export function clockTime(iso: string): string {
  return iso.slice(11, 19);
}

/** The day and the time, for a list that may run over more than one day. */
export function dateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${clockTime(iso)}`;
}

/** Evidence grouped by class, heaviest first. Weight is carried by ink, not hue. */
export function EvidenceList({ items }: { items: EvidenceItem[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {EVIDENCE_ORDER.map((evidenceClass) => {
        const group = items.filter((item) => item.class === evidenceClass);
        if (group.length === 0) return null;
        const meta = EVIDENCE_META[evidenceClass];
        return (
          <section key={evidenceClass} className="flex flex-col gap-1.5">
            <header className="flex items-baseline justify-between gap-3">
              <ClassTag evidenceClass={evidenceClass} />
              <span className="text-sm text-kumo-subtle">
                {meta.blocks ? "can block" : "routes only"}
              </span>
            </header>
            <ul className="flex flex-col gap-1.5">
              {group.map((item) => (
                <li
                  key={`${item.ref}:${item.at ?? ""}:${item.summary}`}
                  title={item.detail}
                  className={`rounded-lg px-3 py-1.5 ${
                    meta.blocks ? "bg-kumo-tint" : "border border-dashed border-kumo-line"
                  }`}
                >
                  <p
                    className={`text-base leading-snug ${
                      meta.blocks ? "font-medium text-kumo-strong" : "text-kumo-default"
                    }`}
                  >
                    {item.summary}
                  </p>
                  {(item.by !== "" || item.at !== undefined) && (
                    <p className="mt-0.5 text-sm text-kumo-subtle">
                      {item.by}
                      {item.by !== "" && item.at !== undefined && " · "}
                      {item.at !== undefined && <time className="a-num">{clockTime(item.at)}</time>}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ─── Agent class ────────────────────────────────────────────────────────────

/** The class, written out as it always is beside the mark. */
export const CLASS_WORD: Record<ShownClass, string> = {
  real: "REAL",
  hosted: "HOSTED",
  synthetic: "SYNTHETIC",
  // Keel has not said what it is, so no class is written.
  unnamed: "",
};

/** An agent's name and its class, as one line of a row: "Ada · REAL", or the name alone where no class is known. */
export function agentLine(name: string, agentClass: ShownClass): string {
  return [name, CLASS_WORD[agentClass]].filter((part) => part !== "").join(" · ");
}

/**
 * REAL is ringed, HOSTED is a plain dot, SYNTHETIC is an open square. The class is always written out as well.
 * An agent Keel has not named to this reader is an open dot, with no class written.
 */
export function AgentMark({ agentClass, size = 14 }: { agentClass: ShownClass; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      {agentClass === "unnamed" ? (
        <circle cx="7" cy="7" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      ) : agentClass === "synthetic" ? (
        <rect
          x="3.7"
          y="3.7"
          width="6.6"
          height="6.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      ) : (
        <circle cx="7" cy="7" r="2.6" fill="currentColor" />
      )}
      {agentClass === "real" && (
        <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      )}
    </svg>
  );
}

export function AgentTag({
  label,
  agentClass,
  harness,
}: {
  label: string;
  agentClass: ShownClass;
  harness?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm text-kumo-default"
      title={
        agentClass === "unnamed"
          ? "Keel has not told this reader whether this agent is real, hosted or synthetic."
          : undefined
      }
    >
      <AgentMark agentClass={agentClass} />
      <span className="font-medium text-kumo-strong">{label}</span>
      <span className="text-kumo-subtle">
        {CLASS_WORD[agentClass]}
        {harness === undefined || harness === "" ? "" : ` · ${harness}`}
      </span>
    </span>
  );
}

// ─── Propositions ───────────────────────────────────────────────────────────

/** How a proposition's relation is said in a sentence. One Keel adds later is said by its own name. */
export const RELATION_WORD: Record<string, string> = {
  is: "is",
  "at-most": "at most",
  "at-least": "at least",
  not: "is not",
  before: "before",
  after: "after",
};

/** One proposition on one line: its subject, then what it says of it. */
export function PropositionLine({
  proposition,
}: {
  proposition: {
    subject: string;
    predicate: string;
    relation: string;
    value: string | number | boolean;
    unit?: string | undefined;
  };
}) {
  return (
    <p className="text-base leading-snug text-kumo-strong">
      <span className="a-mono text-kumo-default">{proposition.subject}</span>
      <span className="mx-1.5 text-kumo-inactive">/</span>
      <span className="font-semibold">
        {proposition.predicate} {RELATION_WORD[proposition.relation] ?? proposition.relation}{" "}
        {String(proposition.value)}
        {proposition.unit !== undefined && ` ${proposition.unit}`}
      </span>
    </p>
  );
}

// ─── Layout helpers ─────────────────────────────────────────────────────────

export function Panel({
  title,
  aside,
  children,
  className = "",
  bodyClassName = "p-4",
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`a-panel flex min-h-0 flex-col ${className}`}>
      <header className="a-panel-head shrink-0">
        <h2 className="a-h">{title}</h2>
        {aside !== undefined && (
          <div className="ml-auto flex items-center gap-2 text-sm text-kumo-subtle">{aside}</div>
        )}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

// ─── Unverified ─────────────────────────────────────────────────────────────

/** Verification is switched off for the project: nothing Keel ran stands behind what this marks. */
export function Unverified({ children = "Unverified" }: { children?: string }) {
  return (
    <span
      className="a-chip ml-2 align-middle"
      data-tone="suspected"
      title="Verification is switched off for this project. Nothing Keel ran stands behind this."
    >
      <WarningIcon size={13} weight="fill" />
      {children}
    </span>
  );
}
