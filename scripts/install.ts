// Installs Keel on a Cloudflare account, from nothing, and brings an install
// up to this tree afterwards. It is the command the repository's Deploy to
// Cloudflare button runs on every push to a person's copy, and the command a
// pipeline of your own runs:
//   node scripts/install.ts             install, or update an install
//   node scripts/install.ts --check     ask the account what is there; change nothing
//   node scripts/install.ts --dry-run   no account: stand-in values, and every Worker bundled
// The token and the account come only from the environment
// (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or the CF_ names a build
// gives), never from a wrangler login: nobody installs over an account by
// running this in a shell that happens to be signed in.
//
// Every store the three configs bind is ensured by name through the API and
// its id rendered into a gitignored wrangler.deploy.jsonc beside each config.
// wrangler's own provisioning stays off, so nothing is made that this file
// does not name. Keel's keys are made once, with the first deploy of `keel`.
// oxlint-disable no-await-in-loop -- each store is ensured after the one before it, in the order its line is printed
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensure, everyPage, queueIdIn, verifyEnded } from "./lib/event-subscription.ts";
import {
  APPS,
  type App,
  ciEnvFor,
  CONFIG_OF,
  CONNECTED,
  generateKeys,
  GENERATED_SECRETS,
  type InstallValues,
  type Json,
  keyState,
  missingPermissions,
  parseConfig,
  plainSetting,
  renderInstall,
  requiredSecrets,
  siteHost,
  storeSecretValue,
  storesOf,
  workerName,
} from "./lib/install.ts";

const USAGE = "usage: node scripts/install.ts [--check | --dry-run]";
const argv = process.argv.slice(2);
// A mistyped flag must never fall through to an install.
if (
  argv.length > 1 ||
  (argv[0] !== undefined && argv[0] !== "--check" && argv[0] !== "--dry-run")
) {
  console.error(`unknown arguments ${JSON.stringify(argv)}\n${USAGE}`);
  process.exit(2);
}
const mode: "install" | "check" | "dry-run" =
  argv[0] === "--check" ? "check" : argv[0] === "--dry-run" ? "dry-run" : "install";

const root = join(import.meta.dirname, "..");
const wranglerBin = join(root, "apps/keel/node_modules/.bin/wrangler");
/** The committed stores' names carry the environment they were first made for. */
const ENVIRONMENT = "staging";
/** The R2 binding whose bucket holds a day of sandbox backups and no more. */
const EXPIRING_BINDING = "BACKUP_BUCKET";
const EXPIRY_RULE = "expire-after-1-day";

const token = process.env["CLOUDFLARE_API_TOKEN"] ?? process.env["CF_API_TOKEN"] ?? "";
const account = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? process.env["CF_ACCOUNT_ID"] ?? "";
if (mode !== "dry-run" && (token === "" || !/^[0-9a-f]{32}$/.test(account))) {
  console.error(
    "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to the account Keel is installed on. The install never uses a wrangler login.",
  );
  process.exit(2);
}
const childEnv: Record<string, string | undefined> = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  ...(mode === "dry-run" ? {} : { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }),
};

interface Answer {
  readonly status: number;
  readonly success: boolean;
  readonly result: unknown;
  readonly errors: string;
}

/** One Cloudflare API call on the account, whatever it answers. */
async function call(method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json().catch(() => undefined);
  const object = Object(json);
  return {
    status: response.status,
    success: Reflect.get(object, "success") === true,
    result: Reflect.get(object, "result"),
    errors: JSON.stringify(Reflect.get(object, "errors") ?? null).slice(0, 400),
  };
}

/** One call that must succeed, answering its result. `permission` is what the token needs for it. */
async function api(
  method: string,
  path: string,
  permission: string,
  body?: unknown,
): Promise<unknown> {
  const answer = await call(method, path, body);
  if (!answer.success)
    throw new Error(
      `${method} ${path}: ${answer.status} ${answer.errors}${answer.status === 401 || answer.status === 403 ? `\nThe token needs ${permission}.` : ""}`,
    );
  return answer.result;
}

/** A read of one thing that may not be there: its result, or undefined on a 404. */
async function find(path: string, permission: string): Promise<unknown> {
  const answer = await call("GET", path);
  if (answer.status === 404) return undefined;
  if (!answer.success)
    throw new Error(
      `GET ${path}: ${answer.status} ${answer.errors}${answer.status === 401 || answer.status === 403 ? `\nThe token needs ${permission}.` : ""}`,
    );
  return answer.result;
}

function wrangler(
  app: App,
  args: readonly string[],
  options: { input?: string; cwd?: string } = {},
): void {
  execFileSync(wranglerBin, [...args], {
    cwd: options.cwd ?? join(root, CONFIG_OF[app].dir),
    env: ciEnvFor(app, CONNECTED, childEnv),
    ...(options.input === undefined ? {} : { input: options.input }),
    stdio: [options.input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
  });
}

const objects = (value: unknown): Json[] =>
  Array.isArray(value)
    ? value.filter((item): item is Json => typeof item === "object" && item !== null)
    : [];
/** The string under `key` of something the API answered, if it holds one. */
const text = (value: unknown, key: string): string | undefined => {
  const found: unknown = Reflect.get(Object(value), key);
  return typeof found === "string" ? found : undefined;
};

// The routes and MCP tools are generated from the spec into gitignored files, so every run makes them first.
execFileSync("pnpm", ["gen"], { cwd: root, stdio: "inherit" });

const committed = APPS.map((app) => {
  const source = CONFIG_OF[app].file;
  const raw = readFileSync(join(root, source), "utf8");
  return { app, source, raw, config: parseConfig(raw, source) };
});
const configOf = (app: App) => {
  const found = committed.find((c) => c.app === app);
  if (found === undefined) throw new Error(`no config for ${app}`);
  return found;
};
const stores = storesOf(committed);
const unsourced = requiredSecrets(configOf("keel").config).filter(
  (secret) =>
    secret !== "CLOUDFLARE_ACCOUNT_ID" && !GENERATED_SECRETS.some((made) => made === secret),
);
if (unsourced.length > 0)
  throw new Error(`keel requires ${unsourced.join(", ")}, and the install has no source for it`);
for (const app of ["keel-verify", "console"] as const)
  if (requiredSecrets(configOf(app).config).length > 0)
    throw new Error(`${app} requires a secret, and the install gives secrets only to keel`);

/** Writes each Worker's wrangler.deploy.jsonc from its committed config and the account's values. */
function render(values: InstallValues): void {
  for (const { app, source, raw } of committed)
    writeFileSync(
      join(root, CONFIG_OF[app].dir, "wrangler.deploy.jsonc"),
      renderInstall(source, raw, values),
    );
}

/** The name the connected Worker deploys under: a build's own name for it, else the root config's. */
const consoleName =
  childEnv["WRANGLER_CI_OVERRIDE_NAME"] ?? workerName(configOf(CONNECTED).config, "wrangler.jsonc");

if (mode === "dry-run") {
  render({
    host: siteHost(consoleName, "example"),
    d1: Object.fromEntries(stores.d1.map((name) => [name, "11111111-1111-4111-8111-111111111111"])),
    secretsStoreId: "stand-in-secrets-store",
    bundleUrlPublicKey: "stand-in",
    commitSigners: "[]",
  });
  execFileSync("pnpm", ["--dir", join(root, "apps/console"), "run", "build"], { stdio: "inherit" });
  const scratch = mkdtempSync(join(tmpdir(), "keel-install-"));
  try {
    for (const app of APPS) {
      const name = app === CONNECTED ? consoleName : workerName(configOf(app).config, app);
      console.log(`\n== ${app}: bundling as ${name} (dry run)`);
      wrangler(app, [
        "deploy",
        "--dry-run",
        "-c",
        "wrangler.deploy.jsonc",
        "--outdir",
        join(scratch, app),
      ]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log("\ndry run: every config rendered with no sentinel left, and every Worker bundled");
  process.exit(0);
}

// Preflight: one read of each API the install will write through, so every
// missing permission is named together. A read proves the token reaches the
// API, not that it may write: a write that is refused names its permission.
const hasContainers = committed.some((c) => Array.isArray(c.config["containers"]));
const probes = await Promise.all(
  [
    { permission: "Workers Scripts: Edit", path: "/workers/subdomain", needed: true },
    { permission: "D1: Edit", path: "/d1/database?per_page=1", needed: stores.d1.length > 0 },
    {
      permission: "Workers R2 Storage: Edit",
      path: "/r2/buckets?per_page=1",
      needed: stores.buckets.length > 0,
    },
    { permission: "Queues: Edit", path: "/queues?per_page=1", needed: stores.queues.length > 0 },
    {
      permission: "Queues: Edit",
      path: "/event_subscriptions/subscriptions?per_page=1",
      needed: stores.queues.length > 0,
    },
    {
      permission: "Artifacts: Edit",
      path: "/artifacts/namespaces?limit=1",
      needed: stores.namespaces.length > 0,
    },
    { permission: "Containers: Edit", path: "/containers/me", needed: hasContainers },
    {
      permission: "Secrets Store: Edit",
      path: "/secrets_store/stores",
      needed: stores.storeSecrets.length > 0,
    },
  ]
    .filter((probe) => probe.needed)
    .map(async (probe) => ({
      permission: probe.permission,
      status: (await call("GET", probe.path)).status,
    })),
);
const missing = missingPermissions(probes);
if (missing.length > 0) {
  console.error(
    `The token cannot reach everything Keel needs on this account. It lacks:\n${missing.map((permission) => `  ${permission}`).join("\n")}\nNothing was changed. Give the build a token that has them (README, "Install on your own Cloudflare account") and run it again.`,
  );
  process.exit(1);
}
console.log(`preflight: the token reaches ${probes.length} of ${probes.length} APIs`);

const subdomain = text(await find("/workers/subdomain", "Workers Scripts: Edit"), "subdomain");
if (subdomain === undefined) {
  console.error(
    `This account has no workers.dev subdomain yet, and Keel's address is on it. Open Workers & Pages in the dashboard once to choose one (https://dash.cloudflare.com/${account}/workers/subdomain), then run this again. Nothing was changed.`,
  );
  process.exit(1);
}
const host = siteHost(consoleName, subdomain);
console.log(`site: https://${host}`);

const changing = mode === "install";
const made = (what: string, existed: boolean): void =>
  console.log(`${what}: ${existed ? "exists" : changing ? "created" : "missing"}`);
let absent = 0;

const d1: Record<string, string> = {};
for (const name of stores.d1) {
  const listed = objects(
    await api("GET", `/d1/database?name=${encodeURIComponent(name)}&per_page=100`, "D1: Edit"),
  ).find((db) => db["name"] === name);
  let id = text(listed, "uuid");
  made(`D1 database ${name}`, id !== undefined);
  if (id === undefined && changing)
    id = text(await api("POST", "/d1/database", "D1: Edit", { name }), "uuid");
  if (id === undefined) absent += 1;
  else d1[name] = id;
}

for (const bucket of stores.buckets) {
  const existed =
    (await find(`/r2/buckets/${bucket.name}`, "Workers R2 Storage: Edit")) !== undefined;
  made(`R2 bucket ${bucket.name}`, existed);
  if (!existed && changing)
    await api("POST", "/r2/buckets", "Workers R2 Storage: Edit", { name: bucket.name });
  if (!existed && !changing) absent += 1;
}

for (const queue of stores.queues) {
  const existed =
    queueIdIn(
      await api("GET", `/queues?name=${encodeURIComponent(queue)}`, "Queues: Edit"),
      queue,
    ) !== undefined;
  made(`queue ${queue}`, existed);
  if (!existed && changing) await api("POST", "/queues", "Queues: Edit", { queue_name: queue });
  if (!existed && !changing) absent += 1;
}

const namespaces = objects(await api("GET", "/artifacts/namespaces?limit=100", "Artifacts: Edit"));
for (const namespace of stores.namespaces) {
  const existed = namespaces.some((n) => n["namespace"] === namespace || n["name"] === namespace);
  made(`Artifacts namespace ${namespace}`, existed);
  if (!existed && changing)
    await api("POST", "/artifacts/namespaces", "Artifacts: Edit", { namespace });
  if (!existed && !changing) absent += 1;
}

let secretsStoreId: string | undefined;
if (stores.storeSecrets.length > 0) {
  const storesHeld = objects(await api("GET", "/secrets_store/stores", "Secrets Store: Edit"));
  secretsStoreId = text(storesHeld[0], "id");
  made("the account's Secrets Store", secretsStoreId !== undefined);
  if (secretsStoreId === undefined && changing)
    secretsStoreId = text(
      await api("POST", "/secrets_store/stores", "Secrets Store: Edit", {
        name: "default_secrets_store",
      }),
      "id",
    );
  if (secretsStoreId === undefined) absent += 1;
  const held =
    secretsStoreId === undefined
      ? []
      : objects(
          await everyPage(
            (page) =>
              api(
                "GET",
                `/secrets_store/stores/${secretsStoreId}/secrets?page=${page}&per_page=100`,
                "Secrets Store: Edit",
              ),
            100,
          ),
        );
  for (const secret of stores.storeSecrets) {
    const existed = held.some((s) => s["name"] === secret.name);
    made(`Secrets Store secret ${secret.name}`, existed);
    if (existed) continue;
    if (!changing) {
      absent += 1;
      continue;
    }
    const value = storeSecretValue(secret.binding);
    if (value === undefined)
      throw new Error(
        `The Secrets Store holds no secret ${secret.name}, bound as ${secret.binding}, and the install has no value to give it. Create it in the account's Secrets Store (scope: workers), then run this again.`,
      );
    await api("POST", `/secrets_store/stores/${secretsStoreId}/secrets`, "Secrets Store: Edit", [
      { name: secret.name, value, scopes: ["workers"], comment: "made by Keel's install" },
    ]);
  }
}

// Keel's keys: what keel holds, and what the two deployed Workers show of the public halves.
const keelName = workerName(configOf("keel").config, "keel");
const verifyName = workerName(configOf("keel-verify").config, "keel-verify");
const heldSecrets = new Set(
  objects(await find(`/workers/scripts/${keelName}/secrets`, "Workers Scripts: Edit")).flatMap(
    (secret) => text(secret, "name") ?? [],
  ),
);
const shown = {
  bundleUrlPublicKey: plainSetting(
    await find(`/workers/scripts/${verifyName}/settings`, "Workers Scripts: Edit"),
    "BUNDLE_URL_PUBLIC_KEY",
  ),
  commitSigners: plainSetting(
    await find(`/workers/scripts/${keelName}/settings`, "Workers Scripts: Edit"),
    "KEEL_COMMIT_SIGNERS",
  ),
};
const keys = keyState(heldSecrets, shown);
if (typeof keys === "object") {
  console.error(`${keys.refuse}\nNothing was deployed.`);
  process.exit(1);
}
console.log(`keel's keys: ${keys === "keep" ? "kept" : changing ? "made now" : "not made yet"}`);

if (mode === "check") {
  if (absent === 0 && keys === "keep") {
    render({
      host,
      d1,
      secretsStoreId,
      bundleUrlPublicKey: shown.bundleUrlPublicKey ?? "",
      commitSigners: shown.commitSigners ?? "[]",
    });
    console.log("check: Keel is installed here, and each wrangler.deploy.jsonc was rendered");
  } else {
    console.log(
      `check: ${absent} ${absent === 1 ? "store is" : "stores are"} missing${keys === "generate" ? " and keel holds no keys" : ""}: an install would make them. Nothing was changed.`,
    );
  }
  process.exit(0);
}

const fresh = keys === "generate" ? generateKeys(new Date()) : undefined;
render({
  host,
  d1,
  secretsStoreId,
  bundleUrlPublicKey: fresh?.bundleUrlPublicKey ?? shown.bundleUrlPublicKey ?? "",
  commitSigners: fresh?.commitSigners ?? shown.commitSigners ?? "[]",
});

const DEPLOY = ["deploy", "-c", "wrangler.deploy.jsonc", "--no-x-provision", "--no-x-auto-create"];

console.log(`\n== ${verifyName}: deploying (building its container image)`);
wrangler("keel-verify", DEPLOY);

console.log(`\n== ${keelName}: migrating its database, then deploying`);
wrangler("keel", ["d1", "migrations", "apply", "DB", "--remote", "-c", "wrangler.deploy.jsonc"]);
wrangler("keel", [...DEPLOY, "--secrets-file", "/dev/stdin"], {
  input: JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: account, ...fresh?.secrets }),
});

console.log(`\n== ${consoleName}: building the page, then deploying`);
execFileSync("pnpm", ["--dir", join(root, "apps/console"), "run", "build"], { stdio: "inherit" });
wrangler("console", DEPLOY);

// What needs a Worker to exist first: the Workflow's event subscription, and the backups' expiry.
const wanted = verifyEnded(ENVIRONMENT);
const queueId = queueIdIn(
  await api("GET", `/queues?name=${encodeURIComponent(wanted.queue)}`, "Queues: Edit"),
  wanted.queue,
);
if (queueId === undefined) throw new Error(`no queue ${wanted.queue} after ensuring it`);
const step = ensure(
  wanted,
  queueId,
  await everyPage(
    (page) =>
      api("GET", `/event_subscriptions/subscriptions?page=${page}&per_page=100`, "Queues: Edit"),
    100,
  ),
);
const subscription = `event subscription ${wanted.workflow} to ${wanted.queue}`;
if (step.action === "create") {
  await api("POST", "/event_subscriptions/subscriptions", "Queues: Edit", step.request);
  console.log(`${subscription}: created`);
} else if (step.action === "keep") {
  console.log(`${subscription}: exists`);
} else {
  throw new Error(
    `${subscription}: found one that differs\n${step.differing.map((line) => `  ${line}`).join("\n")}\nNothing was changed. Put it right or delete it by hand, then run this again.`,
  );
}

for (const bucket of stores.buckets.filter((b) => b.binding === EXPIRING_BINDING)) {
  const lifecycle = await find(`/r2/buckets/${bucket.name}/lifecycle`, "Workers R2 Storage: Edit");
  const ruled = objects(Reflect.get(Object(lifecycle), "rules")).some(
    (rule) => rule["id"] === EXPIRY_RULE,
  );
  made(`R2 bucket ${bucket.name}'s ${EXPIRY_RULE} rule`, ruled);
  if (!ruled)
    wrangler("keel", [
      "r2",
      "bucket",
      "lifecycle",
      "add",
      bucket.name,
      EXPIRY_RULE,
      "--expire-days",
      "1",
      "--abort-multipart-days",
      "1",
      "--force",
    ]);
}

console.log(`\nKeel is installed at https://${host}`);
console.log(
  `  people sign up at https://${host}/signup, and agents start at https://${host}/start`,
);
