import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { read } from "../scan.ts";
import { child, children, identifierName, walkAst } from "./ast.ts";

/** R12: every layer folder of the hexagon and its doorways exists and holds something. */
export const LAYER_FOLDERS = [
  ...[
    "kernel",
    "identity",
    "coordination",
    "verification",
    "integration",
    "memory",
    "delivery",
  ].map((c) => `packages/core/src/domain/${c}`),
  ...["ports", "identity", "coordination", "verification", "integration", "memory", "delivery"].map(
    (c) => `packages/core/src/application/${c}`,
  ),
  ...["http", "mcp", "do", "workflow", "queue"].map((d) => `apps/keel/src/adapters/driving/${d}`),
  "apps/keel/src/adapters/driven",
  "apps/keel/src/composition",
  "apps/keel/src/rpc",
  "apps/keel-verify/src/adapters/driving/do",
  "apps/keel-verify/src/composition",
  "apps/keel-verify/src/rpc",
  "packages/testing/src/memory",
  "packages/testing/src/contracts",
  "packages/runner-protocol/src",
  "docs/adr",
  "docs/domain",
] as const;

function holdsSomething(dir: string): boolean {
  return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;
}

export function checkR12(root: string, options: GuardOptions = {}): GuardResult {
  const found = LAYER_FOLDERS.filter((folder) => holdsSomething(join(root, folder)));
  const violations: Violation[] = LAYER_FOLDERS.filter((folder) => !found.includes(folder)).map(
    (folder) => ({
      rule: "R12",
      file: folder,
      message: "a layer folder is missing or empty; a rule aimed at it would pass on nothing",
    }),
  );
  return withVacuityCheck(
    "R12",
    found,
    violations,
    options.vacuity ?? {
      minFiles: LAYER_FOLDERS.length,
      canary: "packages/core/src/domain/kernel",
    },
  );
}

const SENTINEL = /^(00000000-0000-0000-0000-000000000000|PLACEHOLDER-.+)$/;

/** Every binding name a wrangler config declares, whatever the binding type. */
function bindingNames(config: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown, key: string | null): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "vars" && typeof v === "object" && v !== null)
        for (const name of Object.keys(v)) names.add(name);
      else if (k === "secrets" && typeof v === "object" && v !== null) {
        const required: unknown = Reflect.get(v, "required");
        if (Array.isArray(required))
          for (const name of required) if (typeof name === "string") names.add(name);
      } else if ((k === "binding" || (k === "name" && key === "bindings")) && typeof v === "string")
        names.add(v);
      else visit(v, k);
    }
  };
  visit(config, null);
  return names;
}

/**
 * A rate limit's namespace is a number the config chooses, not a resource an
 * account provisions, so the same one deploys anywhere.
 */
const CHOSEN_ID = { path: /^ratelimits\[\d+\]\.namespace_id$/, value: /^\d+$/ };

/** Keys anywhere in the config that hold an account-specific id: `id`, `*_id`. */
function idFields(value: unknown, path: string, out: { path: string; value: unknown }[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => idFields(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [k, v] of Object.entries(value)) {
    const here = path === "" ? k : `${path}.${k}`;
    const chosen = CHOSEN_ID.path.test(here) && typeof v === "string" && CHOSEN_ID.value.test(v);
    if ((k === "id" || k.endsWith("_id")) && !chosen) out.push({ path: here, value: v });
    idFields(v, here, out);
  }
}

/** The binding names a vitest config adds through `miniflare` (bindings, serviceBindings, and the rest). */
function testBindingNames(file: string, code: string): string[] {
  const names: string[] = [];
  walkAst(file, code, (node) => {
    if (node.type !== "Property" || identifierName(child(node, "key")) !== "miniflare") return;
    const value = child(node, "value");
    if (value === null || value.type !== "ObjectExpression") return;
    for (const group of children(value, "properties")) {
      const groupValue = child(group, "value");
      if (groupValue?.type !== "ObjectExpression") continue;
      for (const binding of children(groupValue, "properties")) {
        const name = identifierName(child(binding, "key"));
        if (name !== null) names.push(name);
      }
    }
  });
  return names;
}

/**
 * R13: Wrangler configs are deployable to any account and agree with their tests:
 * one compatibility date everywhere; `workers_dev`, `preview_urls` and
 * `vars.KEEL_HOST` set explicitly; no `account_id`; every id field a sentinel
 * that the deploy script replaces; `max_instances` on every container but
 * one under the `durable_object` scheduling policy, which refuses it and is
 * counted by BoxGate instead (named in `vars.BOXGATE_CLASSES`); and a test
 * adds no binding production lacks (helpers prefixed `TEST_` aside).
 */
export function checkR13(root: string, options: GuardOptions = {}): GuardResult {
  // The apps, and the examples that deploy as Workers of their own.
  const workers = ["apps", "examples"].flatMap((group) =>
    existsSync(join(root, group))
      ? readdirSync(join(root, group))
          .filter((name) => existsSync(join(root, group, name, "wrangler.jsonc")))
          .map((name) => `${group}/${name}`)
      : [],
  );
  const violations: Violation[] = [];
  const scanned: string[] = [];
  const dates = new Map<string, string[]>();
  for (const dir of workers) {
    const file = `${dir}/wrangler.jsonc`;
    scanned.push(file);
    const errors: ParseError[] = [];
    const config: unknown = parse(read(root, file), errors, { allowTrailingComma: true });
    if (errors.length > 0 || typeof config !== "object" || config === null) {
      violations.push({ rule: "R13", file, message: "does not parse as JSONC" });
      continue;
    }
    const get = (key: string): unknown => Reflect.get(config, key);
    const date = get("compatibility_date");
    if (typeof date === "string") dates.set(date, [...(dates.get(date) ?? []), file]);
    else violations.push({ rule: "R13", file, message: "compatibility_date is missing" });
    for (const key of ["workers_dev", "preview_urls"]) {
      if (typeof get(key) !== "boolean")
        violations.push({ rule: "R13", file, message: `${key} must be set explicitly` });
    }
    const vars = get("vars");
    if (
      typeof vars !== "object" ||
      vars === null ||
      typeof Reflect.get(vars, "KEEL_HOST") !== "string"
    ) {
      violations.push({ rule: "R13", file, message: "vars.KEEL_HOST must be declared" });
    }
    if (get("account_id") !== undefined)
      violations.push({
        rule: "R13",
        file,
        message: "account_id is committed; deploys read CLOUDFLARE_ACCOUNT_ID",
      });
    const ids: { path: string; value: unknown }[] = [];
    idFields(config, "", ids);
    for (const { path, value } of ids) {
      if (typeof value !== "string" || !SENTINEL.test(value)) {
        violations.push({
          rule: "R13",
          file,
          message: `${path} holds an account-specific id; commit a sentinel (all-zero UUID or PLACEHOLDER-…)`,
        });
      }
    }
    const containers = get("containers");
    const gated = new Set(
      typeof vars === "object" &&
        vars !== null &&
        typeof Reflect.get(vars, "BOXGATE_CLASSES") === "string"
        ? String(Reflect.get(vars, "BOXGATE_CLASSES"))
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        : [],
    );
    if (Array.isArray(containers)) {
      containers.forEach((container: unknown, i) => {
        const field = (key: string): unknown =>
          typeof container === "object" && container !== null
            ? Reflect.get(container, key)
            : undefined;
        const className = String(field("class_name"));
        const policy = field("scheduling_policy");
        if (policy === "durable_object") {
          if (!gated.has(className)) {
            violations.push({
              rule: "R13",
              file,
              message: `containers[${i}] (${className}) uses the durable_object policy but is not registered with BoxGate in vars.BOXGATE_CLASSES`,
            });
          }
        } else if (typeof field("max_instances") !== "number") {
          violations.push({
            rule: "R13",
            file,
            message: `containers[${i}] (${className}) has no max_instances; the account is shared`,
          });
        }
      });
    }
    const vitestFile = `${dir}/vitest.config.ts`;
    if (existsSync(join(root, vitestFile))) {
      scanned.push(vitestFile);
      const production = bindingNames(config);
      for (const name of testBindingNames(vitestFile, read(root, vitestFile))) {
        if (!production.has(name) && !name.startsWith("TEST_")) {
          violations.push({
            rule: "R13",
            file: vitestFile,
            message: `the test adds binding ${name}, which production does not declare`,
          });
        }
      }
    }
  }
  if (dates.size > 1) {
    violations.push({
      rule: "R13",
      file: "*/*/wrangler.jsonc",
      message: `compatibility dates differ: ${[...dates.keys()].join(", ")}`,
    });
  }
  return withVacuityCheck(
    "R13",
    scanned,
    violations,
    options.vacuity ?? { minFiles: 3, canary: "apps/keel/wrangler.jsonc" },
  );
}
