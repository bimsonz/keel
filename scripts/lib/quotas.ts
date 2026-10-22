// The instance's quota configuration at deploy: keel's `KEEL_QUOTAS` var, filled
// from the operator's file. A Worker var, not infrastructure, so no Terraform
// apply stands in front of a change to a limit.
import { homedir } from "node:os";
import { join } from "node:path";

/** The var keel reads its quota configuration from. */
export const QUOTAS_VAR = "KEEL_QUOTAS";

/** The environment keel.town runs as, which never deploys without its configuration. */
export const QUOTAS_REQUIRED_IN = "staging";

/** The operator's file: `KEEL_QUOTAS_FILE`, else `~/.keel/keel-quotas.json`. */
export const quotasFile = (env: NodeJS.ProcessEnv = process.env): string =>
  env["KEEL_QUOTAS_FILE"] ?? join(homedir(), ".keel", "keel-quotas.json");

/** The kinds a limit may name: core's `QuotaKind`, which the tooling test holds this list to. */
export const QUOTA_KINDS = [
  "projects",
  "agents",
  "active-changes",
  "repo-bytes",
  "container-minutes",
  "model-calls",
  "concurrent-containers",
  "proposals",
  "proposal-moves",
  "issues",
  "issue-comments",
] as const;

/** A namespace's id: a person's, an agent's or an org's (core's `NamespaceId`). */
const NAMESPACE_ID = /^(usr|agt|org)_[0-9A-HJKMNP-TV-Z]{26}$/;

export type QuotasAtDeploy =
  /** The config has no `KEEL_QUOTAS`: nothing to fill. */
  | { readonly kind: "none" }
  /** The file, checked, as the var's compact JSON, how many namespaces it names, and how many it halts. */
  | {
      readonly kind: "configured";
      readonly value: string;
      readonly namespaces: number;
      readonly defaults: boolean;
      readonly halted: number;
    }
  /** No file, outside keel.town: the committed `"{}"` stands, and every namespace has the defaults. */
  | { readonly kind: "defaults"; readonly said: string }
  /** The deploy stops here, saying why; never a namespace id. */
  | { readonly kind: "refused"; readonly reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a limits object is not one, or undefined when it is. */
const limitsProblem = (limits: unknown, where: string): string | undefined => {
  if (!isObject(limits)) return `${where} is not an object of limits`;
  for (const [kind, limit] of Object.entries(limits)) {
    if (!(QUOTA_KINDS as readonly string[]).includes(kind))
      return `${where} names ${JSON.stringify(kind)}, which is no quota kind`;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)
      return `${where}'s ${kind} is not a finite number, zero or more`;
  }
  return undefined;
};

/** Why a parsed file is not the instance's quota configuration, or undefined when it is. */
export const quotasProblem = (json: unknown): string | undefined => {
  if (!isObject(json)) return "it is not a JSON object";
  for (const key of Object.keys(json))
    if (key !== "defaults" && key !== "namespaces" && key !== "halted")
      return `it has ${JSON.stringify(key)}, and only "defaults", "namespaces" and "halted" are read`;
  const halted = json["halted"];
  if (halted !== undefined) {
    if (!Array.isArray(halted)) return "halted is not a list of namespace ids";
    for (const [n, id] of halted.entries())
      if (typeof id !== "string" || !NAMESPACE_ID.test(id))
        return `halted's entry number ${n + 1} is no namespace id`;
  }
  if (json["defaults"] !== undefined) {
    const problem = limitsProblem(json["defaults"], "defaults");
    if (problem !== undefined) return problem;
  }
  const namespaces = json["namespaces"];
  if (namespaces === undefined) return undefined;
  if (!isObject(namespaces)) return "namespaces is not an object keyed by namespace id";
  for (const [n, [id, limits]] of Object.entries(namespaces).entries()) {
    if (!NAMESPACE_ID.test(id)) return `namespaces' key number ${n + 1} is no namespace id`;
    const problem = limitsProblem(limits, `namespaces' entry number ${n + 1}`);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

/**
 * What keel's `KEEL_QUOTAS` is deployed as: the operator's file (`read`
 * answers its text, or undefined when there is none), checked and compacted.
 * A file that is not the configuration refuses everywhere. No file refuses on
 * keel.town, where `"{}"` would hold keel/keel to the defaults' 120 minutes a
 * day, and elsewhere leaves the committed `"{}"`. What is said never holds a
 * namespace id.
 */
export function quotasAtDeploy(
  config: unknown,
  environment: string,
  read: () => string | undefined,
  file: string = quotasFile(),
): QuotasAtDeploy {
  const vars = isObject(config) ? config["vars"] : undefined;
  if (!isObject(vars) || !(QUOTAS_VAR in vars)) return { kind: "none" };
  const text = read();
  if (text === undefined)
    return environment === QUOTAS_REQUIRED_IN
      ? {
          kind: "refused",
          reason: `${QUOTAS_VAR}: ${file} is missing. Refusing to deploy ${environment} without it: every namespace would have the defaults, and keel/keel would stop at 120 container-minutes a day`,
        }
      : {
          kind: "defaults",
          said: `${QUOTAS_VAR}: no ${file}, so every namespace has the defaults`,
        };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "refused", reason: `${QUOTAS_VAR}: ${file} is not JSON` };
  }
  const problem = quotasProblem(json);
  if (problem !== undefined)
    return {
      kind: "refused",
      reason: `${QUOTAS_VAR}: ${file} is not the instance's quota configuration: ${problem}`,
    };
  const namespaces = isObject(json) && isObject(json["namespaces"]) ? json["namespaces"] : {};
  return {
    kind: "configured",
    value: JSON.stringify(json),
    namespaces: Object.keys(namespaces).length,
    defaults: isObject(json) && json["defaults"] !== undefined,
    halted: isObject(json) && Array.isArray(json["halted"]) ? json["halted"].length : 0,
  };
}
