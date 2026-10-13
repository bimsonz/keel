// The account `fake-account.ts` holds, as its file stores it between runs and
// a test reads it back. Nothing here replaces anything: a test imports this,
// never the preload.

export type Step =
  | {
      readonly kind: "write";
      readonly method: string;
      readonly path: string;
      readonly made: string;
    }
  | { readonly kind: "pnpm"; readonly args: readonly string[] }
  | {
      readonly kind: "wrangler";
      readonly args: readonly string[];
      /** The config's directory, from the repository's root. */
      readonly dir: string;
      /** Whether the build's two naming variables reached this run of wrangler. */
      readonly buildNames: "kept" | "dropped" | "half";
      /** The secrets handed to a deploy on its standard input, by name. */
      readonly given: readonly string[];
      readonly deployedAs?: string;
    };

export interface Account {
  subdomain: string | null;
  /** API paths, from the account's, that answer 403: what the token cannot reach. */
  deny: string[];
  d1: { uuid: string; name: string }[];
  buckets: string[];
  queues: { queue_id: string; queue_name: string }[];
  namespaces: string[];
  stores: { id: string; name: string }[];
  storeSecrets: string[];
  subscriptions: object[];
  lifecycle: Record<string, { id: string }[]>;
  workers: Record<string, { secrets: string[]; vars: Record<string, unknown> }>;
  /** The last id handed out. */
  n: number;
  run: Step[];
}

const LISTS = [
  "deny",
  "d1",
  "buckets",
  "queues",
  "namespaces",
  "stores",
  "storeSecrets",
  "subscriptions",
  "run",
] as const;

const isAccount = (value: unknown): value is Account =>
  typeof value === "object" &&
  value !== null &&
  LISTS.every((key) => Array.isArray(Reflect.get(value, key))) &&
  typeof Reflect.get(value, "workers") === "object" &&
  typeof Reflect.get(value, "lifecycle") === "object";

/** An account read back from its file. */
export function accountIn(raw: string): Account {
  const value: unknown = JSON.parse(raw);
  if (!isAccount(value)) throw new Error("fake account: the file holds no account");
  return value;
}
