// What every operator script needs: the repo root, the account, and a token,
// all taken from the operator's environment and wrangler login, never a file.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const wranglerBin = join(root, "apps/keel/node_modules/.bin/wrangler");

export function wrangler(args: readonly string[], options: { cwd?: string; input?: string; quiet?: boolean } = {}): string {
  return execFileSync(wranglerBin, [...args], {
    cwd: options.cwd ?? join(root, "apps/keel"),
    encoding: "utf8",
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", options.quiet === true ? "pipe" : "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
}

export function accountId(): string {
  const id = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (id === undefined || !/^[0-9a-f]{32}$/.test(id)) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID to the account Keel deploys to (it is never committed).");
  }
  return id;
}

/** A short-lived API token from the operator's wrangler login. */
export function apiToken(): string {
  const token = wrangler(["auth", "token"], { quiet: true }).trim().split("\n").pop() ?? "";
  if (token.length < 20) throw new Error("No wrangler login: run `pnpm --dir apps/keel exec wrangler login`.");
  return token;
}

/** One Cloudflare API call, answering its `result`; throws with the API's own errors. */
export async function cloudflare(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId()}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiToken()}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json();
  const success = typeof json === "object" && json !== null && Reflect.get(json, "success") === true;
  if (!success) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json).slice(0, 400)}`);
  const result: unknown = Reflect.get(Object(json), "result");
  return result;
}

/** The string `key` of every object in an API list result. */
export function namesIn(result: unknown, ...keys: readonly string[]): string[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item: unknown) => keys.map((key) => Reflect.get(Object(item), key)).filter((v): v is string => typeof v === "string"));
}
