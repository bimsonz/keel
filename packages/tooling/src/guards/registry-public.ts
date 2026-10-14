import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { read, walk } from "../scan.ts";

export const REGISTRY_PUBLIC = "registry-public";

/** The only registry a package may be installed from. */
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

const CONFIG = (path: string): boolean => /(^|\/)(pnpm-lock\.yaml|\.npmrc)$/.test(path);

const TARBALL = /\btarball:\s*['"]?([^\s,'"}]+)/;

function lockfileViolations(file: string, text: string): Violation[] {
  return text.split("\n").flatMap((line, index) => {
    const url = TARBALL.exec(line)?.[1];
    if (url === undefined || url.startsWith(PUBLIC_REGISTRY)) return [];
    return [
      {
        rule: REGISTRY_PUBLIC,
        file,
        line: index + 1,
        message: `resolves a tarball outside ${PUBLIC_REGISTRY}: ${url}`,
      },
    ];
  });
}

function npmrcViolations(file: string, text: string): Violation[] {
  return text.split("\n").flatMap((raw, index) => {
    const line = raw.trim();
    const equals = line.indexOf("=");
    if (line.startsWith("#") || line.startsWith(";") || equals === -1) return [];
    const key = line.slice(0, equals).trim();
    const value = line
      .slice(equals + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    const at = { rule: REGISTRY_PUBLIC, file, line: index + 1 };
    const scope = /^(@[^:]+):registry$/.exec(key)?.[1];
    if (scope !== undefined)
      return [{ ...at, message: `maps the ${scope} scope to a registry of its own: ${line}` }];
    if (key === "registry" && value !== PUBLIC_REGISTRY)
      return [{ ...at, message: `sets registry to ${value}, not ${PUBLIC_REGISTRY}` }];
    return [];
  });
}

/**
 * Every package installs from the public npm registry, so a fresh clone
 * installs with no login and no extra configuration. A pnpm lockfile may only
 * resolve a tarball on that registry, and an `.npmrc` may neither map a scope
 * to a registry of its own nor set `registry` to any other.
 */
export function checkRegistryPublic(root: string, options: GuardOptions = {}): GuardResult {
  const files = walk(root, { keep: CONFIG, skip: options.skip ?? ["test/controls"] });
  const violations = files.flatMap((file) =>
    file.endsWith(".npmrc")
      ? npmrcViolations(file, read(root, file))
      : lockfileViolations(file, read(root, file)),
  );
  return withVacuityCheck(
    REGISTRY_PUBLIC,
    files,
    violations,
    options.vacuity ?? { minFiles: 6, canary: "pnpm-lock.yaml" },
  );
}
