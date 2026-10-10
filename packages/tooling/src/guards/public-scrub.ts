import { createHash } from "node:crypto";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { matchingLines, read, walk } from "../scan.ts";

export const PUBLIC_SCRUB = "public-scrub";

/**
 * Keel is a public repository. Nothing committed may name a local filesystem
 * path, or a term on the list below: prior art without a licence is knowledge
 * only (ADR 0013), and stays unnamed.
 *
 * The forbidden names are held as truncated SHA-256 digests of their
 * lower-case, hyphen-joined words, so this guard can recognise them without
 * the repository ever spelling them out. Each line is split into words and
 * every run of one to three words is hashed and looked up.
 */
const FORBIDDEN_TERMS: ReadonlyMap<string, string> = new Map([
  ["46f0740e245d8f6a", "an unlicensed project's name"],
  ["ce71211559188524", "an unlicensed project's name"],
  ["635f19d8ccbfeb17", "an unlicensed project's name"],
  ["5117c5e98ea8f691", "an unlicensed project's name"],
  ["e56c3e1fb3ee34af", "an unlicensed project's name"],
  ["3e5024cd3a17bde0", "an unlicensed project's name"],
  ["8d6c41c8a67db1d4", "an unlicensed project's name"],
  ["e2416b1e2920b006", "an unlicensed project's name"],
  ["45d6f9758d3d9ab4", "an unlicensed project's name"],
  ["6b6f036a82e54d66", "an unlicensed project's name"],
  // A fictional name, planted in this guard's control fixture.
  ["0a8c34a9960ad87d", "the control's planted name"],
]);

const LOCAL_PATH = /\/Users\/|\/home\/[a-z]/;

const TEXT = (path: string): boolean =>
  /\.(md|ts|tsx|js|mjs|json|jsonc|ya?ml|tsp|sql|tf|sh|txt|html|css|toml)$/.test(path) ||
  /(^|\/)(\.npmrc|\.gitignore|LICENSE)$/.test(path);

export function digest(term: string): string {
  return createHash("sha256").update(term).digest("hex").slice(0, 16);
}

/** Every run of one to three words in `line`, lower-cased and hyphen-joined. */
export function termsOf(line: string): string[] {
  const words = line.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const terms: string[] = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= 3 && start + size <= words.length; size += 1) {
      terms.push(words.slice(start, start + size).join("-"));
    }
  }
  return terms;
}

/**
 * Secrets are read from the environment at check time, so the guard can look
 * for them without the repository holding them.
 */
function secretsFromEnvironment(): { value: string; name: string }[] {
  const names = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];
  return names.flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value.length < 8 ? [] : [{ value, name }];
  });
}

export function checkPublicScrub(root: string, options: GuardOptions = {}): GuardResult {
  const files = walk(root, { keep: TEXT, skip: options.skip ?? ["test/controls"] });
  const secrets = secretsFromEnvironment();
  const violations: Violation[] = [];
  for (const file of files) {
    const text = read(root, file);
    for (const hit of matchingLines(text, LOCAL_PATH)) {
      violations.push({ rule: PUBLIC_SCRUB, file, line: hit.line, message: "names a local filesystem path" });
    }
    text.split("\n").forEach((line, index) => {
      const named = new Set(termsOf(line).flatMap((term) => FORBIDDEN_TERMS.get(digest(term)) ?? []));
      for (const reason of named) {
        violations.push({ rule: PUBLIC_SCRUB, file, line: index + 1, message: `names ${reason}` });
      }
      for (const secret of secrets) {
        if (line.includes(secret.value)) {
          violations.push({
            rule: PUBLIC_SCRUB,
            file,
            line: index + 1,
            message: `contains the value of ${secret.name}`,
          });
        }
      }
    });
  }
  return withVacuityCheck(
    PUBLIC_SCRUB,
    files,
    violations,
    options.vacuity ?? { minFiles: 40, canary: "README.md" },
  );
}
