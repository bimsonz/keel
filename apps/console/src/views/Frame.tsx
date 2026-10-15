// The frame every page sits in: which project this is, and the places it has.
// The project is the frame, as a repository is on a code host; everything
// else is a tab of it.

import { Badge } from "@cloudflare/kumo";
import {
  ChartBarIcon,
  CodeIcon,
  GearIcon,
  GitPullRequestIcon,
  FlowArrowIcon,
  GraphIcon,
  type Icon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect } from "react";
import { PAGE } from "../engine/lists.ts";
import { hrefOf } from "../places.ts";
import { type Route, TRUNK, href } from "../route.ts";
import { Link, carriedParams, useWhere } from "../router.tsx";
import { type TabId, tabOf, titleOf } from "../tabs.ts";
import { Footer } from "./Footer.tsx";
import { HomeLink } from "./HomeLink.tsx";
import { MAIN, SkipLink } from "./SkipLink.tsx";
import { ReaderMenu } from "./ReaderMenu.tsx";
import { TabBar, TabFace } from "./TabBar.tsx";
import { type Sibling, Switch } from "./Switch.tsx";

export type { Sibling } from "./Switch.tsx";

const HOME: Route = { at: "code", kind: "tree", ref: TRUNK, path: "" };

const TABS: { id: TabId; label: string; Icon: Icon; to: Route }[] = [
  { id: "code", label: "Code", Icon: CodeIcon, to: HOME },
  {
    id: "changes",
    label: "Changes",
    Icon: GitPullRequestIcon,
    to: { at: "changes", filter: "open", shown: PAGE },
  },
  { id: "pipeline", label: "Pipeline", Icon: FlowArrowIcon, to: { at: "pipeline" } },
  {
    id: "mission-control",
    label: "Mission Control",
    Icon: GraphIcon,
    to: { at: "mission-control" },
  },
  { id: "insights", label: "Insights", Icon: ChartBarIcon, to: { at: "insights", tab: "trunk" } },
  { id: "settings", label: "Settings", Icon: GearIcon, to: { at: "settings" } },
];

export interface OpenCounts {
  changes: number;
  conflicts: number;
  escalations: number;
}

/**
 * The Changes tab's counts: how many are open, and beside it, in orange, how many questions wait on a person.
 * Orange is for one thing: a person is being asked. What each number counts is said to whoever cannot see it.
 */
function Count({ tab, counts }: { tab: TabId; counts: OpenCounts }) {
  if (tab !== "changes") return null;
  return (
    <>
      {counts.changes > 0 && (
        <span className="a-count">
          {counts.changes.toLocaleString("en-US")}
          <span className="sr-only"> open</span>
        </span>
      )}
      {counts.escalations > 0 && (
        <span className="a-person-count">
          {counts.escalations.toLocaleString("en-US")}
          <span className="sr-only"> waiting for a person</span>
        </span>
      )}
    </>
  );
}

export interface SourceMark {
  mode: "fixture" | "live";
  seed: number;
  /** Entries of Keel's log that could not be read, where there are any. */
  unread?: number;
}

/** In development a test fixture can stand in for Keel, and is never passed off as Keel. Keel itself is not marked. */
function Source({ source }: { source: SourceMark }) {
  if (source.mode !== "fixture") return null;
  return <Badge variant="outline">{`Test fixture · seed ${source.seed}`}</Badge>;
}

/** Who is reading, where Keel serves accounts: a visitor, or a user by what a page calls them. */
export interface ReaderMark {
  /** Absent for a visitor. */
  name?: string;
  /** The reader's own handle, once they have chosen one. */
  handle?: string;
  /** The reader's orgs, once Keel has listed them. */
  orgs?: Sibling[];
}

export function Frame({
  visibility,
  forkedFrom,
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
  /** The project this one was forked from, where Keel names it to this reader: it names none they may not read. */
  forkedFrom?: { namespace: string; name: string };
  source: SourceMark;
  /** How many of each are still open. Absent until the project's log has been read, and where there is no project. */
  counts?: OpenCounts;
  /** Whether the project's settings are this reader's to change: the Settings tab is offered to them alone. */
  settings?: boolean;
  children: ReactNode;
}) {
  const { namespace, project, route } = useWhere();
  const active = tabOf(route);
  // A project's page is titled as a code host titles a repository's. The pages above every project title their own.
  useEffect(() => {
    if (project !== "") document.title = titleOf(route, namespace, project);
  }, [route, namespace, project]);
  return (
    <div className="a-root flex h-screen w-screen flex-col overflow-hidden bg-kumo-canvas text-base text-kumo-default">
      <SkipLink />
      <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
        {/* On a narrow screen the row wraps: who is reading goes under where they are, and nothing is cut off. */}
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-1.5 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            {/* A code host's frame: its mark home, then whose the project is and the project, each a link to its own page. */}
            <HomeLink named={project === ""} />
            {project !== "" && (
              <>
                {/* The namespace's own page is above every project: a plain link, which loads it. */}
                <a
                  href={hrefOf({ at: "namespace", handle: namespace })}
                  className="text-base text-kumo-default hover:underline"
                >
                  {namespace}
                </a>
                {reader?.orgs !== undefined && reader.orgs.length > 0 && (
                  <Switch
                    what="account"
                    here={namespace}
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
                    all={{
                      label: `All projects of ${namespace}`,
                      href: hrefOf({ at: "namespace", handle: namespace }),
                    }}
                  />
                )}
              </>
            )}
            {visibility !== undefined && (
              <span className="a-chip" data-tone="quiet">
                {visibility}
              </span>
            )}
            {forkedFrom !== undefined && (
              <span className="text-sm text-kumo-subtle" data-part="forked-from">
                forked from {/* Another project's page: a plain link, which loads it. */}
                <a
                  href={href(forkedFrom.namespace, forkedFrom.name, HOME, carriedParams())}
                  className="a-link"
                >
                  {forkedFrom.namespace}/{forkedFrom.name}
                </a>
              </span>
            )}
          </div>
          <span className="flex items-center gap-4">
            <Source source={source} />
            {reader !== undefined && (
              <ReaderMenu
                reader={
                  reader.name === undefined
                    ? { is: "visitor" }
                    : {
                        is: "user",
                        name: reader.name,
                        ...(reader.handle === undefined ? {} : { handle: reader.handle }),
                      }
                }
              />
            )}
          </span>
        </div>
        {/* A project's tabs are drawn as soon as it is found: their counts come once its log has been read. */}
        {project !== "" && (
          <TabBar label="Project">
            {TABS.filter((tab) => tab.id !== "settings" || settings).map((tab) => (
              // The tab's own page is its list. On a thing in that list, the tab is where the reader is, and not the page they are on.
              <Link
                key={tab.id}
                to={tab.to}
                aria-current={
                  tab.id !== active ? undefined : route.at === tab.to.at ? "page" : "true"
                }
              >
                <TabFace
                  Icon={tab.Icon}
                  label={tab.label}
                  open={tab.id === active}
                  count={counts === undefined ? null : <Count tab={tab.id} counts={counts} />}
                />
              </Link>
            ))}
          </TabBar>
        )}
      </header>
      <main id={MAIN} tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
        {children}
      </main>
      <Footer />
    </div>
  );
}

/** A page that has nothing to draw says why, in the middle of where it would have been. */
export function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-xl font-semibold text-kumo-strong">{title}</h1>
      {children !== undefined && (
        <p className="max-w-[60ch] text-base text-kumo-subtle">{children}</p>
      )}
    </div>
  );
}
