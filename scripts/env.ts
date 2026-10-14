// What every operator script needs: the repo root, the account, and a token,
// all taken from the operator's environment and wrangler login, never a file.
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { ApiRefused } from "./lib/cloudflare-api.ts";

export const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const wranglerBin = join(root, "apps/keel/node_modules/.bin/wrangler");

export interface WranglerOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly quiet?: boolean;
  /** Echo wrangler's stdout as it runs, instead of returning it. */
  readonly stream?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

export function wrangler(args: readonly string[], options: WranglerOptions = {}): string {
  const output = execFileSync(wranglerBin, [...args], {
    cwd: options.cwd ?? join(root, "apps/keel"),
    encoding: "utf8",
    input: options.input,
    stdio: [
      options.input === undefined ? "ignore" : "pipe",
      options.stream === true ? "inherit" : "pipe",
      options.quiet === true ? "pipe" : "inherit",
    ],
    env: { ...process.env, ...options.env, WRANGLER_SEND_METRICS: "false" },
  });
  return output ?? "";
}

export function accountId(): string {
  const id = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (id === undefined || !/^[0-9a-f]{32}$/.test(id)) {
    throw new Error(
      "Set CLOUDFLARE_ACCOUNT_ID to the account Keel deploys to (it is never committed).",
    );
  }
  return id;
}

/** The one site an environment serves (`keel.town`), from its Terraform output. */
export function siteHost(environment: string): string {
  const run = spawnSync(
    "terraform",
    [`-chdir=${join(root, "infra", environment)}`, "output", "-raw", "keel_host"],
    { encoding: "utf8" },
  );
  const host = run.stdout.trim();
  if (run.status !== 0 || host === "" || host.includes("\n"))
    throw new Error(
      `terraform output keel_host failed for ${environment}; run \`node scripts/tf.ts ${environment} apply\`:\n${run.stderr}`,
    );
  return host;
}

let token: string | undefined;

/**
 * A short-lived API token from the operator's wrangler login, fetched once and
 * reused. A wrangler command run in between may refresh the login, which
 * revokes this token, so `cloudflare()` fetches it again on a 401.
 */
export function apiToken(): string {
  token ??= wrangler(["auth", "token"], { quiet: true }).trim().split("\n").pop() ?? "";
  if (token.length < 20)
    throw new Error("No wrangler login: run `pnpm --dir apps/keel exec wrangler login`.");
  return token;
}

/**
 * One Cloudflare API call, answering its `result`; throws `ApiRefused` with the
 * API's own errors when it answered, and fetch's own error when it did not.
 */
export async function cloudflare(method: string, path: string, body?: unknown): Promise<unknown> {
  const send = () =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId()}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiToken()}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let response = await send();
  if (response.status === 401) {
    // The deploy's own wrangler runs refresh the login, which revokes the token fetched earlier.
    token = undefined;
    response = await send();
  }
  const json: unknown = await response.json();
  const success =
    typeof json === "object" && json !== null && Reflect.get(json, "success") === true;
  if (!success)
    throw new ApiRefused(
      response.status,
      `${method} ${path}: ${response.status} ${JSON.stringify(json).slice(0, 400)}`,
    );
  const result: unknown = Reflect.get(Object(json), "result");
  return result;
}

/** The string `key` of every object in an API list result. */
export function namesIn(result: unknown, ...keys: readonly string[]): string[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item: unknown) =>
    keys
      .map((key) => Reflect.get(Object(item), key))
      .filter((v): v is string => typeof v === "string"),
  );
}
