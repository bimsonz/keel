// A namespace's own sections, as a code host lists an owner's under their name: which a reader is offered, and
// where each is. What decides it is what Keel answered: the namespace's kind, whether the handle is the reader's
// own, and the reader's role in an org, which Keel reads only to its members.

import type { NamespaceKind } from "../contract/keel/index.ts";
import { hrefOf } from "../places.ts";
import { type Role, manages } from "./roles.ts";

export type NamespaceTab = "overview" | "projects" | "orgs" | "people" | "credentials" | "settings";

/** Who is reading a namespace's page, as Keel has said. */
export interface NamespaceReading {
  kind: NamespaceKind;
  /** The handle is the reader's own account. */
  own: boolean;
  /** The reader's role in the org, where Keel read them the org as a member's. */
  role?: Role;
}

export const TAB_LABEL: Record<NamespaceTab, string> = {
  overview: "Overview",
  projects: "Projects",
  orgs: "Organizations",
  people: "People",
  credentials: "Credentials",
  settings: "Settings",
};

/**
 * The tabs a reader is offered: anyone has a namespace's overview and the projects Keel names to them in it. A
 * person has their orgs and their settings on their own page; an org's members have its people, its owners its
 * credentials, and whoever may change its settings (an owner or a maintainer) its settings.
 */
export function tabsOf(reading: NamespaceReading): NamespaceTab[] {
  if (reading.kind === "user" && reading.own) return ["overview", "projects", "orgs", "settings"];
  if (reading.kind === "org" && reading.role !== undefined)
    return [
      "overview",
      "projects",
      "people",
      ...(reading.role === "owner" ? (["credentials"] as const) : []),
      ...(manages(reading.role) ? (["settings"] as const) : []),
    ];
  return ["overview", "projects"];
}

/** Where a tab is: the namespace's own address, its projects under it, an org's pages under `/orgs`. */
export function tabHref(handle: string, kind: NamespaceKind, tab: NamespaceTab): string {
  switch (tab) {
    case "overview":
      return hrefOf({ at: "namespace", handle });
    case "projects":
    case "orgs":
      return hrefOf({ at: "namespace", handle, tab });
    case "people":
      return hrefOf({ at: "org", org: handle, tab: "members" });
    case "credentials":
      return hrefOf({ at: "org", org: handle, tab: "credentials" });
    case "settings":
      return kind === "org"
        ? hrefOf({ at: "org", org: handle, tab: "settings" })
        : hrefOf({ at: "settings" });
    default:
      return hrefOf({ at: "namespace", handle });
  }
}
