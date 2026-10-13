import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyEnded } from "../../../scripts/lib/event-subscription.ts";
import {
  APPS,
  CONFIG_OF,
  GENERATED_SECRETS,
  parseConfig,
  storeSecretValue,
  storesOf,
} from "../../../scripts/lib/install.ts";
import { read, repoRoot } from "../src/scan.ts";
import { type Account, accountIn, type Step } from "./fake-account-state.ts";

/**
 * `scripts/install.ts` itself, run as a build runs it, against an account
 * held in memory (`fake-account.ts`): what it writes to the account, what it
 * asks wrangler, and in what order. `install.test.ts` holds what the script
 * decides; this holds that the script acts on it, because an edit that
 * makes a store after the token's check, deploys before a store exists or
 * makes a second key is first seen by whoever presses the button, on an
 * account nobody else can see.
 */

const root = repoRoot();
const stores = storesOf(
  APPS.map((app) => {
    const source = CONFIG_OF[app].file;
    return { source, config: parseConfig(read(root, source), source) };
  }),
);
/** The Secrets Store secrets only an account's owner can give: the install has no value for them. */
const ownersOnly = stores.storeSecrets
  .filter((secret) => storeSecretValue(secret.binding) === undefined)
  .map((secret) => secret.name);
const madeByInstall = stores.storeSecrets
  .filter((secret) => storeSecretValue(secret.binding) !== undefined)
  .map((secret) => secret.name);

/** An account that holds nothing of Keel's but what only its owner can give it. */
const newAccount = (): Account => ({
  subdomain: "acme",
  deny: [],
  d1: [],
  buckets: [],
  queues: [],
  namespaces: [],
  stores: ownersOnly.length > 0 ? [{ id: "the-owners-store", name: "default_secrets_store" }] : [],
  storeSecrets: [...ownersOnly],
  subscriptions: [],
  lifecycle: {},
  workers: {},
  n: 0,
  run: [],
});

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The account after the run. */
  readonly account: Account;
}

const scratch = mkdtempSync(join(tmpdir(), "keel-install-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let runs = 0;

/** Runs the install, as a Workers Build connected to a Worker called `my-forge` runs it, against `account`. */
function install(account: Account): Ran {
  runs += 1;
  const file = join(scratch, `account-${runs}.json`);
  writeFileSync(file, JSON.stringify(account));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:CLOUDFLARE_|CF_|WRANGLER_|WORKERS_CI$|NODE_OPTIONS$)/.test(name),
    ),
  );
  const run = spawnSync(
    process.execPath,
    ["--import", join(root, "packages/tooling/test/fake-account.ts"), "scripts/install.ts"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...inherited,
        FAKE_ACCOUNT: file,
        CF_API_TOKEN: "a-build-token",
        CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        WORKERS_CI: "1",
        WRANGLER_CI_OVERRIDE_NAME: "my-forge",
        WRANGLER_CI_MATCH_TAG: "a-tag",
      },
    },
  );
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    account: accountIn(readFileSync(file, "utf8")),
  };
}

/** How a run ended, with what it printed to stderr when that was not well. */
const exited = (ran: Ran) => ({ status: ran.status, stderr: ran.status === 0 ? "" : ran.stderr });

let first: Ran | undefined;
/** The install run once on a new account, shared by the cases that start from an installed one. */
const installedOnce = (): Ran => (first ??= install(newAccount()));

/** One line per step of a run, in its order: a write to the account, a pnpm or a wrangler run. */
const transcript = (ran: Ran): string[] =>
  ran.account.run.map((step: Step) => {
    if (step.kind === "write")
      return `${step.method} ${step.path.replace(/\/stores\/[^/]+\//, "/stores/<store>/")} ${step.made}`;
    if (step.kind === "pnpm") return `pnpm ${step.args.join(" ")}`;
    const given = step.given.length === 0 ? "nothing" : step.given.toSorted().join(", ");
    return `wrangler ${step.args.join(" ")} | in ${step.dir}, the build's names ${step.buildNames}, given ${given}${step.deployedAs === undefined ? "" : ` | deployed as ${step.deployedAs}`}`;
  });

const DEPLOY = "deploy -c wrangler.deploy.jsonc --no-x-provision --no-x-auto-create";
const dropped = "the build's names dropped";
const deploys = (keelGiven: readonly string[]): string[] => [
  `wrangler ${DEPLOY} | in apps/keel-verify, ${dropped}, given nothing | deployed as keel-verify`,
  `wrangler d1 migrations apply DB --remote -c wrangler.deploy.jsonc | in apps/keel, ${dropped}, given nothing`,
  `wrangler ${DEPLOY} --secrets-file /dev/stdin | in apps/keel, ${dropped}, given ${keelGiven.toSorted().join(", ")} | deployed as keel`,
  "pnpm --dir ./apps/console run build",
  `wrangler ${DEPLOY} | in ., the build's names kept, given nothing | deployed as my-forge`,
];

describe(
  "the install, run as a build runs it, against an account held in memory",
  { timeout: 60_000 },
  () => {
    it("[install.run-new] makes each store the configs bind once, every one before the first deploy, then deploys the three Workers in the order they bind each other", () => {
      const ran = installedOnce();
      expect(exited(ran)).toEqual({ status: 0, stderr: "" });
      const backups = stores.buckets.filter((bucket) => bucket.binding === "BACKUP_BUCKET");
      expect(backups).toHaveLength(1);
      expect(transcript(ran)).toEqual([
        "pnpm gen",
        ...stores.d1.map((name) => `POST /d1/database ${name}`),
        ...stores.buckets.map((bucket) => `POST /r2/buckets ${bucket.name}`),
        ...stores.queues.map((queue) => `POST /queues ${queue}`),
        ...stores.namespaces.map((namespace) => `POST /artifacts/namespaces ${namespace}`),
        ...(stores.storeSecrets.length > 0 && ownersOnly.length === 0
          ? ["POST /secrets_store/stores default_secrets_store"]
          : []),
        ...madeByInstall.map((name) => `POST /secrets_store/stores/<store>/secrets ${name}`),
        ...deploys(["CLOUDFLARE_ACCOUNT_ID", ...GENERATED_SECRETS]),
        `POST /event_subscriptions/subscriptions ${verifyEnded("staging").name}`,
        ...backups.map(
          (bucket) =>
            `wrangler r2 bucket lifecycle add ${bucket.name} expire-after-1-day --expire-days 1 --abort-multipart-days 1 --force | in apps/keel, ${dropped}, given nothing`,
        ),
      ]);
      expect(ran.account.workers["keel"]?.vars["KEEL_HOST"]).toBe("my-forge.acme.workers.dev");
      expect(ran.stdout).toContain("Keel is installed at https://my-forge.acme.workers.dev\n");
    });

    it("[install.run-again] the same account again writes nothing, keeps keel's keys and gives keel the account's id alone", () => {
      const before = installedOnce().account;
      const signers = before.workers["keel"]?.vars["KEEL_COMMIT_SIGNERS"];
      const bundleKey = before.workers["keel-verify"]?.vars["BUNDLE_URL_PUBLIC_KEY"];
      expect(signers).toMatch(/^\[\{"publicKey":"ssh-ed25519 /);
      expect(bundleKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);

      const ran = install(before);
      expect(exited(ran)).toEqual({ status: 0, stderr: "" });
      expect(transcript(ran)).toEqual(["pnpm gen", ...deploys(["CLOUDFLARE_ACCOUNT_ID"])]);
      expect(ran.stdout).toContain("keel's keys: kept\n");
      expect(ran.account.workers["keel"]?.vars["KEEL_COMMIT_SIGNERS"]).toBe(signers);
      expect(ran.account.workers["keel-verify"]?.vars["BUNDLE_URL_PUBLIC_KEY"]).toBe(bundleKey);
      expect(ran.account.workers["keel"]?.secrets.toSorted()).toEqual(
        before.workers["keel"]?.secrets.toSorted(),
      );
    });

    it("[install.run-refused] a token refused on two APIs names both together and changes nothing", () => {
      const ran = install({ ...newAccount(), deny: ["/queues", "/artifacts"] });
      expect(ran.status).toBe(1);
      const lacks = /It lacks:\n((?: {2}.+\n)+)Nothing was changed\./.exec(ran.stderr)?.[1];
      expect(
        lacks
          ?.trimEnd()
          .split("\n")
          .map((line) => line.trim())
          .toSorted(),
      ).toEqual(["Artifacts: Edit", "Queues: Edit"]);
      expect(transcript(ran)).toEqual(["pnpm gen"]);
    });

    it("[install.run-keys-lost] keel holding its keys with its signers no longer shown stops before any deploy, and makes no second key", () => {
      const installed = installedOnce().account;
      const keel = installed.workers["keel"];
      if (keel === undefined) throw new Error("the first install deployed no keel");
      const vars = Object.fromEntries(
        Object.entries(keel.vars).filter(([name]) => name !== "KEEL_COMMIT_SIGNERS"),
      );
      const lost: Account = {
        ...installed,
        workers: { ...installed.workers, keel: { ...keel, vars } },
      };

      const ran = install(lost);
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain(
        "the install will not make a second key.\nNothing was deployed.",
      );
      expect(transcript(ran)).toEqual(["pnpm gen"]);
      expect(ran.account.workers).toEqual(lost.workers);
    });
  },
);
