// Deploys every Worker to an environment, in dependency order:
//   node scripts/deploy.ts staging            render, check, deploy
//   node scripts/deploy.ts staging --check    render and check only
//   node scripts/deploy.ts staging --only console
//                                             render and check every config, deploy one app
//   node scripts/deploy.ts staging --rotate CONSOLE_PRESENTER_KEY
//                                             replace a console key, kept in .keel/<env>.json
// Account-specific ids come only from Terraform's outputs. A missing output, or
// a sentinel left in a rendered config, stops the deploy before wrangler runs,
// and wrangler's automatic provisioning is switched off, so nothing is ever
// created behind Terraform's back (rule R13).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import { pinProblems } from "../packages/tooling/src/guards/model-pins.ts";
import { accountId, cloudflare, root, wrangler } from "./env.ts";

const USAGE =
  "usage: node scripts/deploy.ts <env> [--check] [--only <app>] [--rotate <console key>]";

function usage(reason: string): never {
  console.error(`${reason}\n${USAGE}`);
  process.exit(2);
}

/**
 * The arguments. Any it does not know stops the script before it renders
 * anything: a mistyped or merged flag must never fall through to a full deploy.
 */
function parseArguments(argv: readonly string[]): {
  environment: string;
  checkOnly: boolean;
  only: string | undefined;
  rotate: string | undefined;
} {
  if (argv.length === 0)
    return { environment: "staging", checkOnly: false, only: undefined, rotate: undefined };
  const [environment = "", ...rest] = argv;
  if (!/^[a-z][a-z0-9-]*$/.test(environment))
    usage(`the first argument names the environment, not ${JSON.stringify(environment)}`);
  const parsed = {
    environment,
    checkOnly: false,
    only: undefined as string | undefined,
    rotate: undefined as string | undefined,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--check") {
      parsed.checkOnly = true;
    } else if (arg === "--only" || arg === "--rotate") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) usage(`${arg} needs a value`);
      parsed[arg === "--only" ? "only" : "rotate"] = value;
      i += 1;
    } else {
      usage(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return parsed;
}
const { environment, checkOnly, only, rotate } = parseArguments(process.argv.slice(2));

/** keel binds keel-verify's SANDBOX class and VERIFIER entrypoint, so keel-verify goes first. */
const APPS = ["keel-verify", "keel", "console"] as const;

/**
 * The console's generated keys, by the field `.keel/<env>.json` keeps each
 * under `console`. A Worker's secret cannot be read back, so the file is the
 * only place anyone can learn one.
 */
const CONSOLE_KEYS = {
  CONSOLE_CAPABILITY_KEY: "capabilityKey",
  CONSOLE_PRESENTER_KEY: "presenterKey",
} as const;
type ConsoleKey = keyof typeof CONSOLE_KEYS;
const isConsoleKey = (name: string): name is ConsoleKey => Object.hasOwn(CONSOLE_KEYS, name);

if (rotate !== undefined && !isConsoleKey(rotate)) {
  usage(
    `--rotate takes ${Object.keys(CONSOLE_KEYS).join(" or ")}, not ${rotate}. KEEL_SIGNING_KEY is never rotated here: a new one voids every token already issued.`,
  );
}
if (only !== undefined && !APPS.some((app) => app === only))
  usage(`--only takes one of ${APPS.join(", ")}, not ${only}`);

const SENTINEL = /00000000-0000-0000-0000-000000000000|PLACEHOLDER-[\w-]*/;
const NO_PROVISIONING = ["--no-x-provision", "--no-x-auto-create"];

type Json = Record<string, unknown>;

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

function parseConfig(text: string, source: string): Json {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isObject(config)) {
    throw new Error(
      `${source}: not valid JSONC (${errors.map((e) => printParseErrorCode(e.error)).join(", ")})`,
    );
  }
  return config;
}

function terraformOutputs(): Map<string, string> {
  const run = spawnSync(
    "terraform",
    [`-chdir=${join(root, "infra", environment)}`, "output", "-json"],
    { encoding: "utf8" },
  );
  if (run.status !== 0)
    throw new Error(`terraform output failed for ${environment}:\n${run.stderr}`);
  const raw: unknown = JSON.parse(run.stdout);
  const outputs = new Map<string, string>();
  if (isObject(raw)) {
    for (const [name, output] of Object.entries(raw)) {
      const value = isObject(output) ? output["value"] : undefined;
      if (typeof value === "string" && value !== "") outputs.set(name, value);
    }
  }
  return outputs;
}

function requireOutput(outputs: ReadonlyMap<string, string>, name: string, wanted: string): string {
  const value = outputs.get(name);
  if (value === undefined) {
    throw new Error(
      `Terraform output ${name} (for ${wanted}) is missing in ${environment}; run \`node scripts/tf.ts ${environment} apply\`. Refusing to deploy, so wrangler cannot provision it.`,
    );
  }
  return value;
}

/** Writes apps/<dir>/wrangler.deploy.jsonc (gitignored) with the real ids and host filled in. */
function render(
  dir: string,
  outputs: ReadonlyMap<string, string>,
  subdomain: string,
): { name: string; config: Json } {
  const source = `apps/${dir}/wrangler.jsonc`;
  let text = readFileSync(join(root, source), "utf8");
  const set = (path: (string | number)[], value: string) => {
    text = applyEdits(
      text,
      modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  };
  const committed = parseConfig(text, source);
  const name = stringAt(committed, "name");
  if (name === undefined) throw new Error(`${source}: no name`);

  for (const [index, database] of objectsAt(committed, "d1_databases").entries()) {
    const databaseName = stringAt(database, "database_name");
    if (databaseName !== `keel-${environment}`)
      throw new Error(`${source}: no Terraform output holds the id of D1 database ${databaseName}`);
    set(
      ["d1_databases", index, "database_id"],
      requireOutput(outputs, "d1_database_id", `D1 ${databaseName}`),
    );
  }
  for (const [index, secret] of objectsAt(committed, "secrets_store_secrets").entries()) {
    set(
      ["secrets_store_secrets", index, "store_id"],
      requireOutput(outputs, "secrets_store_id", `secret ${stringAt(secret, "secret_name")}`),
    );
  }
  set(["vars", "KEEL_HOST"], `${name}.${subdomain}.workers.dev`);
  // A Worker that names Keel's own host (the console) gets this environment's.
  const vars = committed["vars"];
  if (isObject(vars) && "KEEL_API_HOST" in vars)
    set(["vars", "KEEL_API_HOST"], `keel.${subdomain}.workers.dev`);

  const rendered = parseConfig(text, `apps/${dir}/wrangler.deploy.jsonc`);
  const pins = pinProblems(rendered);
  if (pins.length > 0)
    throw new Error(
      `${source}: ${pins.join("; ")}. Refusing to deploy: a PlatformFunction would run on no model, or one nobody chose.`,
    );
  const leftover = SENTINEL.exec(JSON.stringify(rendered));
  if (leftover !== null) {
    throw new Error(
      `${source}: sentinel ${leftover[0]} survives rendering. Refusing to deploy: wrangler would provision a resource behind Terraform's back.`,
    );
  }
  writeFileSync(join(root, "apps", dir, "wrangler.deploy.jsonc"), text);
  return { name, config: rendered };
}

/** Fails loudly, naming the resource, when a store the config binds does not exist. */
async function verifyStores(name: string, config: Json): Promise<void> {
  for (const bucket of objectsAt(config, "r2_buckets")) {
    const bucketName = stringAt(bucket, "bucket_name") ?? "";
    await cloudflare("GET", `/r2/buckets/${bucketName}`).catch((error: unknown) => {
      throw new Error(
        `${name}: R2 bucket ${bucketName} does not exist; declare it in infra/${environment}`,
        { cause: error },
      );
    });
  }
  for (const database of objectsAt(config, "d1_databases")) {
    const id = stringAt(database, "database_id") ?? "";
    await cloudflare("GET", `/d1/database/${id}`).catch((error: unknown) => {
      throw new Error(`${name}: D1 database ${id} does not exist; re-run Terraform`, {
        cause: error,
      });
    });
  }
}

async function workerExists(name: string): Promise<boolean> {
  try {
    await cloudflare("GET", `/workers/scripts/${name}/settings`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes(": 404 ")) return false;
    throw error;
  }
}

/** 32 random bytes, base64url: a key the console signs or unlocks with. */
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

/** The console's credentials, from the seed (scripts/seed.ts) of this environment. */
function seededCredential(
  role: "observer" | "operator",
  part: "clientId" | "clientSecret",
): string {
  const path = join(root, ".keel", `${environment}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `The console needs the ${role}'s credential from ${path}, which does not exist: run \`node scripts/seed.ts ${environment}\` (Keel is deployed by now), then deploy again.`,
    );
  }
  const value: unknown = Reflect.get(
    Object(Reflect.get(Object(JSON.parse(readFileSync(path, "utf8"))), role)),
    part,
  );
  if (typeof value !== "string" || value === "")
    throw new Error(`${path} holds no ${role} ${part}`);
  return value;
}

const SEEDED: Readonly<
  Record<string, readonly ["observer" | "operator", "clientId" | "clientSecret"]>
> = {
  KEEL_OBSERVER_CLIENT_ID: ["observer", "clientId"],
  KEEL_OBSERVER_CLIENT_SECRET: ["observer", "clientSecret"],
  KEEL_OPERATOR_CLIENT_ID: ["operator", "clientId"],
  KEEL_OPERATOR_CLIENT_SECRET: ["operator", "clientSecret"],
};

const seedFile = join(root, ".keel", `${environment}.json`);

/** `.keel/<env>.json` as an object; scripts/seed.ts writes everything in it but `console`. */
function seedFileContents(): Json {
  if (!existsSync(seedFile)) return {};
  const contents: unknown = JSON.parse(readFileSync(seedFile, "utf8"));
  return isObject(contents) ? contents : {};
}

/** The console key `.keel/<env>.json` holds, if it holds one. */
function knownConsoleKey(secret: ConsoleKey): string | undefined {
  const keys = seedFileContents()["console"];
  const value = isObject(keys) ? keys[CONSOLE_KEYS[secret]] : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Keeps a new console key in `.keel/<env>.json` (gitignored, 0600) before
 * wrangler sets it: replaced whole through a rename, so a crash never leaves
 * the seeded credentials half written.
 */
function recordConsoleKey(secret: ConsoleKey, value: string): void {
  const contents = seedFileContents();
  const keys = isObject(contents["console"]) ? contents["console"] : {};
  const next = { ...contents, console: { ...keys, [CONSOLE_KEYS[secret]]: value } };
  mkdirSync(join(root, ".keel"), { recursive: true, mode: 0o700 });
  const staged = `${seedFile}.${process.pid}`;
  writeFileSync(staged, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(staged, 0o600);
  renameSync(staged, seedFile);
}

/** A short digest that matches a deploy's log to the file without printing the key. */
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;

/**
 * A console key's value for this deploy, or undefined to leave the Worker's
 * own. A new key voids every link or session made with the old one, so one is
 * made only when `--rotate` names it or nobody has one; a key the file holds
 * is set from it, which also heals a deploy that died after writing it.
 */
function consoleKeyFor(name: string, secret: ConsoleKey, onWorker: boolean): string | undefined {
  const known = knownConsoleKey(secret);
  let value: string;
  let source: string;
  if (rotate === secret) {
    value = randomKey();
    recordConsoleKey(secret, value);
    source = "rotated (--rotate)";
  } else if (known !== undefined) {
    value = known;
    source = `from .keel/${environment}.json`;
  } else if (onWorker) {
    console.log(
      `${name}: ${secret} kept (not in .keel/${environment}.json: --rotate ${secret} to know it)`,
    );
    return undefined;
  } else {
    value = randomKey();
    recordConsoleKey(secret, value);
    source = "generated (the Worker had none)";
  }
  console.log(`${name}: ${secret} ${source}, ${digest(value)}`);
  return value;
}

async function signingKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify({ ...jwk, kid: `${environment}-${new Date().toISOString().slice(0, 10)}` });
}

/** The secrets a config's `secrets.required` names. */
function requiredSecrets(config: Json): string[] {
  const secrets = isObject(config["secrets"]) ? config["secrets"]["required"] : undefined;
  return Array.isArray(secrets) ? secrets.filter((s): s is string => typeof s === "string") : [];
}

/**
 * The value of every secret the config requires. CLOUDFLARE_ACCOUNT_ID and
 * KEEL_BOOTSTRAP_SECRET (Terraform's output, so replacing it there rotates it
 * here) are set on every deploy; KEEL_SIGNING_KEY only when the Worker lacks
 * one, because a new key invalidates every token already issued. The
 * console's observer and operator credentials come from the seed on every
 * deploy; its capability and presenter keys as `consoleKeyFor` decides.
 */
async function secretsFor(
  name: string,
  config: Json,
  outputs: ReadonlyMap<string, string>,
): Promise<Record<string, string>> {
  const required = requiredSecrets(config);
  const existing = new Set<string>();
  if (required.length > 0 && (await workerExists(name))) {
    const listed: unknown = JSON.parse(
      wrangler(["secret", "list", "--name", name, "--format", "json"], { quiet: true }),
    );
    for (const secret of Array.isArray(listed) ? listed.filter(isObject) : [])
      existing.add(stringAt(secret, "name") ?? "");
  }
  const values: Record<string, string> = {};
  for (const secret of required) {
    if (secret === "CLOUDFLARE_ACCOUNT_ID") {
      values[secret] = accountId();
    } else if (secret === "KEEL_BOOTSTRAP_SECRET") {
      values[secret] = requireOutput(outputs, "bootstrap_secret", secret);
    } else if (secret === "KEEL_SIGNING_KEY") {
      if (existing.has(secret)) {
        console.log(`${name}: KEEL_SIGNING_KEY kept`);
      } else {
        values[secret] = await signingKey();
        console.log(`${name}: KEEL_SIGNING_KEY generated (the Worker had none)`);
      }
    } else if (SEEDED[secret] !== undefined) {
      const [role, part] = SEEDED[secret];
      values[secret] = seededCredential(role, part);
    } else if (isConsoleKey(secret)) {
      const value = consoleKeyFor(name, secret, existing.has(secret));
      if (value !== undefined) values[secret] = value;
    } else {
      throw new Error(
        `${name} requires secret ${secret}, and scripts/deploy.ts has no source for it`,
      );
    }
  }
  return values;
}

/**
 * On macOS the docker CLI reaches for docker-credential-osxkeychain whenever it
 * is on PATH, and wrangler's registry login then fails (spike S4). Container
 * builds get a PATH whose docker has no helper beside it and an empty config.
 */
function containerBuildEnv(scratch: string): Record<string, string> {
  const bin = join(scratch, "bin");
  const config = join(scratch, "docker");
  mkdirSync(bin);
  mkdirSync(config);
  const docker = realpathSync(execFileSync("which", ["docker"], { encoding: "utf8" }).trim());
  symlinkSync(docker, join(bin, "docker"));
  writeFileSync(join(config, "config.json"), "{}");
  const plugins = join(homedir(), ".docker", "cli-plugins");
  if (existsSync(plugins)) symlinkSync(plugins, join(config, "cli-plugins"));
  const host = execFileSync(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { encoding: "utf8" },
  ).trim();
  const path = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => !existsSync(join(dir, "docker-credential-osxkeychain")));
  return { PATH: [bin, ...path].join(delimiter), DOCKER_CONFIG: config, DOCKER_HOST: host };
}

const outputs = terraformOutputs();
const subdomainResult = await cloudflare("GET", "/workers/subdomain");
const subdomain = isObject(subdomainResult) ? stringAt(subdomainResult, "subdomain") : undefined;
if (subdomain === undefined) throw new Error("The account has no workers.dev subdomain");

// Render and check every config before deploying any, so a bad one stops the whole deploy.
const rendered = APPS.map((dir) => ({ dir, ...render(dir, outputs, subdomain) }));
for (const app of rendered) await verifyStores(app.name, app.config);
const deploying = rendered.filter((app) => only === undefined || app.dir === only);
if (rotate !== undefined && !deploying.some((app) => requiredSecrets(app.config).includes(rotate)))
  throw new Error(`--rotate ${rotate}: no app this deploy reaches requires it`);
if (checkOnly) {
  console.log(
    `${environment}: every config rendered with no sentinel left, and every bound store exists`,
  );
  process.exit(0);
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const untouched = rendered.filter((app) => !deploying.includes(app)).map((app) => app.name);
console.log(
  `${environment}: deploying ${deploying.map((app) => app.name).join(", ")} at ${head}${untouched.length > 0 ? `; ${untouched.join(", ")} untouched` : ""}`,
);
const scratch = mkdtempSync(join(tmpdir(), "keel-deploy-"));
try {
  for (const app of deploying) {
    const cwd = join(root, "apps", app.dir);
    const args = ["deploy", "-c", "wrangler.deploy.jsonc", ...NO_PROVISIONING];
    if (objectsAt(app.config, "d1_databases").length > 0) {
      wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", "wrangler.deploy.jsonc"], {
        cwd,
        stream: true,
      });
    }
    // A Worker with a build step (the console's vite build) builds before it deploys.
    execFileSync("pnpm", ["--dir", cwd, "run", "--if-present", "build"], { stdio: "inherit" });
    const secrets = await secretsFor(app.name, app.config, outputs);
    const containers = objectsAt(app.config, "containers").length > 0;
    console.log(
      `\n== ${app.name}: deploying${containers ? " (building its container image)" : ""}`,
    );
    wrangler(Object.keys(secrets).length > 0 ? [...args, "--secrets-file", "/dev/stdin"] : args, {
      cwd,
      stream: true,
      ...(Object.keys(secrets).length > 0 ? { input: JSON.stringify(secrets) } : {}),
      ...(containers ? { env: containerBuildEnv(mkdtempSync(join(scratch, `${app.dir}-`))) } : {}),
    });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  `\ndeployed ${environment} at ${head}${untouched.length > 0 ? ` (${untouched.join(", ")} untouched)` : ""}:`,
);
for (const app of deploying) console.log(`  https://${app.name}.${subdomain}.workers.dev`);
