// What an install decides, apart from the calls it makes (scripts/install.ts):
// which Worker a build may rename, what the account must hold before anything
// deploys, when keys are made, and what a config says once it names a real
// account's stores. Each is held by packages/tooling/test/install.test.ts.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from "jsonc-parser";

export type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectsAt = (config: Json, key: string): Json[] => {
  const value = config[key];
  return Array.isArray(value) ? value.filter(isObject) : [];
};
const stringAt = (config: Json, key: string): string | undefined => {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
};

export function parseConfig(text: string, source: string): Json {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isObject(config))
    throw new Error(
      `${source}: not valid JSONC (${errors.map((e) => printParseErrorCode(e.error)).join(", ")})`,
    );
  return config;
}

/** The three Workers, in the order their bindings need: keel binds keel-verify, the console binds keel. */
export const APPS = ["keel-verify", "keel", "console"] as const;
export type App = (typeof APPS)[number];

/**
 * The Worker a build is connected to: the one a Deploy to Cloudflare button
 * makes, and the site's door. Its config is the repository's root
 * `wrangler.jsonc`, which is what the button reads.
 */
export const CONNECTED: App = "console";

/** Where each Worker's config is, from the repository's root, and where its deploy runs. */
export const CONFIG_OF: Readonly<Record<App, { dir: string; file: string }>> = {
  "keel-verify": { dir: "apps/keel-verify", file: "apps/keel-verify/wrangler.jsonc" },
  keel: { dir: "apps/keel", file: "apps/keel/wrangler.jsonc" },
  console: { dir: ".", file: "wrangler.jsonc" },
};

/**
 * The site's one host on an account with no zone: the console's own address.
 * Everything Keel checks a request against (its cookie's origin, a passkey's
 * host, the MCP endpoint's host) is this.
 */
export function siteHost(consoleName: string, subdomain: string): string {
  if (consoleName === "" || subdomain === "")
    throw new Error("a workers.dev address needs the Worker's name and the account's subdomain");
  return `${consoleName}.${subdomain}.workers.dev`;
}

/** What Workers Builds sets so that every `wrangler deploy` in a build lands on the connected Worker. */
const CI_NAME_VARIABLES = new Set(["WRANGLER_CI_OVERRIDE_NAME", "WRANGLER_CI_MATCH_TAG"]);

/**
 * The environment one Worker's deploy runs in. A build renames whatever it
 * deploys to the Worker it is connected to, which is right for that Worker and
 * would put the other two on top of it: they deploy without those variables.
 */
export function ciEnvFor(
  app: string,
  connected: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  if (app === connected) return { ...env };
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CI_NAME_VARIABLES.has(name)));
}

/**
 * Every permission the token lacks, from one read of each API it will need:
 * all of them, so a person adds them in one go and not one failed build each.
 */
export function missingPermissions(
  probes: readonly { permission: string; status: number }[],
): string[] {
  return [
    ...new Set(probes.filter((p) => p.status === 401 || p.status === 403).map((p) => p.permission)),
  ];
}

/** The secrets an install makes for itself, once. All are keel's. */
export const GENERATED_SECRETS = [
  "KEEL_SIGNING_KEY",
  "BETTER_AUTH_SECRET",
  "BUNDLE_URL_SIGNING_KEY",
  "KEEL_COMMIT_SIGNING_KEY",
] as const;

/** The public halves of two of them, as the deployed Workers show them in their settings. */
export interface PublicHalves {
  /** keel-verify's `BUNDLE_URL_PUBLIC_KEY`. */
  readonly bundleUrlPublicKey: string | undefined;
  /** keel's `KEEL_COMMIT_SIGNERS`. */
  readonly commitSigners: string | undefined;
}

function holdsNoSigner(signers: string | undefined): boolean {
  if (signers === undefined) return true;
  try {
    const list: unknown = JSON.parse(signers);
    return !Array.isArray(list) || list.length === 0;
  } catch {
    return true;
  }
}

/**
 * Whether this run makes keel's keys. It does when keel holds none of them: a
 * first install, or one that stopped before keel deployed. It keeps them when
 * keel holds all four and both public halves are still shown. Anything between
 * stops the run: a key made a second time signs every user out, refuses every
 * token and leaves trunk's commits verifying against a key nobody lists, so no
 * run mints one beside a key that is already held.
 */
export function keyState(
  held: ReadonlySet<string>,
  shown: PublicHalves,
): "generate" | "keep" | { refuse: string } {
  const have = GENERATED_SECRETS.filter((secret) => held.has(secret));
  if (have.length === 0) return "generate";
  const lacking = GENERATED_SECRETS.filter((secret) => !held.has(secret));
  if (lacking.length > 0)
    return {
      refuse: `keel holds ${have.join(", ")} but not ${lacking.join(", ")}. The install makes its keys together, once, and will not make ${lacking.length === 1 ? "one" : "some"} beside keys already held: set what is missing with \`wrangler secret put\`, or delete the Worker \`keel\` to start again.`,
    };
  const unshown = [
    ...(shown.bundleUrlPublicKey === undefined || shown.bundleUrlPublicKey === ""
      ? ["keel-verify's BUNDLE_URL_PUBLIC_KEY"]
      : []),
    ...(holdsNoSigner(shown.commitSigners) ? ["keel's KEEL_COMMIT_SIGNERS"] : []),
  ];
  if (unshown.length > 0)
    return {
      refuse: `keel holds its keys, but ${unshown.join(" and ")} ${unshown.length === 1 ? "is" : "are"} no longer set, and a public half cannot be read back from a secret. Set ${unshown.length === 1 ? "it" : "them"} again from the key's own public half; the install will not make a second key.`,
    };
  return "keep";
}

export interface GeneratedKeys {
  /** keel's secrets, by name: `GENERATED_SECRETS`. */
  readonly secrets: Readonly<Record<(typeof GENERATED_SECRETS)[number], string>>;
  /** keel-verify's `BUNDLE_URL_PUBLIC_KEY`: SPKI, PEM. */
  readonly bundleUrlPublicKey: string;
  /** keel's `KEEL_COMMIT_SIGNERS`: the one key, valid from the start of the day it was made. */
  readonly commitSigners: string;
}

/** An Ed25519 public key as OpenSSH writes it, with no comment: `ssh-ed25519 <base64>`. */
function openssh(rawPublicKey: Buffer): string {
  const name = Buffer.from("ssh-ed25519");
  return `ssh-ed25519 ${Buffer.concat([sshField(name), sshField(rawPublicKey)]).toString("base64")}`;
}

/** One field of an OpenSSH key: its length in four bytes, then its bytes. */
function sshField(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** A key Node exported as PEM: text, whatever type the export is declared with. */
const pem = (exported: string | Buffer): string =>
  typeof exported === "string" ? exported : exported.toString("utf8");

/**
 * Keel's keys, each made here and apart from the others: the key that signs
 * agents' tokens (a private JWK), Better Auth's secret, the pair that signs
 * bundle URLs and the key that signs the commits Keel composes (both PKCS#8,
 * PEM), with the two public halves the Workers are told as plain settings.
 */
export function generateKeys(now: Date): GeneratedKeys {
  const day = now.toISOString().slice(0, 10);
  const tokens = generateKeyPairSync("ed25519");
  const bundles = generateKeyPairSync("ed25519");
  const commits = generateKeyPairSync("ed25519");
  const commitsPublic = commits.publicKey.export({ format: "jwk" }).x;
  if (commitsPublic === undefined) throw new Error("Ed25519 did not export a public key");
  return {
    secrets: {
      KEEL_SIGNING_KEY: JSON.stringify({
        ...tokens.privateKey.export({ format: "jwk" }),
        kid: `keel-${day}`,
      }),
      BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
      BUNDLE_URL_SIGNING_KEY: pem(bundles.privateKey.export({ type: "pkcs8", format: "pem" })),
      KEEL_COMMIT_SIGNING_KEY: pem(commits.privateKey.export({ type: "pkcs8", format: "pem" })),
    },
    bundleUrlPublicKey: pem(bundles.publicKey.export({ type: "spki", format: "pem" })),
    commitSigners: JSON.stringify([
      {
        publicKey: openssh(Buffer.from(commitsPublic, "base64url")),
        validAfter: `${day}T00:00:00Z`,
      },
    ]),
  };
}

/**
 * How many random bytes a Secrets Store secret is made of, by the binding it
 * is bound as, for the ones an install can make. Any other must already be in
 * the account's store: the install has no value to give it.
 */
const STORE_SECRET_BYTES: Readonly<Record<string, number>> = { CREDENTIAL_KEK: 32 };

/** A new value for a Secrets Store secret (base64), or undefined when the install has no source for it. */
export function storeSecretValue(binding: string): string | undefined {
  const bytes = STORE_SECRET_BYTES[binding];
  return bytes === undefined ? undefined : randomBytes(bytes).toString("base64");
}

/** Config keys that name nothing an account must hold before the Worker deploys. */
const NEEDS_NOTHING = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "observability",
  "vars",
  "secrets",
  "assets",
  "ratelimits",
  "durable_objects",
  "migrations",
  "workflows",
  "triggers",
  "services",
  // Unrestricted, it names no address: an install leaves KEEL_MAIL_FROM empty and sends nothing.
  "send_email",
  "containers",
  "worker_loaders",
  "ai",
  "limits",
]);

/** Config keys that name a store the account must hold before the Worker deploys. */
const STORE_KEYS = new Set([
  "d1_databases",
  "r2_buckets",
  "queues",
  "artifacts",
  "secrets_store_secrets",
]);

/** What the three configs bind that the account must hold first, each by its name. */
export interface Stores {
  readonly d1: readonly string[];
  readonly buckets: readonly { readonly name: string; readonly binding: string }[];
  readonly queues: readonly string[];
  readonly namespaces: readonly string[];
  readonly storeSecrets: readonly { readonly name: string; readonly binding: string }[];
}

const named = (source: string, kind: string, item: Json, key: string): string => {
  const name = stringAt(item, key);
  if (name === undefined || name === "") throw new Error(`${source}: a ${kind} with no ${key}`);
  return name;
};

const bound =
  (key: string, kind: string, nameKey: string) =>
  (config: Json, source: string): { name: string; binding: string }[] =>
    objectsAt(config, key).map((item) => ({
      name: named(source, kind, item, nameKey),
      binding: named(source, kind, item, "binding"),
    }));
const d1Of = bound("d1_databases", "D1 binding", "database_name");
const bucketsOf = bound("r2_buckets", "R2 binding", "bucket_name");
const namespacesOf = bound("artifacts", "Artifacts binding", "namespace");
const storeSecretsOf = bound("secrets_store_secrets", "Secrets Store binding", "secret_name");
const queuesOf = (config: Json, source: string): string[] => {
  const queues = isObject(config["queues"]) ? config["queues"] : {};
  return [
    ...objectsAt(queues, "producers").map((q) => named(source, "queue producer", q, "queue")),
    ...objectsAt(queues, "consumers").map((q) => named(source, "queue consumer", q, "queue")),
  ];
};

const unique = (names: readonly string[]): string[] => [...new Set(names)];
/** Each store once, whichever of the configs names it first. */
const byName = <T extends { name: string }>(items: readonly T[]): T[] =>
  items.filter((item, at) => items.findIndex((other) => other.name === item.name) === at);

/**
 * The stores to ensure, read from the configs themselves. A config key the
 * install was never taught stops it by name: a binding to something nobody
 * creates would fail the deploy of whoever presses the button, long after the
 * push that added it.
 */
export function storesOf(configs: readonly { source: string; config: Json }[]): Stores {
  const untaught = configs.flatMap(({ source, config }) =>
    Object.keys(config)
      .filter((key) => !NEEDS_NOTHING.has(key) && !STORE_KEYS.has(key))
      .map((key) => `${source}: ${key}`),
  );
  if (untaught.length > 0)
    throw new Error(
      `the install does not know how to provide ${untaught.join(", ")}. Teach scripts/lib/install.ts what the binding needs on a new account (a store to ensure, or nothing), so the Deploy to Cloudflare button keeps working.`,
    );
  const read = <T>(reader: (config: Json, source: string) => T[]): T[] =>
    configs.flatMap(({ source, config }) => reader(config, source));
  return {
    d1: unique(read(d1Of).map((db) => db.name)),
    buckets: byName(read(bucketsOf)),
    queues: unique(read(queuesOf)),
    namespaces: unique(read(namespacesOf).map((namespace) => namespace.name)),
    storeSecrets: byName(read(storeSecretsOf)),
  };
}

/** What a rendered config is filled with: the account's own ids and the site's host. */
export interface InstallValues {
  /** The site's one host. */
  readonly host: string;
  /** Each D1 database's id, by its name. */
  readonly d1: Readonly<Record<string, string>>;
  /** The account's Secrets Store, when a config binds a secret from it. */
  readonly secretsStoreId: string | undefined;
  readonly bundleUrlPublicKey: string;
  readonly commitSigners: string;
}

/** A value no deploy may carry: an id nobody filled in. */
const SENTINEL = /00000000-0000-0000-0000-000000000000|PLACEHOLDER-[\w-]*/;

/**
 * A committed config with a real account's values in it: the text of the
 * `wrangler.deploy.jsonc` beside it. It throws while any sentinel survives, so
 * wrangler is never handed an id that names nothing.
 */
export function renderInstall(source: string, text: string, values: InstallValues): string {
  let rendered = text;
  const set = (path: (string | number)[], value: string) => {
    rendered = applyEdits(
      rendered,
      modify(rendered, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  };
  const committed = parseConfig(text, source);
  for (const [index, database] of objectsAt(committed, "d1_databases").entries()) {
    const name = named(source, "D1 binding", database, "database_name");
    const id = values.d1[name];
    if (id === undefined) throw new Error(`${source}: no id for D1 database ${name}`);
    set(["d1_databases", index, "database_id"], id);
  }
  for (const [index, secret] of objectsAt(committed, "secrets_store_secrets").entries()) {
    if (values.secretsStoreId === undefined)
      throw new Error(
        `${source}: no Secrets Store for ${named(source, "Secrets Store binding", secret, "secret_name")}`,
      );
    set(["secrets_store_secrets", index, "store_id"], values.secretsStoreId);
  }
  const vars = isObject(committed["vars"]) ? committed["vars"] : {};
  set(["vars", "KEEL_HOST"], values.host);
  if ("BUNDLE_URL_PUBLIC_KEY" in vars)
    set(["vars", "BUNDLE_URL_PUBLIC_KEY"], values.bundleUrlPublicKey);
  if ("KEEL_COMMIT_SIGNERS" in vars) set(["vars", "KEEL_COMMIT_SIGNERS"], values.commitSigners);
  const leftover = SENTINEL.exec(JSON.stringify(parseConfig(rendered, source)));
  if (leftover !== null)
    throw new Error(
      `${source}: sentinel ${leftover[0]} survives rendering. Refusing to deploy a config that names nothing.`,
    );
  return rendered;
}

/** The name the config gives its Worker. */
export function workerName(config: Json, source: string): string {
  const name = stringAt(config, "name");
  if (name === undefined || name === "") throw new Error(`${source}: no name`);
  return name;
}

/** The secrets a config's `secrets.required` names. */
export function requiredSecrets(config: Json): string[] {
  const secrets = isObject(config["secrets"]) ? config["secrets"]["required"] : undefined;
  return Array.isArray(secrets) ? secrets.filter((s): s is string => typeof s === "string") : [];
}

/** A plain setting of a deployed Worker, from the bindings its settings list. */
export function plainSetting(settings: unknown, name: string): string | undefined {
  const bindings: unknown = isObject(settings) ? settings["bindings"] : undefined;
  if (!Array.isArray(bindings)) return undefined;
  const found = bindings
    .filter(isObject)
    .find((binding) => binding["name"] === name && binding["type"] === "plain_text");
  return found === undefined ? undefined : stringAt(found, "text");
}
