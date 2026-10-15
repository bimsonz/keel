// Deploys every Worker to an environment, in dependency order:
//   node scripts/deploy.ts staging            render, check, deploy
//   node scripts/deploy.ts staging --check    render and check only
//   node scripts/deploy.ts staging --only console
//                                             render and check every config, deploy one app
// Account-specific ids come only from Terraform's outputs. A missing output, or
// a sentinel left in a rendered config, stops the deploy before wrangler runs,
// and wrangler's automatic provisioning is switched off, so nothing is ever
// created behind Terraform's back (rule R13).
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import { CLIENT_ID_VAR, oauthClientAtDeploy } from "./lib/oauth-client.ts";
import { examplePinProblems, pinProblems } from "../packages/tooling/src/guards/model-pins.ts";
import { accountId, cloudflare, root, wrangler } from "./env.ts";
import { ApiRefused, verifyStore } from "./lib/cloudflare-api.ts";

const USAGE = "usage: node scripts/deploy.ts <env> [--check] [--only <app>]";

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
} {
  if (argv.length === 0) return { environment: "staging", checkOnly: false, only: undefined };
  const [environment = "", ...rest] = argv;
  if (!/^[a-z][a-z0-9-]*$/.test(environment))
    usage(`the first argument names the environment, not ${JSON.stringify(environment)}`);
  const parsed = {
    environment,
    checkOnly: false,
    only: undefined as string | undefined,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--check") {
      parsed.checkOnly = true;
    } else if (arg === "--only") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) usage(`${arg} needs a value`);
      parsed.only = value;
      i += 1;
    } else {
      usage(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return parsed;
}
const { environment, checkOnly, only } = parseArguments(process.argv.slice(2));

/**
 * keel binds keel-verify's SANDBOX class and VERIFIER entrypoint, so keel-verify
 * goes first. The swarm is an example: hosted agents that use Keel only through
 * its public API, deployed beside it.
 */
const APPS = ["keel-verify", "keel", "console", "swarm"] as const;
type App = (typeof APPS)[number];

/** Where each Worker's source is. */
const SOURCE: Readonly<Record<App, string>> = {
  "keel-verify": "apps/keel-verify",
  keel: "apps/keel",
  console: "apps/console",
  swarm: "examples/swarm",
};

/**
 * A Worker whose build writes the config it deploys from: the swarm's Vite
 * build (Flue) adds its entry and its agent's Durable Object to the rendered
 * config. The others deploy from the rendered config itself.
 */
const BUILT_CONFIG: Readonly<Partial<Record<App, string>>> = {
  swarm: "dist/keel_swarm/wrangler.json",
};

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
      // An empty output is as good as missing.
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

/** Writes <source>/wrangler.deploy.jsonc (gitignored) with the real ids and host filled in. */
function render(dir: App, outputs: ReadonlyMap<string, string>): { name: string; config: Json } {
  const source = `${SOURCE[dir]}/wrangler.jsonc`;
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
  // One site: every Worker names it as its host, and the console names it as Keel's.
  const host = requireOutput(outputs, "keel_host", "the site's host");
  set(["vars", "KEEL_HOST"], host);
  const vars = committed["vars"];
  if (isObject(vars) && "KEEL_API_HOST" in vars) set(["vars", "KEEL_API_HOST"], host);
  // Sign-in codes come from the site's mail subdomain, which is onboarded to Email Service's sending.
  if (isObject(vars) && "KEEL_MAIL_FROM" in vars)
    set(["vars", "KEEL_MAIL_FROM"], `noreply@mail.${host}`);
  // The half of the bundle URL key pair that only verifies: a var, so keel-verify holds no secret.
  if (isObject(vars) && "BUNDLE_URL_PUBLIC_KEY" in vars)
    set(
      ["vars", "BUNDLE_URL_PUBLIC_KEY"],
      requireOutput(outputs, "bundle_url_public_key", "the bundle URL public key"),
    );

  // Keel's OAuth client on Cloudflare: for the instance's users, never a condition of deploying the instance.
  const oauthClient = oauthClientAtDeploy(committed, outputs);
  if (oauthClient.kind === "registered") set(["vars", CLIENT_ID_VAR], oauthClient.clientId);
  if (oauthClient.kind === "unregistered") {
    if (oauthClient.dropSecretAt !== undefined)
      text = applyEdits(
        text,
        modify(text, ["secrets_store_secrets", oauthClient.dropSecretAt], undefined, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
    console.log(`${source}: ${oauthClient.said}`);
  }

  // The keys Keel's commits verify against: its signers file, and what its composer checks its own key by.
  if (isObject(vars) && "KEEL_COMMIT_SIGNERS" in vars)
    set(
      ["vars", "KEEL_COMMIT_SIGNERS"],
      requireOutput(outputs, "commit_signers", "the keys Keel signs commits with"),
    );

  const rendered = parseConfig(text, `${SOURCE[dir]}/wrangler.deploy.jsonc`);
  // An example runs no PlatformFunction: it names its own models in vars.*_MODEL.
  const pins = SOURCE[dir].startsWith("examples/")
    ? examplePinProblems(rendered)
    : pinProblems(rendered);
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
  writeFileSync(join(root, SOURCE[dir], "wrangler.deploy.jsonc"), text);
  return { name, config: rendered };
}

/** One read of the Cloudflare API. */
const read = (path: string): Promise<unknown> => cloudflare("GET", path);

/**
 * Fails loudly, naming the resource, when a store the config binds does not
 * exist, or when the API cannot say whether it does.
 */
async function verifyStores(name: string, config: Json): Promise<void> {
  for (const bucket of objectsAt(config, "r2_buckets")) {
    const bucketName = stringAt(bucket, "bucket_name") ?? "";
    await verifyStore(read, `/r2/buckets/${bucketName}`, {
      name: `${name}: R2 bucket ${bucketName}`,
      missing: `declare it in infra/${environment}`,
    });
  }
  for (const database of objectsAt(config, "d1_databases")) {
    const id = stringAt(database, "database_id") ?? "";
    await verifyStore(read, `/d1/database/${id}`, {
      name: `${name}: D1 database ${id}`,
      missing: "re-run Terraform",
    });
  }
}

async function workerExists(name: string): Promise<boolean> {
  try {
    await cloudflare("GET", `/workers/scripts/${name}/settings`);
    return true;
  } catch (error) {
    if (error instanceof ApiRefused && error.status === 404) return false;
    throw error;
  }
}

async function signingKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify({ ...jwk, kid: `${environment}-${new Date().toISOString().slice(0, 10)}` });
}

/** Secrets whose value is a Terraform output, so replacing the resource there rotates them. */
const FROM_TERRAFORM: Readonly<Record<string, string>> = {
  BETTER_AUTH_SECRET: "better_auth_secret",
  BUNDLE_URL_SIGNING_KEY: "bundle_url_signing_key",
  KEEL_COMMIT_SIGNING_KEY: "commit_signing_key",
  SWARM_ADMIN_TOKEN: "swarm_admin_token",
};

/** The secrets a config's `secrets.required` names. */
function requiredSecrets(config: Json): string[] {
  const secrets = isObject(config["secrets"]) ? config["secrets"]["required"] : undefined;
  return Array.isArray(secrets) ? secrets.filter((s): s is string => typeof s === "string") : [];
}

/**
 * The value of every secret the config requires. CLOUDFLARE_ACCOUNT_ID,
 * BETTER_AUTH_SECRET, BUNDLE_URL_SIGNING_KEY and KEEL_COMMIT_SIGNING_KEY (Terraform's outputs, so
 * replacing one there rotates it here) are set on every deploy; KEEL_SIGNING_KEY only when the Worker lacks
 * one, because a new key invalidates every token already issued. The console
 * requires none: it holds no credential.
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
    } else if (FROM_TERRAFORM[secret] !== undefined) {
      values[secret] = requireOutput(outputs, FROM_TERRAFORM[secret], secret);
    } else if (secret === "KEEL_SIGNING_KEY") {
      if (existing.has(secret)) {
        console.log(`${name}: KEEL_SIGNING_KEY kept`);
      } else {
        values[secret] = await signingKey();
        console.log(`${name}: KEEL_SIGNING_KEY generated (the Worker had none)`);
      }
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

/**
 * The routes and MCP tools are generated from the spec into gitignored files
 * that only `pnpm gen` writes, so a clone whose last gen predates a spec change
 * would deploy the old routes beside the new handlers (12 Oct: getChange still
 * demanded a token after e1dece5 let anyone read it). Every run generates them
 * from this tree first.
 */
function generate(): void {
  execFileSync("pnpm", ["gen"], { cwd: root, stdio: "inherit" });
}

/**
 * Only a committed tree deploys, so the SHA a deploy names is what runs. Checked
 * after generating, which would show a committed contract left behind its spec.
 */
function requireCommittedTree(): void {
  const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (changed !== "")
    throw new Error(`refusing to deploy uncommitted changes to tracked files:\n${changed}`);
}

/** The version a Worker serves to all its traffic, or undefined if Cloudflare names none. */
function liveVersion(name: string, cwd: string): string | undefined {
  try {
    const status: unknown = JSON.parse(
      wrangler(["deployments", "status", "--name", name, "--json"], { cwd, quiet: true }),
    );
    const versions: unknown = Reflect.get(Object(status), "versions");
    if (!Array.isArray(versions)) return undefined;
    const whole: unknown = versions.find((v) => Reflect.get(Object(v), "percentage") === 100);
    const id: unknown = Reflect.get(Object(whole), "version_id");
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

generate();
if (!checkOnly) requireCommittedTree();
const outputs = terraformOutputs();

// Render and check every config before deploying any, so a bad one stops the whole deploy.
const rendered = APPS.map((dir) => ({ dir, ...render(dir, outputs) }));
for (const app of rendered) {
  await verifyStores(app.name, app.config);
  // A secret Terraform has not output yet stops the deploy here, before any migration runs.
  for (const secret of requiredSecrets(app.config))
    if (FROM_TERRAFORM[secret] !== undefined)
      requireOutput(outputs, FROM_TERRAFORM[secret], secret);
}
const deploying = rendered.filter((app) => only === undefined || app.dir === only);
if (checkOnly) {
  console.log(
    `${environment}: every config rendered with no sentinel left, every bound store exists, and Terraform outputs every secret it owns`,
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
    const cwd = join(root, SOURCE[app.dir]);
    const args = [
      "deploy",
      "-c",
      BUILT_CONFIG[app.dir] ?? "wrangler.deploy.jsonc",
      ...NO_PROVISIONING,
    ];
    if (objectsAt(app.config, "d1_databases").length > 0) {
      wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", "wrangler.deploy.jsonc"], {
        cwd,
        stream: true,
      });
    }
    // A Worker with a build step (the console's vite build) builds before it deploys; one that
    // builds its own config (the swarm's) builds it from the rendered one, which names the real host.
    execFileSync("pnpm", ["--dir", cwd, "run", "--if-present", "build"], {
      stdio: "inherit",
      env: { ...process.env, KEEL_WRANGLER_CONFIG: "wrangler.deploy.jsonc" },
    });
    const secrets = await secretsFor(app.name, app.config, outputs);
    const containers = objectsAt(app.config, "containers").length > 0;
    console.log(
      `\n== ${app.name}: deploying${containers ? " (building its container image)" : ""}`,
    );
    const before = liveVersion(app.name, cwd);
    try {
      wrangler(Object.keys(secrets).length > 0 ? [...args, "--secrets-file", "/dev/stdin"] : args, {
        cwd,
        stream: true,
        ...(Object.keys(secrets).length > 0 ? { input: JSON.stringify(secrets) } : {}),
        ...(containers
          ? { env: containerBuildEnv(mkdtempSync(join(scratch, `${app.dir}-`))) }
          : {}),
      });
    } catch (error) {
      // Cloudflare's API sometimes answers a page of HTML, which wrangler reports as a
      // malformed response, before or after the deployment it asked for went through.
      // Cloudflare's own record of what serves says which, so the exit code can.
      const after = liveVersion(app.name, cwd);
      if (after === undefined || after === before) {
        console.error(
          `\n${app.name}: wrangler failed and Cloudflare still serves ${before ?? "no version"}: not deployed`,
        );
        throw error;
      }
      console.error(
        `\n${app.name}: wrangler failed, but Cloudflare now serves ${after} (was ${before ?? "no version"}): deployed`,
      );
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  `\ndeployed ${environment} at ${head}${untouched.length > 0 ? ` (${untouched.join(", ")} untouched)` : ""}:`,
);
console.log(
  `  https://${requireOutput(outputs, "keel_host", "the site's host")} (${deploying.map((app) => app.name).join(", ")})`,
);
