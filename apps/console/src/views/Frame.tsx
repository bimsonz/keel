// The frame every page sits in: which project this is, and the places it has.
// The project is the frame, as a repository is on a code host; everything
// else is a tab of it.

import { Badge } from "@cloudflare/kumo";
import {
  ChartBarIcon,
  CodeIcon,
  GitDiffIcon,
  GraphIcon,
  HandPalmIcon,
  type Icon,
  ScalesIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { PAGE } from "../engine/lists.ts";
import { type Route, TRUNK } from "../route.ts";
import { Link, useWhere } from "../router.tsx";

export type TabId =
  | "code"
  | "changes"
  | "conflicts"
  | "escalations"
  | "mission-control"
  | "insights";

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
  /** True where Keel does not read its log to this reader. */
  closed?: boolean;
}

/**
 * Where what is on screen comes from: Keel, or in development a test fixture, which is never passed off as Keel.
 * A reader Keel does not read its log to is shown nothing from it, and so nothing here says it is live.
 */
function Source({ source }: { source: SourceMark }) {
  if (source.mode === "fixture")
    return <Badge variant="outline">{`Test fixture · seed ${source.seed}`}</Badge>;
  if (source.closed === true) return null;
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

export function Frame({
  visibility,
  source,
  counts,
  children,
}: {
  /** Whether anyone may read the project, where Keel has said. */
  visibility?: string;
  source: SourceMark;
  /** How many of each are still open. Absent where there is no project to count in. */
  counts?: OpenCounts;
  children: ReactNode;
}) {
  const { project, route } = useWhere();
  const active = tabOf(route);
  return (
    <div className="a-root flex h-screen w-screen flex-col overflow-hidden bg-kumo-canvas text-base text-kumo-default">
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
        <div className="flex h-12 items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
              <path d="M2.5 5h15L10 17.5Z" fill="var(--text-color-kumo-strong)" />
            </svg>
            <span className="text-base text-kumo-default">Keel</span>
            {project !== "" && (
              <>
                <span className="text-kumo-inactive">/</span>
                <Link
                  to={HOME}
                  className="text-base font-semibold text-kumo-strong hover:underline"
                >
                  {project}
                </Link>
              </>
            )}
            {visibility !== undefined && (
              <span className="a-chip" data-tone="quiet">
                {visibility}
              </span>
            )}
          </div>
          <Source source={source} />
        </div>
        {counts !== undefined && (
          <nav aria-label="Project" className="a-tabs a-tabs-frame px-4">
            {TABS.map((tab) => (
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
