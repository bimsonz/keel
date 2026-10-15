// Links to the things a project has. A view knows a change, a conflict or an
// escalation by its id; its address calls it by the label Keel gave it. These
// are where the one is turned into the other.

import { type AnchorHTMLAttributes, type ReactNode, createContext, useContext } from "react";
import type { HeldUnder } from "../engine/holder.ts";
import { type Names, namesIn } from "../engine/lists.ts";
import { type Reference, piecesOf, referencesIn } from "../engine/references.ts";
import { usePlayer, useSelected } from "../engine/react.tsx";
import type { ChangeTab, ConflictTab } from "../route.ts";
import { hrefOf } from "../places.ts";
import { Link, useWhere } from "../router.tsx";

const NamesContext = createContext<Names | null>(null);

/** Reads what an address calls each thing once, for every link beneath it. */
export function NamesProvider({ children }: { children: ReactNode }) {
  const names = useSelected(namesIn);
  return <NamesContext.Provider value={names}>{children}</NamesContext.Provider>;
}

function useNames(): Names {
  const names = useContext(NamesContext);
  if (names === null)
    throw new Error(
      "a link to a change, a conflict, an escalation or a decision needs a NamesProvider above it",
    );
  return names;
}

type Anchor = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children"> & {
  children: ReactNode;
};

/** The address of a change's page, by the change's id, for a move made other than by a link. */
export function useChangeAddress(): (id: string) => string {
  const names = useNames();
  const { to } = useWhere();
  return (id) => to({ at: "change", name: names.changes.get(id) ?? id, tab: "overview" });
}

export function ChangeLink({
  id,
  tab = "overview",
  children,
  ...rest
}: { id: string; tab?: ChangeTab } & Anchor) {
  const name = useNames().changes.get(id) ?? id;
  return (
    <Link to={{ at: "change", name, tab }} {...rest}>
      {children}
    </Link>
  );
}

export function ConflictLink({
  id,
  tab = "overview",
  children,
  ...rest
}: { id: string; tab?: ConflictTab } & Anchor) {
  const name = useNames().conflicts.get(id) ?? id;
  return (
    <Link to={{ at: "conflict", name, tab }} {...rest}>
      {children}
    </Link>
  );
}

export function EscalationLink({ id, children, ...rest }: { id: string } & Anchor) {
  const name = useNames().escalations.get(id) ?? id;
  return (
    <Link to={{ at: "escalation", name }} {...rest}>
      {children}
    </Link>
  );
}

/** Whether a decision has a page to open: Keel remembers a project's decisions, and a test fixture has no memory. */
export function useRemembered(): boolean {
  return usePlayer().source.decisions !== undefined;
}

/**
 * A decision's page, where there is one to open; the words alone where there is none, drawn as the link would be,
 * so a chip keeps its tone and its title.
 */
export function DecisionLink({ id, children, ...rest }: { id: string } & Anchor) {
  const name = useNames().decisions.get(id) ?? id;
  if (!useRemembered()) return <span {...rest}>{children}</span>;
  return (
    <Link to={{ at: "decision", name }} {...rest}>
      {children}
    </Link>
  );
}

/**
 * One of Keel's own sentences, as Keel wrote it, with each thing it names by id that this project's log has a
 * label for called by that label: a change, a conflict, an escalation or a decision a link to its page, a guard
 * its label alone, since it has no page of its own.
 */
export function Said({ text }: { text: string }) {
  const known = useSelected(referencesIn);
  return (
    <>
      {piecesOf(text, known).map((piece) =>
        typeof piece === "string" ? piece : <Referred key={piece.at} to={piece} />,
      )}
    </>
  );
}

function Referred({ to }: { to: Reference }) {
  // Drawn in the sentence's own type, as a code host draws a reference it links in text.
  const look = { className: "a-link", title: to.id, "data-ref": to.kind };
  switch (to.kind) {
    case "change":
      return (
        <ChangeLink id={to.id} {...look}>
          {to.label}
        </ChangeLink>
      );
    case "conflict":
      return (
        <ConflictLink id={to.id} {...look}>
          {to.label}
        </ConflictLink>
      );
    case "escalation":
      return (
        <EscalationLink id={to.id} {...look}>
          {to.label}
        </EscalationLink>
      );
    case "decision":
      return (
        <DecisionLink id={to.id} {...look}>
          {to.label}
        </DecisionLink>
      );
    case "guard":
      break;
  }
  return (
    <span className="text-kumo-strong" title={to.id} data-ref={to.kind}>
      {to.label}
    </span>
  );
}

/**
 * The agent that holds a change: its own page, at its handle, as a code host links an author to their profile.
 * The name alone where Keel's card gives it no handle. Its page is above every project: a plain link, which loads it.
 */
export function HolderLink({ held, children, ...rest }: { held: HeldUnder } & Anchor) {
  if (held.handle === undefined) return <span {...rest}>{children}</span>;
  return (
    <a href={hrefOf({ at: "namespace", handle: held.handle })} {...rest}>
      {children}
    </a>
  );
}

/**
 * The run a change is held under, by the agent's own word for the run. Nothing where
 * the holder's token named no run.
 */
export function HeldRun({ held, ...rest }: { held: HeldUnder } & Omit<Anchor, "children">) {
  if (held.run === undefined) return null;
  return (
    <span {...rest}>{held.run.label === undefined ? "unnamed run" : `run ${held.run.label}`}</span>
  );
}

/** A subject is called by its key, in an address as on screen. It opens in Mission Control. */
export function SubjectLink({ subject, children, ...rest }: { subject: string } & Anchor) {
  return (
    <Link to={{ at: "mission-control", subject }} {...rest}>
      {children}
    </Link>
  );
}
