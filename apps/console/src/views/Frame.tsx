// The frame every page sits in: which project this is, and the places it has.
// The project is the frame, as a repository is on a code host; everything
// else is a tab of it.

import { Badge } from "@cloudflare/kumo";
import {
  ChartBarIcon,
  CodeIcon,
  GearIcon,
  GitDiffIcon,
  GraphIcon,
  HandPalmIcon,
  type Icon,
  ScalesIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { PAGE } from "../engine/lists.ts";
import { hrefOf } from "../places.ts";
import { type Route, TRUNK } from "../route.ts";
import { Link, useWhere } from "../router.tsx";
import { Footer } from "./Footer.tsx";
import { type Sibling, Switch } from "./Switch.tsx";

export type { Sibling } from "./Switch.tsx";

export type TabId =
  | "code"
  | "changes"
  | "conflicts"
  | "escalations"
  | "mission-control"
  | "insights"
  | "settings";

const HOME: Route = { at: "code", kind: "tree", ref: TRUNK, path: "" };

const TABS: { id: TabId; label: string; Icon: Icon; to: Route }[] = [
  { id: "code", label: "Code", Icon: CodeIcon, to: HOME },
  {
    id: "changes",
    label: "Changes",
    Icon: GitDiffIcon,
    to: { at: "changes", filter: "in-flight", shown: PAGE },
  },
  {
    id: "conflicts",
    label: "Conflicts",
    Icon: ScalesIcon,
    to: { at: "conflicts", filter: "open", shown: PAGE },
  },
  {
    id: "escalations",
    label: "Escalations",
    Icon: HandPalmIcon,
    to: { at: "escalations", filter: "open", shown: PAGE },
  },
  {
    id: "mission-control",
    label: "Mission Control",
    Icon: GraphIcon,
    to: { at: "mission-control" },
  },
  { id: "insights", label: "Insights", Icon: ChartBarIcon, to: { at: "insights", tab: "trunk" } },
  { id: "settings", label: "Settings", Icon: GearIcon, to: { at: "settings" } },
];

/** The tab a place belongs to. A place that names nothing belongs to none. */
export function tabOf(route: Route): TabId | undefined {
  switch (route.at) {
    case "code":
    case "commits":
    case "commit":
      return "code";
    case "changes":
    case "change":
      return "changes";
    case "conflicts":
    case "conflict":
      return "conflicts";
    case "escalations":
    case "escalation":
      return "escalations";
    case "mission-control":
      return "mission-control";
    case "insights":
      return "insights";
    case "settings":
      return "settings";
    default:
      return undefined;
  }
}

export interface OpenCounts {
  changes: number;
  conflicts: number;
  escalations: number;
}

function Count({ tab, counts }: { tab: TabId; counts: OpenCounts }) {
  if (tab !== "changes" && tab !== "conflicts" && tab !== "escalations") return null;
  const count = counts[tab];
  if (count === 0) return null;
  // Orange is for one thing: a person is being asked.
  // The number is what is seen; what it counts is said to whoever cannot see where it stands.
  return (
    <span className={tab === "escalations" ? "a-person-count" : "a-count"}>
      {count.toLocaleString("en-US")}
      <span className="sr-only">{tab === "escalations" ? " waiting for a person" : " open"}</span>
    </span>
  );
}

export interface SourceMark {
  mode: "fixture" | "live";
  seed: number;
  /** Entries of Keel's log that could not be read, where there are any. */
  unread?: number;
}

/** Where what is on screen comes from: Keel, or in development a test fixture, which is never passed off as Keel. */
function Source({ source }: { source: SourceMark }) {
  if (source.mode === "fixture")
    return <Badge variant="outline">{`Test fixture · seed ${source.seed}`}</Badge>;
  const unread = source.unread ?? 0;
  return (
    <span className="flex items-center gap-2 text-sm text-kumo-default">
      <span className="a-live-dot" aria-hidden />
      Live
      {unread > 0 && (
        <span
          className="text-kumo-subtle"
          title="Entries of Keel's log that this console could not read. They are left out of what is shown."
        >
          · {unread.toLocaleString("en-US")} {unread === 1 ? "event" : "events"} not read
        </span>
      )}
    </span>
  );
}

/** Who is reading, where Keel serves accounts: a visitor, or a user by what a page calls them. */
export interface ReaderMark {
  /** Absent for a visitor. */
  name?: string;
  /** The reader's orgs, once Keel has listed them. */
  orgs?: Sibling[];
}

/** The way in for a visitor, which brings them back to this page; for a user, the way to their own settings. */
function ReaderLink({ reader }: { reader: ReaderMark }) {
  if (reader.name !== undefined)
    return (
      <a href={hrefOf({ at: "settings" })} className="text-sm text-kumo-default hover:underline">
        {reader.name}
      </a>
    );
  return (
    <a
      href={hrefOf({ at: "login" }, `${window.location.pathname}${window.location.search}`)}
      className="text-sm text-kumo-default hover:underline"
    >
      Sign in
    </a>
  );
}

export function Frame({
  visibility,
  source,
  counts,
  projects,
  reader,
  settings = false,
  children,
}: {
  /** The projects this reader may go to, where Keel has named them. */
  projects?: Sibling[];
  /** Who is reading. Absent where Keel serves no accounts, and on a test fixture. */
  reader?: ReaderMark;
  /** Whether anyone may read the project, where Keel has said. */
  visibility?: string;
  source: SourceMark;
  /** How many of each are still open. Absent where there is no project to count in. */
  counts?: OpenCounts;
  /** Whether the project's settings are this reader's to change: the Settings tab is offered to them alone. */
  settings?: boolean;
  children: ReactNode;
}) {
  const { org, project, route } = useWhere();
  const active = tabOf(route);
  return (
    <div className="a-root flex h-screen w-screen flex-col overflow-hidden bg-kumo-canvas text-base text-kumo-default">
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
        {/* On a narrow screen the row wraps: who is reading goes under where they are, and nothing is cut off. */}
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-1.5 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
              <path d="M2.5 5h15L10 17.5Z" fill="var(--text-color-kumo-strong)" />
            </svg>
            <a href="/" className="text-base text-kumo-default hover:underline">
              Keel
            </a>
            {project !== "" && (
              <>
                <span className="text-kumo-inactive">/</span>
                {/* The org's own pages are above every project: a plain link, which loads them. */}
                <a
                  href={`/${encodeURIComponent(org)}`}
                  className="text-base text-kumo-default hover:underline"
                >
                  {org}
                </a>
                {reader?.orgs !== undefined && reader.orgs.length > 0 && (
                  <Switch
                    what="org"
                    here={org}
                    others={reader.orgs}
                    all={{ label: "New org", href: hrefOf({ at: "new-org" }) }}
                  />
                )}
                <span className="text-kumo-inactive">/</span>
                <Link
                  to={HOME}
                  className="text-base font-semibold text-kumo-strong hover:underline"
                >
                  {project}
                </Link>
                {projects !== undefined && projects.length > 0 && (
                  <Switch
                    what="project"
                    here={project}
                    others={projects}
                    all={{ label: `All projects of ${org}`, href: `/${encodeURIComponent(org)}` }}
                  />
                )}
              </>
            )}
            {visibility !== undefined && (
              <span className="a-chip" data-tone="quiet">
                {visibility}
              </span>
            )}
          </div>
          <span className="flex items-center gap-4">
            <Source source={source} />
            {reader !== undefined && <ReaderLink reader={reader} />}
          </span>
        </div>
        {counts !== undefined && (
          <nav aria-label="Project" className="a-tabs a-tabs-frame px-4">
            {TABS.filter((tab) => tab.id !== "settings" || settings).map((tab) => (
              // The tab's own page is its list. On a thing in that list, the tab is where the reader is, and not the page they are on.
              <Link
                key={tab.id}
                to={tab.to}
                aria-current={
                  tab.id !== active ? undefined : route.at === tab.to.at ? "page" : "true"
                }
              >
                <tab.Icon size={17} weight={tab.id === active ? "fill" : "regular"} />
                {tab.label}
                <Count tab={tab.id} counts={counts} />
              </Link>
            ))}
          </nav>
        )}
      </header>
      <main className="relative min-h-0 flex-1">{children}</main>
      <Footer />
    </div>
  );
}

/** A page that has nothing to draw says why, in the middle of where it would have been. */
export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-xl font-semibold text-kumo-strong">{title}</h1>
      <p className="max-w-[60ch] text-base text-kumo-subtle">{children}</p>
    </div>
  );
}
