// The bar of tabs under a page's header, as a code host has one under a repository's name and under an owner's:
// one bar, drawn the same wherever it is, for a project's places and for a namespace's sections alike.

import type { Icon } from "@phosphor-icons/react";
import { type ReactNode, createContext } from "react";

export function TabBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="a-tabs a-tabs-frame px-4">
      {children}
    </nav>
  );
}

/** What a tab shows: its icon, filled where the reader is, its name, and how many it holds where it says. */
export function TabFace({
  Icon,
  label,
  open,
  count,
}: {
  Icon: Icon;
  label: string;
  open: boolean;
  count?: ReactNode;
}) {
  return (
    <>
      <Icon size={17} weight={open ? "fill" : "regular"} />
      {label}
      {count}
    </>
  );
}

/**
 * Where a page's tab bar goes in its header, for a page whose header is drawn around it: the pages above every
 * project have one header, and each page knows its own tabs only once Keel has answered.
 */
export const TabSlot = createContext<HTMLElement | null>(null);
