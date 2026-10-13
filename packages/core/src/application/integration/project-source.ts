import { Option, Schema } from "effect";
import { ProjectId } from "../../domain/kernel/index.ts";
import { projectRepos } from "./project-repos.ts";

/**
 * The repos in the core namespace that anyone may start a project from. The
 * namespace also holds every project's trunk, staging and guards, so a name is
 * a template only by being listed here.
 */
export const PROJECT_TEMPLATES: ReadonlySet<string> = new Set(["fixture-forge-lite"]);

/** A template, by its repo's name in the core namespace. */
export interface TemplateSource {
  readonly _tag: "Template";
  readonly repo: string;
}

/** Another project's trunk: a fork, which the policy decides on that project. */
export interface TrunkSource {
  readonly _tag: "Project";
  readonly projectId: ProjectId;
}

/** Nothing to start from: Keel writes the project's first commit itself. */
export interface EmptySource {
  readonly _tag: "Empty";
}

/**
 * A public Git repository, by the URL `importUrl` admitted. `ref` is the
 * upstream's branch to take, as `importRef` admitted it; its default branch
 * when absent.
 */
export interface ImportSource {
  readonly _tag: "Import";
  readonly url: string;
  readonly ref?: string;
}

/** The longest URL a project is imported from, in characters. */
export const IMPORT_URL_MAX = 2048;

/** What a URL holds that Keel imports from none like it. */
export type ImportUrlRefusal =
  | "too-long"
  | "not-https"
  | "credential"
  | "query"
  | "fragment"
  | "port"
  | "ip-literal"
  | "host"
  | "path";

/** A URL Keel imports from, as it is recorded, or why the text is not one. */
export type ImportUrl =
  | { readonly _tag: "Url"; readonly url: string }
  | { readonly _tag: "Refused"; readonly why: ImportUrlRefusal };

const HTTPS = "https://";
const HOST_MAX = 253;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A last label a URL parser reads as a number, and so its host as an address: digits, or `0x` and hex digits. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~+-]+$/;

const urlRefused = (why: ImportUrlRefusal): ImportUrl => ({ _tag: "Refused", why });
const plainSegment = (segment: string) =>
  PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..";

/**
 * Reads the URL a project is imported from: `https://<host>/<path>` and
 * nothing more, the host a dotted name. A credential is refused because the
 * project's origin records the URL for every reader, and the code host
 * itself would take one; a port, a query, a fragment and an address in place
 * of a name are refused so that the URL names one public repository in one
 * way. The path's segments are plain (`.` and `..` are not), with no
 * escapes. The host is answered in lower case and the rest as written.
 */
export const importUrl = (text: string): ImportUrl => {
  if (text.length > IMPORT_URL_MAX) return urlRefused("too-long");
  if (!text.startsWith(HTTPS)) return urlRefused("not-https");
  const rest = text.slice(HTTPS.length);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  if (authority.includes("@")) return urlRefused("credential");
  const mark = /[?#]/.exec(rest);
  if (mark !== null) return urlRefused(mark[0] === "?" ? "query" : "fragment");
  if (authority.startsWith("[")) return urlRefused("ip-literal");
  if (authority.includes(":")) return urlRefused("port");
  const host = authority.toLowerCase();
  const labels = host.split(".");
  if (host.length > HOST_MAX || labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l)))
    return urlRefused("host");
  if (NUMERIC_LABEL.test(labels.at(-1) ?? "")) return urlRefused("ip-literal");
  const path = end < 0 ? "" : rest.slice(end);
  const segments = path.split("/").slice(1);
  if (segments.length === 0 || !segments.every(plainSegment)) return urlRefused("path");
  return { _tag: "Url", url: `${HTTPS}${host}${path}` };
};

const REF_MAX = 255;
const REF_SEGMENT = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*$/;
const branchSegment = (segment: string) =>
  REF_SEGMENT.test(segment) &&
  !segment.includes("..") &&
  !segment.endsWith(".") &&
  !segment.endsWith(".lock");

/**
 * Reads the upstream branch an import names, by its short name (`main`,
 * `release/1.x`): what git allows as one, in plain characters. A full ref
 * name is not a branch's name, so `refs/…` is refused, and so is `HEAD`.
 */
export const importRef = (text: string): string | undefined => {
  if (text.length === 0 || text.length > REF_MAX) return undefined;
  if (text === "HEAD" || text.startsWith("-") || text.startsWith("refs/")) return undefined;
  return text.split("/").every(branchSegment) ? text : undefined;
};

/** A name that is neither: nothing is forked from it. */
export interface UnknownSource {
  readonly _tag: "Unknown";
}

/** What a new project's trunk may be forked from. */
export type ProjectSource = TemplateSource | TrunkSource;

const decodeProjectId = Schema.decodeUnknownOption(ProjectId);
const UNKNOWN: UnknownSource = { _tag: "Unknown" };

/**
 * What the `source` of a new project names. A template is named by its repo.
 * A project is named by its trunk's repo, exactly as `projectRepos` spells it:
 * its staging and guards repos, a name with a namespace before it, the id
 * itself and the name in another case are all unknown, so no repo in the core
 * namespace is reached by guessing at its name.
 */
export const projectSource = (source: string): ProjectSource | UnknownSource => {
  if (PROJECT_TEMPLATES.has(source)) return { _tag: "Template", repo: source };
  // The project whose trunk this would be, if it is one: spelling its trunk again decides.
  const projectId = decodeProjectId(`prj_${source.slice("prj-".length).toUpperCase()}`);
  return Option.isSome(projectId) && projectRepos(projectId.value).trunk.name === source
    ? { _tag: "Project", projectId: projectId.value }
    : UNKNOWN;
};
