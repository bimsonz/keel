// Where in the console an address is. A namespace's handle is the first segment
// of the path and a project's name the second, as an owner and a repository
// are on a code host. A namespace is a person's, an agent's or an org's. `/` is
// the home, `/N` a namespace's own, and everything a project has is under
// `/N/P`, written P below:
//
//   P                              the code at trunk's head
//   P/tree/<ref>/<path>            a directory        P/blob/<ref>/<path>   a file
//   P/commits[/<ref>]              history            P/commit/<sha>        one commit
//   P/changes                      the changes        P/changes/<n>[/checks|/files|/alternatives]
//   P/conflicts                    the conflicts      P/conflicts/<C-n>[/probe|/evidence]
//   P/escalations                  the questions      P/escalations/<E-n>
//   P/decisions[?subject=<key>]    what was ruled     P/decisions/<D-n>
//   P/mission-control              the live graph     P/subjects/<key>      with that subject open
//   P/insights[/funnel|/benchmark]
//   P/settings                     who may read the project
//
// `ref` is a commit, or `trunk` for wherever trunk's head is. Nothing here
// touches the browser: `parse` reads an address and `href` writes one.

import { RESERVED_SEGMENTS } from "./contract/keel/index.ts";
import {
  CHANGE_FILTERS,
  CONFLICT_FILTERS,
  type ChangeFilter,
  type ConflictFilter,
  ESCALATION_FILTERS,
  type EscalationFilter,
  PAGE,
} from "./engine/lists.ts";

export type ChangeTab = "overview" | "checks" | "files" | "alternatives";
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
  /** The project's decisions as Keel lists them, or the ones on one subject. */
  | { at: "decisions"; subject?: string }
  /** One decision, by Keel's label for it, or by its id where a link has only that. */
  | { at: "decision"; name: string }
  | { at: "mission-control"; subject?: string }
  | { at: "insights"; tab: InsightsTab }
  | { at: "settings" }
  /** An address that names nothing the console has. */
  | { at: "missing" };

/** The moving head of trunk, as an address says it. */
export const TRUNK = "trunk";

const HOME: Route = { at: "code", kind: "tree", ref: TRUNK, path: "" };
const MISSING: Route = { at: "missing" };

const CHANGE_TABS: readonly ChangeTab[] = ["overview", "checks", "files", "alternatives"];
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
    case "decisions": {
      if (first !== undefined) return more.length > 0 ? MISSING : { at: "decision", name: first };
      const subject = query.get("subject");
      return subject === null || subject === ""
        ? { at: "decisions" }
        : { at: "decisions", subject };
    }
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
    case "settings":
      return first === undefined ? { at: "settings" } : MISSING;
    default:
      return MISSING;
  }
}

/** An address, read: the namespace and the project it names, and the place in that project. */
export interface Address {
  /** The namespace's handle. Null at the bare `/`, and at a reserved first segment, which is nobody's. */
  namespace: string | null;
  /** Null where the address names no project: the home, or a namespace's own. */
  project: string | null;
  route: Route;
}

export function parse(pathname: string, search: string): Address {
  let segments: string[];
  try {
    segments = pathname
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    // Not an address anyone was given: a percent sign that encodes nothing.
    const [namespace = null, project = null] = pathname
      .split("/")
      .filter((segment) => segment !== "");
    return { namespace, project, route: MISSING };
  }
  const [namespace, project, place, ...rest] = segments;
  if (namespace === undefined) return { namespace: null, project: null, route: HOME };
  // A first segment Keel serves itself is no handle: Keel refuses each as one, and the list is its own.
  if (among(RESERVED_SEGMENTS, namespace) !== undefined)
    return { namespace: null, project: null, route: MISSING };
  if (project === undefined) return { namespace, project: null, route: HOME };
  return { namespace, project, route: routeOf(place, rest, new URLSearchParams(search)) };
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
    case "decisions":
      return ["decisions"];
    case "decision":
      return ["decisions", route.name];
    case "insights":
      return ["insights", ...(route.tab === "trunk" ? [] : [route.tab])];
    case "settings":
      return ["settings"];
    default:
      return [];
  }
}

/** A place's own parameters: a list's filter where it is not the first, and its count where it is more than a page. */
function queryOf(route: Route): string {
  if (route.at === "decisions")
    return route.subject === undefined
      ? ""
      : new URLSearchParams({ subject: route.subject }).toString();
  if (route.at !== "changes" && route.at !== "conflicts" && route.at !== "escalations") return "";
  const first: string = route.at === "changes" ? "in-flight" : "open";
  const query = new URLSearchParams();
  if (route.filter !== first) query.set("state", route.filter);
  if (route.shown > PAGE) query.set("shown", String(route.shown));
  return query.toString();
}

/**
 * Writes the address of a place in a namespace's project. `carried` is what every link takes with it: see
 * `carriedOf`.
 */
export function href(namespace: string, project: string, route: Route, carried = ""): string {
  const path = [namespace, project, ...pathOf(route)]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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
