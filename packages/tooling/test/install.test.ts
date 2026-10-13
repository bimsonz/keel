import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPS,
  ciEnvFor,
  CONFIG_OF,
  CONNECTED,
  generateKeys,
  GENERATED_SECRETS,
  type InstallValues,
  keyState,
  missingPermissions,
  parseConfig,
  plainSetting,
  renderInstall,
  siteHost,
  storeSecretValue,
  storesOf,
} from "../../../scripts/lib/install.ts";
import { read, repoRoot } from "../src/scan.ts";

/**
 * `scripts/install.ts` puts Keel on an account that holds nothing of it: it is
 * what the repository's Deploy to Cloudflare button runs. The script only
 * makes the calls. What it decides is in `scripts/lib/install.ts` and held
 * here, because none of it shows on the account Keel itself runs on: a wrong
 * decision is three Workers deployed over one, a second signing key, or a
 * binding nobody creates, and each is first seen by whoever presses the button.
 */

const root = repoRoot();
const committed = APPS.map((app) => {
  const source = CONFIG_OF[app].file;
  const raw = read(root, source);
  return { app, source, raw, config: parseConfig(raw, source) };
});
const configOf = (app: (typeof APPS)[number]) => {
  const found = committed.find((c) => c.app === app);
  if (found === undefined) throw new Error(`no config for ${app}`);
  return found;
};

const values: InstallValues = {
  host: "my-forge.acme.workers.dev",
  d1: Object.fromEntries(
    storesOf(committed).d1.map((name) => [name, "5e1f0c1a-7d6b-4c59-9b0e-2f4a8f0c9d11"]),
  ),
  secretsStoreId: "9c2b7a4e1f0d4b6a8e3c5d7f1a2b3c4d",
  bundleUrlPublicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n",
  commitSigners: JSON.stringify([
    { publicKey: "ssh-ed25519 AAAA", validAfter: "2026-10-14T00:00:00Z" },
  ]),
};

describe("an install's address", () => {
  it("[install.host] is the console's own workers.dev address on the account's subdomain", () => {
    expect(siteHost("keel-console", "acme")).toBe("keel-console.acme.workers.dev");
    expect(siteHost("my-forge", "acme")).toBe("my-forge.acme.workers.dev");
    expect(() => siteHost("keel-console", "")).toThrow(/subdomain/);
    expect(() => siteHost("", "acme")).toThrow(/name/);
  });
});

describe("a build's own names", () => {
  // Workers Builds sets these so that whatever a build deploys lands on the Worker it is connected to.
  const build = {
    PATH: "/usr/bin",
    WORKERS_CI: "1",
    WRANGLER_CI_OVERRIDE_NAME: "my-forge",
    WRANGLER_CI_MATCH_TAG: "a-tag",
    CLOUDFLARE_API_TOKEN: "a-token",
  };

  it("[install.ci-env] the two Workers a build is not connected to deploy under their own names", () => {
    for (const app of APPS.filter((a) => a !== CONNECTED)) {
      expect(ciEnvFor(app, CONNECTED, build)).toEqual({
        PATH: "/usr/bin",
        WORKERS_CI: "1",
        CLOUDFLARE_API_TOKEN: "a-token",
      });
    }
  });

  it("[install.ci-env] the connected Worker keeps the name its build gave it", () => {
    expect(ciEnvFor(CONNECTED, CONNECTED, build)).toEqual(build);
  });

  it("[install.ci-env] the connected Worker is the site's door, read from the repository's root", () => {
    expect(CONNECTED).toBe("console");
    expect(CONFIG_OF[CONNECTED]).toEqual({ dir: ".", file: "wrangler.jsonc" });
  });
});

describe("the token's reach", () => {
  it("[install.permissions] names every permission a refused read shows missing, each once", () => {
    expect(
      missingPermissions([
        { permission: "Workers Scripts: Edit", status: 200 },
        { permission: "D1: Edit", status: 403 },
        { permission: "Queues: Edit", status: 403 },
        { permission: "Queues: Edit", status: 403 },
        { permission: "Artifacts: Edit", status: 401 },
        { permission: "Containers: Edit", status: 200 },
      ]),
    ).toEqual(["D1: Edit", "Queues: Edit", "Artifacts: Edit"]);
  });

  it("[install.permissions] a thing that is not there yet is no missing permission", () => {
    expect(
      missingPermissions([
        { permission: "Workers Scripts: Edit", status: 404 },
        { permission: "D1: Edit", status: 200 },
      ]),
    ).toEqual([]);
  });
});

describe("keel's keys", () => {
  const all = new Set<string>(GENERATED_SECRETS);
  const shown = {
    bundleUrlPublicKey: values.bundleUrlPublicKey,
    commitSigners: values.commitSigners,
  };

  it("[install.keys] are made when keel holds none of them, whatever is shown", () => {
    expect(keyState(new Set(), { bundleUrlPublicKey: undefined, commitSigners: undefined })).toBe(
      "generate",
    );
    // keel-verify deployed with a public half, then keel's deploy failed: that half's key is gone.
    expect(keyState(new Set(["CLOUDFLARE_ACCOUNT_ID"]), shown)).toBe("generate");
  });

  it("[install.keys] are kept when keel holds all of them and both public halves are shown", () => {
    expect(keyState(new Set([...all, "CLOUDFLARE_ACCOUNT_ID"]), shown)).toBe("keep");
  });

  it.each([
    ["no signers", { ...shown, commitSigners: undefined }, /KEEL_COMMIT_SIGNERS/],
    ["an empty list of signers", { ...shown, commitSigners: "[]" }, /KEEL_COMMIT_SIGNERS/],
    [
      "signers that are not JSON",
      { ...shown, commitSigners: "ssh-ed25519" },
      /KEEL_COMMIT_SIGNERS/,
    ],
    ["no bundle key", { ...shown, bundleUrlPublicKey: "" }, /BUNDLE_URL_PUBLIC_KEY/],
  ])(
    "[install.keys] are never made again when keel holds them and shows %s",
    (_, halves, names) => {
      const state = keyState(all, halves);
      expect(state).toEqual({ refuse: expect.stringMatching(names) });
      expect(state).toEqual({ refuse: expect.stringMatching(/will not make a second key/) });
    },
  );

  it("[install.keys] are never made beside keys already held", () => {
    const state = keyState(new Set(["KEEL_SIGNING_KEY", "BETTER_AUTH_SECRET"]), shown);
    expect(state).toEqual({
      refuse: expect.stringMatching(/but not BUNDLE_URL_SIGNING_KEY, KEEL_COMMIT_SIGNING_KEY/),
    });
  });

  it("[install.keys-made] each is its own key, in the form Keel reads it, with its public half beside it", () => {
    const made = generateKeys(new Date("2026-10-14T09:30:00Z"));
    expect(Object.keys(made.secrets).toSorted()).toEqual([...GENERATED_SECRETS].toSorted());

    // The bundle URL pair: what the private half signs, the public half given to keel-verify verifies.
    const bundles = createPrivateKey(made.secrets.BUNDLE_URL_SIGNING_KEY);
    expect(made.secrets.BUNDLE_URL_SIGNING_KEY).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(made.bundleUrlPublicKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    const message = Buffer.from("a bundle's address");
    expect(
      verify(null, message, createPublicKey(made.bundleUrlPublicKey), sign(null, message, bundles)),
    ).toBe(true);

    // The commit key: its signers entry is its own public half as OpenSSH writes one, valid from that day.
    const commits = createPublicKey(createPrivateKey(made.secrets.KEEL_COMMIT_SIGNING_KEY));
    const raw = Buffer.from(String(commits.export({ format: "jwk" }).x), "base64url");
    const wire = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519"),
      Buffer.from([0, 0, 0, 32]),
      raw,
    ]);
    expect(JSON.parse(made.commitSigners)).toEqual([
      { publicKey: `ssh-ed25519 ${wire.toString("base64")}`, validAfter: "2026-10-14T00:00:00Z" },
    ]);

    // The token key is a private Ed25519 JWK with a key id; Better Auth's secret is long and random.
    expect(JSON.parse(made.secrets.KEEL_SIGNING_KEY)).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      kid: "keel-2026-10-14",
      d: expect.any(String),
      x: expect.any(String),
    });
    expect(made.secrets.BETTER_AUTH_SECRET).toMatch(/^[\w-]{64}$/);

    // Four keys, not one key four times, and not the same keys on the next account.
    const again = generateKeys(new Date("2026-10-14T09:30:00Z"));
    const privates = [made, again].flatMap((keys) => Object.values(keys.secrets));
    expect(new Set(privates).size).toBe(8);
  });

  it("[install.store-secret] the credential key is 32 random bytes, and a binding with no source has no value", () => {
    const first = storeSecretValue("CREDENTIAL_KEK");
    const second = storeSecretValue("CREDENTIAL_KEK");
    expect(Buffer.from(String(first), "base64")).toHaveLength(32);
    expect(first).not.toBe(second);
    expect(storeSecretValue("SOMETHING_ELSE")).toBeUndefined();
  });
});

describe("what the account must hold", () => {
  it("[install.stores] every key of the three committed configs is one the install was taught", () => {
    // Red here means a config gained a binding kind: say in scripts/lib/install.ts what a new account needs for it.
    expect(() => storesOf(committed)).not.toThrow();
  });

  it("[install.stores] reads each store once, by its name, from every config that binds it", () => {
    const one = {
      source: "a/wrangler.jsonc",
      config: {
        name: "a",
        d1_databases: [{ binding: "DB", database_name: "db-1", database_id: "x" }],
        r2_buckets: [
          { binding: "BUNDLES", bucket_name: "bundles" },
          { binding: "BACKUP_BUCKET", bucket_name: "backups" },
        ],
        queues: {
          producers: [{ binding: "JOBS", queue: "jobs" }],
          consumers: [{ queue: "jobs", max_retries: 5 }, { queue: "late" }],
        },
        artifacts: [{ binding: "ARTIFACTS", namespace: "core" }],
        secrets_store_secrets: [{ binding: "CREDENTIAL_KEK", store_id: "s", secret_name: "kek" }],
      },
    };
    const two = {
      source: "b/wrangler.jsonc",
      config: {
        name: "b",
        r2_buckets: [{ binding: "BUNDLES", bucket_name: "bundles" }],
        artifacts: [{ binding: "WORKSPACES", namespace: "ws" }],
      },
    };
    expect(storesOf([one, two])).toEqual({
      d1: ["db-1"],
      buckets: [
        { name: "bundles", binding: "BUNDLES" },
        { name: "backups", binding: "BACKUP_BUCKET" },
      ],
      queues: ["jobs", "late"],
      namespaces: ["core", "ws"],
      storeSecrets: [{ name: "kek", binding: "CREDENTIAL_KEK" }],
    });
  });

  it("[install.stores] refuses a binding kind it was never taught, naming it and its config", () => {
    const taught = { source: "a/wrangler.jsonc", config: { name: "a", vars: {} } };
    const untaught = {
      source: "b/wrangler.jsonc",
      config: {
        name: "b",
        vectorize: [{ binding: "RECALL", index_name: "recall" }],
        kv_namespaces: [],
      },
    };
    expect(() => storesOf([taught, untaught])).toThrow(
      /b\/wrangler\.jsonc: vectorize, b\/wrangler\.jsonc: kv_namespaces/,
    );
  });

  it("[install.stores] refuses a store with no name", () => {
    const nameless = {
      source: "a/wrangler.jsonc",
      config: { name: "a", r2_buckets: [{ binding: "BUNDLES" }] },
    };
    expect(() => storesOf([nameless])).toThrow(
      /a\/wrangler\.jsonc: a R2 binding with no bucket_name/,
    );
  });
});

/** A committed config as the install renders it, parsed. */
const rendered = (app: (typeof APPS)[number], given: InstallValues = values) => {
  const { source, raw } = configOf(app);
  return parseConfig(renderInstall(source, raw, given), source);
};
/** What is at `path` inside something parsed. */
const at = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((inner, key) => Reflect.get(Object(inner), key), value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

describe("a rendered config", () => {
  it("[install.render] every Worker names the site's one host", () => {
    for (const app of APPS)
      expect([app, at(rendered(app), "vars", "KEEL_HOST")]).toEqual([app, values.host]);
  });

  it("[install.render] keel names the account's own database, and both Workers their public halves", () => {
    const keel = rendered("keel");
    expect(at(keel, "d1_databases", 0, "database_id")).toBe("5e1f0c1a-7d6b-4c59-9b0e-2f4a8f0c9d11");
    expect(at(keel, "vars", "KEEL_COMMIT_SIGNERS")).toBe(values.commitSigners);
    expect(at(rendered("keel-verify"), "vars", "BUNDLE_URL_PUBLIC_KEY")).toBe(
      values.bundleUrlPublicKey,
    );
    for (const secret of list(at(keel, "secrets_store_secrets")))
      expect(at(secret, "store_id")).toBe(values.secretsStoreId);
  });

  it("[install.render] changes nothing else: every other line of the committed config stands", () => {
    const { source, raw } = configOf("keel");
    const before = raw.split("\n");
    const after = renderInstall(source, raw, values).split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after
      .filter((line, index) => line !== before[index])
      .map((line) => line.trim());
    expect(
      changed.every((line) =>
        /^"(database_id|store_id|KEEL_HOST|KEEL_COMMIT_SIGNERS)":/.test(line),
      ),
    ).toBe(true);
    expect(changed.length).toBeGreaterThanOrEqual(3);
  });

  it("[install.render] refuses while a sentinel survives, so wrangler is never handed an id that names nothing", () => {
    const { source, raw } = configOf("keel");
    const sentinel = Object.fromEntries(
      Object.keys(values.d1).map((name) => [name, "00000000-0000-0000-0000-000000000000"]),
    );
    expect(() => renderInstall(source, raw, { ...values, d1: sentinel })).toThrow(
      /sentinel 00000000-0000-0000-0000-000000000000 survives/,
    );
  });

  it("[install.render] refuses a database it was given no id for", () => {
    const { source, raw } = configOf("keel");
    expect(() => renderInstall(source, raw, { ...values, d1: {} })).toThrow(
      /no id for D1 database/,
    );
  });
});

describe("the repository's root config", () => {
  it("[install.root-config] is the console's own config, but for the three paths written from the root", () => {
    const fromRoot = configOf(CONNECTED).config;
    const consoles = parseConfig(read(root, "apps/console/wrangler.jsonc"), "apps/console");
    expect(fromRoot["$schema"]).toBe("apps/console/node_modules/wrangler/config-schema.json");
    expect(fromRoot["main"]).toBe(`apps/console/${String(consoles["main"])}`);
    expect(at(fromRoot, "assets", "directory")).toBe("./apps/console/dist");
    // With those three written as the console writes them, nothing differs: not a path run first, not a date.
    expect({
      ...fromRoot,
      $schema: consoles["$schema"],
      main: consoles["main"],
      assets: { ...Object(fromRoot["assets"]), directory: at(consoles, "assets", "directory") },
    }).toEqual(consoles);
  });
});

describe("a deployed Worker's settings", () => {
  it("[install.settings] a plain setting is read back by name, and a secret's value never is", () => {
    const settings = {
      bindings: [
        { name: "KEEL_HOST", type: "plain_text", text: "my-forge.acme.workers.dev" },
        { name: "KEEL_COMMIT_SIGNERS", type: "plain_text", text: values.commitSigners },
        { name: "KEEL_COMMIT_SIGNING_KEY", type: "secret_text" },
        { name: "DB", type: "d1", id: "x" },
      ],
    };
    expect(plainSetting(settings, "KEEL_COMMIT_SIGNERS")).toBe(values.commitSigners);
    expect(plainSetting(settings, "KEEL_COMMIT_SIGNING_KEY")).toBeUndefined();
    expect(plainSetting(settings, "BUNDLE_URL_PUBLIC_KEY")).toBeUndefined();
    expect(plainSetting(undefined, "KEEL_HOST")).toBeUndefined();
  });
});
