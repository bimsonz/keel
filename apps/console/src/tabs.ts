// A project's tabs, as a code host has a repository's: Code, Issues, Changes (its pull requests), Pipeline (its runs),
// Mission Control, Insights and Settings. Keel's own lists that a code host has no tab for are Insights' pages:
// its decisions, its conflicts and the questions put to a person. A conflict and a question are about changes,
// so their own pages are the Changes tab's, as a code host's merge conflicts and review threads are a pull
// request's. Nothing here touches the browser.

import type { Route } from "./route.ts";

export type TabId =
  | "code"
  | "issues"
  | "changes"
  | "pipeline"
  | "mission-control"
  | "insights"
  | "settings";

/** The tab a place belongs to. A place that names nothing belongs to none. */
export function tabOf(route: Route): TabId | undefined {
  switch (route.at) {
    case "code":
    case "commits":
    case "commit":
      return "code";
    case "issues":
    case "issue":
    case "new-issue":
      return "issues";
    case "changes":
    case "change":
    case "conflict":
    case "escalation":
      return "changes";
    case "pipeline":
      return "pipeline";
    case "mission-control":
      return "mission-control";
    case "insights":
    case "decisions":
    case "decision":
    case "conflicts":
    case "escalations":
      return "insights";
    case "settings":
      return "settings";
    default:
      return undefined;
  }
}

/** A place's own words, before the project's name: what a browser's tab and its history call the page. */
function placeTitle(route: Route): string | undefined {
  switch (route.at) {
    case "code":
      return route.kind === "tree" && route.path === "" ? undefined : route.path;
    case "commits":
      return "Commits";
    case "commit":
      return `Commit ${route.sha.slice(0, 7)}`;
    case "issues":
      return "Issues";
    case "issue":
      return `Issue #${route.number}`;
    case "new-issue":
      return "New issue";
    case "changes":
      return "Changes";
    case "change":
      return `Change #${route.name}`;
    case "conflicts":
      return "Conflicts";
    case "conflict":
      return `Conflict ${route.name}`;
    case "escalations":
      return "Questions";
    case "escalation":
      return `Question ${route.name}`;
    case "decisions":
      return "Decisions";
    case "decision":
      return `Decision ${route.name}`;
    case "pipeline":
      return "Pipeline";
    case "mission-control":
      return "Mission Control";
    case "insights":
      return "Insights";
    case "settings":
      return "Settings";
    default:
      return "Not found";
  }
}

/** A page's title, as a code host titles a repository's: the place, then `namespace/project`. */
export function titleOf(route: Route, namespace: string, project: string): string {
  const repository = `${namespace}/${project}`;
  const place = placeTitle(route);
  return place === undefined ? repository : `${place} · ${repository}`;
}
