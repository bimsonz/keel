import { Result, Schema } from "effect";
import type { ChangeId, Json } from "../kernel/index.ts";
import { DeployTargetName } from "./deployment.ts";

/** The path a project's deploy spec is read from, at the change's base, like its flow. */
export const DEPLOY_SPEC_PATH = ".keel/deploy.json";

/** A Worker's name on its account: what Cloudflare takes as a script name and a workers.dev label. */
export const WorkerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
).pipe(Schema.brand("WorkerName"));
export type WorkerName = typeof WorkerName.Type;

/**
 * One request a preview must answer before its change may land: a path, the
 * status, and text the body holds. The path is on the preview's host: a second
 * `/` or any `\` would let a URL resolve it to another host, so neither is taken.
 */
export const SmokeCheck = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^\/(?!\/)[\x21-\x5b\x5d-\x7e]{0,255}$/)),
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  contains: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});
export type SmokeCheck = typeof SmokeCheck.Type;

/**
 * A project's `.keel/deploy.json`: which of its deploy targets previews and
 * deploys go to, the Worker's name there, where its wrangler config is, and
 * the smoke checks a preview must pass. It is read at the change's base, so a
 * change cannot move its own deploy to another Worker of the owner's account:
 * the token reaches every Worker there.
 */
export const DeploySpec = Schema.Struct({
  target: DeployTargetName,
  worker: WorkerName,
  /** The directory holding the Worker's wrangler config, from the repo's root; the root itself when absent. */
  path: Schema.optional(
    Schema.String.check(Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w./-]{1,200}$/)),
  ),
  smoke: Schema.Array(SmokeCheck).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type DeploySpec = typeof DeploySpec.Type;

/** A deploy spec Keel cannot read, saying why. */
export class DeploySpecInvalid extends Schema.TaggedError<DeploySpecInvalid>()(
  "DeploySpecInvalid",
  { detail: Schema.String },
) {}

/** Reads a `.keel/deploy.json` as written. */
export const parseDeploySpec = (source: string): Result.Result<DeploySpec, DeploySpecInvalid> => {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    return Result.fail(
      new DeploySpecInvalid({
        detail: `${DEPLOY_SPEC_PATH} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
  const decoded = Schema.decodeUnknownResult(DeploySpec)(json, { onExcessProperty: "error" });
  return Result.isFailure(decoded)
    ? Result.fail(
        new DeploySpecInvalid({ detail: `${DEPLOY_SPEC_PATH}: ${decoded.failure.message}` }),
      )
    : Result.succeed(decoded.success);
};

/**
 * The wrangler config keys Keel takes: the ones it uploads a version with, and
 * the settings a version does not carry (routes, triggers, observability and
 * the like belong to a deployment, or to wrangler's own tooling). Any other key
 * declares a binding or resource Keel does not send with a preview yet, or
 * changes how the bundle is built, so a config with one is refused, naming it.
 * A key wrangler adds later is refused too, until Keel reads it.
 */
export const TAKEN_KEYS: readonly string[] = [
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "vars",
  "account_id",
  "compliance_region",
  "dev",
  "env",
  "keep_vars",
  "limits",
  "logpush",
  "minify",
  "observability",
  "placement",
  "preview_urls",
  "route",
  "routes",
  "send_metrics",
  "triggers",
  "upload_source_maps",
  "workers_dev",
];

/** What Keel takes from a Worker's wrangler config to upload it: its name, entry, compatibility and plain vars. */
export interface WranglerFacts {
  readonly name: string;
  readonly main: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  /** Read from JSON, so each is JSON. */
  readonly vars: Readonly<Record<string, Json>>;
}

/** A wrangler config Keel will not upload from, and why. */
export class WranglerConfigRefused extends Schema.TaggedError<WranglerConfigRefused>()(
  "WranglerConfigRefused",
  {
    reason: Schema.Literals(["unreadable", "incomplete", "uncarried-key", "toml-not-yet"]),
    detail: Schema.String,
  },
) {}

/** The index of the first character from `i` that is neither whitespace nor inside a comment. */
const pastBlank = (source: string, i: number): number => {
  let j = i;
  for (;;) {
    while (j < source.length && /\s/.test(source[j] ?? "")) j += 1;
    if (source.startsWith("//", j)) {
      const end = source.indexOf("\n", j);
      j = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", j)) {
      const end = source.indexOf("*/", j + 2);
      j = end === -1 ? source.length : end + 2;
    } else return j;
  }
};

/**
 * JSONC as wrangler reads it, to JSON: line and block comments and trailing
 * commas go, and nothing inside a string is touched.
 */
export const jsoncToJson = (source: string): string => {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === ",") {
      const j = pastBlank(source, i + 1);
      if (source[j] !== "}" && source[j] !== "]") out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The facts Keel uploads a Worker with, from its wrangler config's text. A
 * `.toml` config is refused until Keel reads TOML; so is one with a key Keel
 * does not take (TAKEN_KEYS). Only the top level is read: an
 * `env` section is a config for another environment, not this Worker.
 */
export const wranglerFacts = (
  fileName: string,
  source: string,
): Result.Result<WranglerFacts, WranglerConfigRefused> => {
  if (fileName.endsWith(".toml"))
    return Result.fail(
      new WranglerConfigRefused({
        reason: "toml-not-yet",
        detail: `${fileName}: Keel reads wrangler.jsonc or wrangler.json, not TOML yet`,
      }),
    );
  let config: unknown;
  try {
    config = JSON.parse(jsoncToJson(source));
  } catch (error) {
    return Result.fail(
      new WranglerConfigRefused({
        reason: "unreadable",
        detail: `${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
  if (typeof config !== "object" || config === null || Array.isArray(config))
    return Result.fail(
      new WranglerConfigRefused({ reason: "unreadable", detail: `${fileName} is not an object` }),
    );
  const uncarried = Object.keys(config).filter((key) => !TAKEN_KEYS.includes(key));
  if (uncarried.length > 0)
    return Result.fail(
      new WranglerConfigRefused({
        reason: "uncarried-key",
        detail: `${fileName} declares ${uncarried.join(", ")}, which Keel does not carry into a preview yet`,
      }),
    );
  const name: unknown = Reflect.get(config, "name");
  const main: unknown = Reflect.get(config, "main");
  const date: unknown = Reflect.get(config, "compatibility_date");
  const flags: unknown = Reflect.get(config, "compatibility_flags") ?? [];
  const vars: unknown = Reflect.get(config, "vars") ?? {};
  const missing = [
    typeof name === "string" ? undefined : "name",
    typeof main === "string" && main.length > 0 ? undefined : "main",
    typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? undefined : "compatibility_date",
    isStringArray(flags) ? undefined : "compatibility_flags",
    typeof vars === "object" && vars !== null && !Array.isArray(vars) ? undefined : "vars",
  ].filter((key) => key !== undefined);
  if (missing.length > 0)
    return Result.fail(
      new WranglerConfigRefused({
        reason: "incomplete",
        detail: `${fileName} has no usable ${missing.join(", ")}`,
      }),
    );
  return Result.succeed({
    name: String(name),
    main: String(main),
    compatibilityDate: String(date),
    compatibilityFlags: isStringArray(flags) ? flags : [],
    vars: Object.fromEntries(Object.entries(Object(vars))),
  });
};

/** A candidate's Worker that is not the one its base's deploy spec pins, so it is never uploaded. */
export class WorkerNameDiffers extends Schema.TaggedError<WorkerNameDiffers>()(
  "WorkerNameDiffers",
  { pinned: Schema.String, named: Schema.String },
) {}

/**
 * The candidate's wrangler config must name the Worker its base's deploy spec
 * pins: a change that renames its Worker would otherwise reach another Worker
 * of the owner's account.
 */
export const checkPinnedName = (
  spec: DeploySpec,
  facts: WranglerFacts,
): Result.Result<WranglerFacts, WorkerNameDiffers> =>
  facts.name === spec.worker
    ? Result.succeed(facts)
    : Result.fail(new WorkerNameDiffers({ pinned: spec.worker, named: facts.name }));

/** The longest a workers.dev label may be: an alias, a hyphen and the Worker's name share it. */
export const LABEL_MAX = 63;

/**
 * A change's preview alias: `ch-` and the tail of its id, stable across the
 * change's candidates, so its address stays the same while it is retried. A
 * Worker whose name leaves no room for it in one DNS label gets none, and its
 * previews are reached by their version's address alone.
 */
export const previewAlias = (changeId: ChangeId, worker: WorkerName): string | undefined => {
  const alias = `ch-${changeId.slice(-10).toLowerCase()}`;
  return alias.length + 1 + worker.length <= LABEL_MAX ? alias : undefined;
};

/** A smoke check whose path would be fetched from another host than the preview's. */
export class SmokePathOffHost extends Schema.TaggedError<SmokePathOffHost>()("SmokePathOffHost", {
  path: Schema.String,
  preview: Schema.String,
}) {}

/**
 * The address a smoke check fetches: the preview's origin, then the path.
 * A path that starts with `/` ends the origin's host where it begins, so the
 * request stays on the preview; any other would let it name a host of its own
 * (`@evil.example`), and is refused. SmokeCheck's pattern also refuses a path
 * that a URL resolved against the preview would take elsewhere (`//`, `\`).
 */
export const smokeUrl = (
  preview: string,
  check: SmokeCheck,
): Result.Result<string, SmokePathOffHost> =>
  check.path.startsWith("/")
    ? Result.succeed(`${preview}${check.path}`)
    : Result.fail(new SmokePathOffHost({ path: check.path, preview }));
