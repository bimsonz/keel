// Where in the console an address is. A project is the first segment of the
// path, as a repository is on a code host, and everything the console shows
// has an address under it:
//
//   /P                              the code at trunk's head
//   /P/tree/<ref>/<path>            a directory        /P/blob/<ref>/<path>   a file
//   /P/commits[/<ref>]              history            /P/commit/<sha>        one commit
//   /P/changes                      the changes        /P/changes/<n>[/verification|/files|/alternatives]
//   /P/conflicts                    the conflicts      /P/conflicts/<C-n>[/probe|/evidence]
//   /P/escalations                  the questions      /P/escalations/<E-n>
//   /P/mission-control              the live graph     /P/subjects/<key>      with that subject open
//   /P/insights[/funnel|/benchmark]
//
// `ref` is a commit, or `trunk` for wherever trunk's head is. Nothing here
// touches the browser: `parse` reads an address and `href` writes one.

import {
  CHANGE_FILTERS,
  CONFLICT_FILTERS,
  type ChangeFilter,
  type ConflictFilter,
  ESCALATION_FILTERS,
  type EscalationFilter,
  PAGE,
} from "./engine/lists.ts";

export type ChangeTab = "overview" | "verification" | "files" | "alternatives";
export type ConflictTab = "overview" | "probe" | "evidence";
export type InsightsTab = "trunk" | "funnel" | "benchmark";

export type Route =
  | { at: "code"; kind: "tree" | "blob"; ref: string; path: string }
  | { at: "commits"; ref: string }
  | { at: "commit"; sha: string }
  | { at: "changes"; filter: ChangeFilter; shown: number }
  | { at: "change"; name: string; tab: ChangeTab }
  | { at: "conflicts"; filter: ConflictFilter; shown: number }
  | { at: "conflict"; name: string; tab: ConflictTab }
  | { at: "escalations"; filter: EscalationFilter; shown: number }
  | { at: "escalation"; name: string }
  | { at: "mission-control"; subject?: string }
  | { at: "insights"; tab: InsightsTab }
  /** An address that names nothing the console has. */
  | { at: "missing" };

/** The moving head of trunk, as an address says it. */
export const TRUNK = "trunk";

/**
 * First segments that are never a project, nor an org's handle: Keel answers them (`v1`, `mcp`), the console's
 * Worker does, they are the build's own files, or they are a page above every project (places.ts). Keel refuses
 * each as a handle, so the list is kept the same there. `rule` and `present` go when sessions replace the
 * presenter's key.
 */
export const RESERVED = [
  "api",
  "v1",
  "mcp",
  "assets",
  "healthz",
  "login",
  "signup",
  "logout",
  "device",
  "invite",
  "settings",
  "new",
  "orgs",
  "install",
  "admin",
  "terms",
  "privacy",
  "start",
  "llms.txt",
  ".well-known",
  "robots.txt",
  "favicon.ico",
  "rule",
  "present",
] as const;

const HOME: Route = { at: "code", kind: "tree", ref: TRUNK, path: "" };
const MISSING: Route = { at: "missing" };

const CHANGE_TABS: readonly ChangeTab[] = ["overview", "verification", "files", "alternatives"];
const CONFLICT_TABS: readonly ConflictTab[] = ["overview", "probe", "evidence"];
const INSIGHTS_TABS: readonly InsightsTab[] = ["trunk", "funnel", "benchmark"];

function among<Value extends string>(
  values: readonly Value[],
  given: string | null | undefined,
): Value | undefined {
  return values.find((value) => value === given);
}

/** A list's own parameters: which filter, and how many rows. An unknown filter is the first, and a page is the least shown. */
function listed<Filter extends string>(
  filters: readonly Filter[],
  query: URLSearchParams,
): { filter: Filter; shown: number } | undefined {
  const [first] = filters;
  if (first === undefined) return undefined;
  const shown = Number(query.get("shown"));
  return {
    filter: among(filters, query.get("state")) ?? first,
    shown: Number.isInteger(shown) && shown > PAGE ? shown : PAGE,
  };
}

/** A thing with tabs: its name, then at most one tab, the first of which needs no segment. */
function tabbed<Tab extends string>(
  tabs: readonly Tab[],
  rest: string[],
): { name: string; tab: Tab } | undefined {
  const [name, given, ...more] = rest;
  const [first] = tabs;
  if (name === undefined || first === undefined || more.length > 0) return undefined;
  if (given === undefined) return { name, tab: first };
  const tab = among(tabs.slice(1), given);
  return tab === undefined ? undefined : { name, tab };
}

function routeOf(place: string | undefined, rest: string[], query: URLSearchParams): Route {
  const [first, ...more] = rest;
  switch (place) {
    case undefined:
      return HOME;
    case "tree":
      return first === undefined
        ? MISSING
        : { at: "code", kind: "tree", ref: first, path: more.join("/") };
    case "blob":
      return first === undefined || more.length === 0
        ? MISSING
        : { at: "code", kind: "blob", ref: first, path: more.join("/") };
    case "commits":
      return more.length > 0 ? MISSING : { at: "commits", ref: first ?? TRUNK };
    case "commit":
      return first === undefined || more.length > 0 ? MISSING : { at: "commit", sha: first };
    case "changes": {
      if (first === undefined)
        return {
          at: "changes",
          ...(listed(CHANGE_FILTERS, query) ?? { filter: "in-flight", shown: PAGE }),
        };
      const change = tabbed(CHANGE_TABS, rest);
      return change === undefined ? MISSING : { at: "change", ...change };
    }
    case "conflicts": {
      if (first === undefined)
        return {
          at: "conflicts",
          ...(listed(CONFLICT_FILTERS, query) ?? { filter: "open", shown: PAGE }),
        };
      const conflict = tabbed(CONFLICT_TABS, rest);
      return conflict === undefined ? MISSING : { at: "conflict", ...conflict };
    }
    case "escalations":
      if (first === undefined)
        return {
          at: "escalations",
          ...(listed(ESCALATION_FILTERS, query) ?? { filter: "open", shown: PAGE }),
        };
      return more.length > 0 ? MISSING : { at: "escalation", name: first };
    case "mission-control":
      return first === undefined ? { at: "mission-control" } : MISSING;
    case "subjects":
      return first === undefined || more.length > 0
        ? MISSING
        : { at: "mission-control", subject: first };
    case "insights": {
      if (first === undefined) return { at: "insights", tab: "trunk" };
      const tab = among(INSIGHTS_TABS.slice(1), first);
      return tab === undefined || more.length > 0 ? MISSING : { at: "insights", tab };
    }
    default:
      return MISSING;
  }
}

/** Reads an address. `project` is null where the address does not name one: the bare `/`, or a path that is not a project's. */
export function parse(pathname: string, search: string): { project: string | null; route: Route } {
  let segments: string[];
  try {
    segments = pathname
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    // Not an address anyone was given: a percent sign that encodes nothing.
    return {
      project: pathname.split("/").find((segment) => segment !== "") ?? null,
      route: MISSING,
    };
  }
  const [project, place, ...rest] = segments;
  if (project === undefined) return { project: null, route: HOME };
  if (among(RESERVED, project) !== undefined) return { project: null, route: MISSING };
  return { project, route: routeOf(place, rest, new URLSearchParams(search)) };
}

function pathOf(route: Route): string[] {
  switch (route.at) {
    case "code": {
      const path = route.path === "" ? [] : route.path.split("/");
      return route.kind === "tree" && route.ref === TRUNK && path.length === 0
        ? []
        : [route.kind, route.ref, ...path];
    }
    case "commits":
      return route.ref === TRUNK ? ["commits"] : ["commits", route.ref];
    case "commit":
      return ["commit", route.sha];
    case "changes":
    case "conflicts":
    case "escalations":
    case "mission-control":
      return route.at === "mission-control" && route.subject !== undefined
        ? ["subjects", route.subject]
        : [route.at];
    case "change":
      return ["changes", route.name, ...(route.tab === "overview" ? [] : [route.tab])];
    case "conflict":
      return ["conflicts", route.name, ...(route.tab === "overview" ? [] : [route.tab])];
    case "escalation":
      return ["escalations", route.name];
    case "insights":
      return ["insights", ...(route.tab === "trunk" ? [] : [route.tab])];
    default:
      return [];
  }
}

/** A place's own parameters: a list's filter where it is not the first, and its count where it is more than a page. */
function queryOf(route: Route): string {
  if (route.at !== "changes" && route.at !== "conflicts" && route.at !== "escalations") return "";
  const first: string = route.at === "changes" ? "in-flight" : "open";
  const query = new URLSearchParams();
  if (route.filter !== first) query.set("state", route.filter);
  if (route.shown > PAGE) query.set("shown", String(route.shown));
  return query.toString();
}

/** Writes the address of a place in a project. `carried` is what every link takes with it: see `carriedOf`. */
export function href(project: string, route: Route, carried = ""): string {
  const path = [project, ...pathOf(route)].map((segment) => encodeURIComponent(segment)).join("/");
  const query = [queryOf(route), carried].filter((part) => part !== "").join("&");
  return `/${path}${query === "" ? "" : `?${query}`}`;
}

/** The parameters that choose a test fixture and how it plays. They exist in development only. */
const FIXTURE = ["scenario", "t", "play", "speed", "seed", "ruling", "agents", "seconds"] as const;

/**
 * What every link carries from the address the console was opened at, so that moving about does not change
 * what is being looked at: in development the fixture and the theme, in the built console the theme alone.
 */
export function carriedOf(search: string, development: boolean): string {
  const given = new URLSearchParams(search);
  const carried = new URLSearchParams();
  for (const name of [...(development ? FIXTURE : []), "theme"]) {
    const value = given.get(name);
    if (value !== null) carried.set(name, value);
  }
  return carried.toString();
}
