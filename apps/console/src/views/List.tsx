// The one way the console lists things: a filter with counts, then rows of a
// state mark, a title that opens the thing, a line about it, and what it is
// tied to on the right. Changes, conflicts and escalations are all listed so.

import {
  CheckCircleIcon,
  CircleDashedIcon,
  HandPalmIcon,
  MinusCircleIcon,
  ShieldCheckIcon,
  WarningDiamondIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ChangeState, ConflictState } from "../domain/state.ts";
import { PAGE } from "../engine/lists.ts";
import type { Route } from "../route.ts";
import { Link } from "../router.tsx";

/** A page that scrolls, with its content in one readable column. */
export function Column({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="a-scroll h-full overflow-y-auto">
      <div
        className={`mx-auto flex flex-col gap-4 px-6 py-5 ${wide ? "max-w-[1480px]" : "max-w-[1180px]"}`}
      >
        {children}
      </div>
    </div>
  );
}

export function Filters<Filter extends string>({
  label,
  options,
  active,
  to,
}: {
  label: string;
  options: { id: Filter; label: string; count: number }[];
  active: Filter;
  to: (filter: Filter) => Route;
}) {
  return (
    <nav aria-label={label} className="a-filters">
      {options.map((option) => (
        <Link
          key={option.id}
          to={to(option.id)}
          aria-current={option.id === active ? "true" : undefined}
        >
          {option.label}
          <span className="a-num">{option.count.toLocaleString("en-US")}</span>
        </Link>
      ))}
    </nav>
  );
}

export function Rows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="a-list" aria-label={label}>
      {children}
    </ul>
  );
}

export function Row({
  mark,
  title,
  meta,
  tied,
}: {
  mark: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  tied?: ReactNode;
}) {
  return (
    <li>
      <span className="a-list-mark">{mark}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="a-list-title">{title}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
          {meta}
        </div>
      </div>
      {tied !== undefined && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{tied}</div>
      )}
    </li>
  );
}

/** What is shown of how many, and the way to more. */
export function More({
  shown,
  total,
  more,
  noun,
  to,
}: {
  shown: number;
  total: number;
  more: boolean;
  noun: string;
  to: (shown: number) => Route;
}) {
  if (!more) return null;
  return (
    <p className="flex items-center gap-3 text-sm text-kumo-subtle">
      <span className="a-num">
        {Math.min(shown, total).toLocaleString("en-US")} of {total.toLocaleString("en-US")} {noun}
      </span>
      <Link to={to(shown + PAGE)} className="a-link">
        Show {Math.min(PAGE, total - shown).toLocaleString("en-US")} more
      </Link>
    </p>
  );
}

export function Nothing({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="a-list flex flex-col items-center gap-1.5 px-6 py-12 text-center">
      <h2 className="text-lg font-semibold text-kumo-strong">{title}</h2>
      <p className="max-w-[60ch] text-base text-kumo-subtle">{children}</p>
    </div>
  );
}

// ─── State marks: one per kind of thing, the same wherever it is listed ─────

/** What a state's chip is toned as: orange only where a person is being asked. */
export const CHANGE_TONE: Partial<Record<ChangeState, string>> = {
  parked: "person",
  landed: "guarded",
  bounced: "proven",
};

export function ChangeMark({ state, size = 18 }: { state: ChangeState; size?: number }) {
  if (state === "parked")
    return (
      <HandPalmIcon
        size={size}
        weight="fill"
        style={{ color: "var(--a-person)" }}
        aria-label="Parked: a person is being asked"
      />
    );
  if (state === "landed")
    return (
      <CheckCircleIcon
        size={size}
        weight="fill"
        style={{ color: "var(--a-pass)" }}
        aria-label="Landed"
      />
    );
  if (state === "bounced")
    return (
      <XCircleIcon
        size={size}
        weight="fill"
        style={{ color: "var(--a-fail)" }}
        aria-label="Bounced"
      />
    );
  if (state === "withdrawn" || state === "superseded")
    return (
      <MinusCircleIcon
        size={size}
        className="text-kumo-subtle"
        aria-label={state === "withdrawn" ? "Withdrawn" : "Superseded"}
      />
    );
  return <CircleDashedIcon size={size} className="text-kumo-default" aria-label="In flight" />;
}

/** As everywhere in the console: a conflict a person is being asked about is proven, and reads so. */
export const CONFLICT_TONE: Partial<Record<ConflictState, string>> = {
  suspected: "suspected",
  probing: "suspected",
  proven: "proven",
  escalated: "proven",
};

export function ConflictMark({
  state,
  guarded = false,
  size = 18,
}: {
  state: ConflictState;
  guarded?: boolean;
  size?: number;
}) {
  if (state === "suspected" || state === "probing")
    return (
      <WarningDiamondIcon
        size={size}
        style={{ color: "var(--a-suspected)" }}
        aria-label={state === "probing" ? "Probing" : "Suspected"}
      />
    );
  if (state === "proven" || state === "escalated")
    return (
      <WarningDiamondIcon
        size={size}
        weight="fill"
        style={{ color: "var(--a-fail)" }}
        aria-label="Proven"
      />
    );
  if (state === "resolved") {
    return guarded ? (
      <ShieldCheckIcon
        size={size}
        weight="fill"
        style={{ color: "var(--a-pass)" }}
        aria-label="Resolved, and guarded"
      />
    ) : (
      <CheckCircleIcon
        size={size}
        weight="fill"
        style={{ color: "var(--a-pass)" }}
        aria-label="Resolved"
      />
    );
  }
  return <MinusCircleIcon size={size} className="text-kumo-subtle" aria-label="Dismissed" />;
}

export function EscalationMark({
  state,
  size = 18,
}: {
  state: "open" | "ruled" | "withdrawn";
  size?: number;
}) {
  if (state === "open")
    return (
      <HandPalmIcon
        size={size}
        weight="fill"
        style={{ color: "var(--a-person)" }}
        aria-label="Open: a person is being asked"
      />
    );
  if (state === "ruled")
    return (
      <CheckCircleIcon size={size} weight="fill" className="text-kumo-default" aria-label="Ruled" />
    );
  return <MinusCircleIcon size={size} className="text-kumo-subtle" aria-label="Withdrawn" />;
}
