import { Option, Schema } from "effect";
import { ProjectId } from "../../domain/kernel/index.ts";
import type { ProjectSource } from "../ports/index.ts";

export type {
  EmptySource,
  ImportSource,
  ProjectSource,
  TemplateSource,
  TrunkSource,
} from "../ports/index.ts";

/**
 * The repos in the core namespace that anyone may start a project from. The
 * namespace also holds every project's trunk, staging and guards, so a name is
 * a template only by being listed here.
 */
export const PROJECT_TEMPLATES: ReadonlySet<string> = new Set(["fixture-forge-lite"]);

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

/** A template's name that is not one, or a project's id that is not one: nothing is forked from it. */
export interface UnknownSource {
  readonly _tag: "Unknown";
}

/** An import whose URL or branch Keel takes none like: `field` is the one to fix, and `why` what is wrong with it. */
export interface RefusedSource {
  readonly _tag: "Refused";
  readonly field: "url" | "ref";
  readonly why: ImportUrlRefusal | "not-a-branch";
}

/** A new project's `source` as the API's request carries it. */
export type SourceRequest =
  | { readonly kind: "empty" }
  | { readonly kind: "import"; readonly url: string; readonly ref?: string | undefined }
  | { readonly kind: "fork"; readonly project: string }
  | { readonly kind: "template"; readonly name: string };

const UNKNOWN: UnknownSource = { _tag: "Unknown" };
const decodeProjectId = Schema.decodeUnknownOption(ProjectId);

/**
 * What the `source` of a new project names. A template is named by its repo,
 * and only a listed one is known, so no repo in the core namespace is reached
 * by guessing at its name. A fork names a project by its id, which the policy
 * then decides on. An import's URL and branch are read by `importUrl` and
 * `importRef`, and the URL is answered as it will be recorded.
 */
export const projectSource = (
  source: SourceRequest,
): ProjectSource | UnknownSource | RefusedSource => {
  if (source.kind === "empty") return { _tag: "Empty" };
  if (source.kind === "template")
    return PROJECT_TEMPLATES.has(source.name) ? { _tag: "Template", repo: source.name } : UNKNOWN;
  if (source.kind === "fork")
    return Option.match(decodeProjectId(source.project), {
      onNone: () => UNKNOWN,
      onSome: (projectId): ProjectSource => ({ _tag: "Project", projectId }),
    });
  const url = importUrl(source.url);
  if (url._tag === "Refused") return { _tag: "Refused", field: "url", why: url.why };
  if (source.ref === undefined) return { _tag: "Import", url: url.url };
  const ref = importRef(source.ref);
  return ref === undefined
    ? { _tag: "Refused", field: "ref", why: "not-a-branch" }
    : { _tag: "Import", url: url.url, ref };
};
