import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { read } from "../scan.ts";

export const MODEL_PINS = "model-pins";

/** An exact Workers AI model id: never `cloudflare/auto`, never a family name. */
const EXACT_MODEL = /^@cf\/[\w.-]+\/[\w.-]+$/;

/**
 * What is wrong with a Worker config's model pins: a Worker that binds AI
 * runs every PlatformFunction on the exact model `vars.PLATFORM_FUNCTION_PINS`
 * names for it, so the pins must be there, non-empty, and
 * every one an exact `@cf/` id. Without them a call would abstain at best, or
 * run on a model nobody chose. deploy.ts runs this on the rendered config too.
 */
export function pinProblems(config: unknown): string[] {
  if (config === null || typeof config !== "object") return ["does not parse as JSONC"];
  if (Reflect.get(config, "ai") === undefined) return [];
  const pins: unknown = Reflect.get(Object(Reflect.get(config, "vars")), "PLATFORM_FUNCTION_PINS");
  if (pins === undefined)
    return [
      "binds AI but declares no vars.PLATFORM_FUNCTION_PINS: every PlatformFunction needs a pinned model",
    ];
  if (pins === null || typeof pins !== "object" || Array.isArray(pins))
    return ["vars.PLATFORM_FUNCTION_PINS is not an object of function → model id"];
  const entries = Object.entries(pins);
  if (entries.length === 0) return ["vars.PLATFORM_FUNCTION_PINS pins no function"];
  return entries
    .filter(([, model]) => typeof model !== "string" || !EXACT_MODEL.test(model))
    .map(([fn, model]) => `pins ${fn} to ${JSON.stringify(model)}, not an exact @cf/ model id`);
}

/** Every app's wrangler.jsonc, checked with `pinProblems`. */
export function checkModelPins(root: string, options: GuardOptions = {}): GuardResult {
  const apps = existsSync(join(root, "apps"))
    ? readdirSync(join(root, "apps")).filter((a) =>
        existsSync(join(root, "apps", a, "wrangler.jsonc")),
      )
    : [];
  const scanned = apps.map((app) => `apps/${app}/wrangler.jsonc`);
  const violations: Violation[] = scanned.flatMap((file) => {
    const errors: ParseError[] = [];
    const config: unknown = parse(read(root, file), errors, { allowTrailingComma: true });
    const problems = errors.length > 0 ? ["does not parse as JSONC"] : pinProblems(config);
    return problems.map((message) => ({ rule: MODEL_PINS, file, message }));
  });
  return withVacuityCheck(
    MODEL_PINS,
    scanned,
    violations,
    options.vacuity ?? { minFiles: 1, canary: "apps/keel/wrangler.jsonc" },
  );
}
