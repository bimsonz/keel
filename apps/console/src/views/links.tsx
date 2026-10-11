// Links to the things a project has. A view knows a change, a conflict or an
// escalation by its id; its address calls it by the label Keel gave it. These
// are where the one is turned into the other.

import { type AnchorHTMLAttributes, type ReactNode, createContext, useContext } from "react";
import { type Names, namesIn } from "../engine/lists.ts";
import { useSelected } from "../engine/react.tsx";
import type { ChangeTab, ConflictTab } from "../route.ts";
import { Link } from "../router.tsx";

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
      "a link to a change, a conflict or an escalation needs a NamesProvider above it",
    );
  return names;
}

type Anchor = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children"> & {
  children: ReactNode;
};

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

/** A subject is called by its key, in an address as on screen. It opens in Mission Control. */
export function SubjectLink({ subject, children, ...rest }: { subject: string } & Anchor) {
  return (
    <Link to={{ at: "mission-control", subject }} {...rest}>
      {children}
    </Link>
  );
}
