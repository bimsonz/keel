// A Cloudflare account and a build box with no cloud, for running
// scripts/install.ts in a test. Preloaded with `node --import`, it replaces
// `fetch` with an account held in a JSON file, `execFileSync` with a wrangler
// and a pnpm that only record what they were asked, and the writing of each
// rendered `wrangler.deploy.jsonc` with a copy held in memory, so a run writes
// nothing into the tree. The wrangler refuses what Cloudflare would: a deploy
// whose config names a store, a Worker or a secret the account does not hold.
// Nothing here reaches the network.
//   FAKE_ACCOUNT  the account's file: read before the run, written after each change,
//                 its `run` the writes and commands of this run in the order they came
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { parse } from "jsonc-parser";
import { accountIn } from "./fake-account-state.ts";

/** The token a test's build is given. Any other answers 401. */
const FAKE_TOKEN = "a-build-token";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const accountPath = process.env["FAKE_ACCOUNT"] ?? "";
if (accountPath === "") throw new Error("fake account: FAKE_ACCOUNT names no file");
const account = accountIn(fs.readFileSync(accountPath, "utf8"));
account.run = [];
const save = (): void => fs.writeFileSync(accountPath, JSON.stringify(account, null, 2));
const next = (): number => {
  account.n += 1;
  return account.n;
};
const wrote = (method: string, at: string, made: string): void => {
  account.run.push({ kind: "write", method, path: at, made });
};

const answer = (status: number, result: unknown, message = "not found"): Response =>
  Response.json(
    {
      success: status < 400,
      result,
      errors: status < 400 ? [] : [{ code: status, message }],
    },
    { status },
  );

const field = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);
const textOf = (value: unknown, key: string): string => {
  const found = field(value, key);
  if (typeof found !== "string" || found === "")
    throw new Error(`fake account: a write with no ${key}`);
  return found;
};

function route(method: string, at: string, query: URLSearchParams, body: unknown): Response {
  let m: RegExpExecArray | null;
  const page = query.get("page");
  const first = page === null || page === "1";
  if (method === "GET" && at === "/workers/subdomain")
    return account.subdomain === null
      ? answer(404, null)
      : answer(200, { subdomain: account.subdomain });
  if (method === "GET" && at === "/d1/database") {
    const name = query.get("name");
    return answer(200, name === null ? account.d1 : account.d1.filter((db) => db.name === name));
  }
  if (method === "POST" && at === "/d1/database") {
    const name = textOf(body, "name");
    const db = { uuid: `aaaaaaaa-1111-4111-8111-${String(next()).padStart(12, "0")}`, name };
    account.d1.push(db);
    wrote(method, at, name);
    return answer(200, db);
  }
  if (method === "GET" && at === "/r2/buckets") return answer(200, { buckets: account.buckets });
  if (method === "POST" && at === "/r2/buckets") {
    const name = textOf(body, "name");
    account.buckets.push(name);
    wrote(method, at, name);
    return answer(200, { name });
  }
  if (method === "GET" && (m = /^\/r2\/buckets\/([^/]+)\/lifecycle$/.exec(at)))
    return answer(200, { rules: account.lifecycle[m[1] ?? ""] ?? [] });
  if (method === "GET" && (m = /^\/r2\/buckets\/([^/]+)$/.exec(at)))
    return account.buckets.includes(m[1] ?? "") ? answer(200, { name: m[1] }) : answer(404, null);
  if (method === "GET" && at === "/queues") {
    const name = query.get("name");
    return answer(
      200,
      name === null ? account.queues : account.queues.filter((q) => q.queue_name === name),
    );
  }
  if (method === "POST" && at === "/queues") {
    const name = textOf(body, "queue_name");
    const queue = { queue_id: `queue-${next()}`, queue_name: name };
    account.queues.push(queue);
    wrote(method, at, name);
    return answer(200, queue);
  }
  if (method === "GET" && at === "/event_subscriptions/subscriptions")
    return answer(200, first ? account.subscriptions : []);
  if (method === "POST" && at === "/event_subscriptions/subscriptions") {
    const subscription = { id: `subscription-${next()}`, ...Object(body) };
    account.subscriptions.push(subscription);
    wrote(method, at, textOf(body, "name"));
    return answer(200, subscription);
  }
  if (method === "GET" && at === "/artifacts/namespaces")
    return answer(
      200,
      account.namespaces.map((namespace) => ({ namespace })),
    );
  if (method === "POST" && at === "/artifacts/namespaces") {
    const namespace = textOf(body, "namespace");
    if (account.namespaces.includes(namespace)) return answer(409, null, "already exists");
    account.namespaces.push(namespace);
    wrote(method, at, namespace);
    return answer(200, { namespace });
  }
  if (method === "GET" && at === "/containers/me") return answer(200, {});
  if (method === "GET" && at === "/secrets_store/stores") return answer(200, account.stores);
  if (method === "POST" && at === "/secrets_store/stores") {
    const store = { id: `store-${next()}`, name: textOf(body, "name") };
    account.stores.push(store);
    wrote(method, at, store.name);
    return answer(200, store);
  }
  if ((m = /^\/secrets_store\/stores\/([^/]+)\/secrets$/.exec(at))) {
    const id = m[1];
    if (!account.stores.some((store) => store.id === id)) return answer(404, null);
    if (method === "GET")
      return answer(200, first ? account.storeSecrets.map((name) => ({ name })) : []);
    if (method === "POST" && Array.isArray(body)) {
      for (const secret of body) {
        const value = field(secret, "value");
        const scopes = field(secret, "scopes");
        if (typeof value !== "string" || value === "") return answer(400, null, "no value");
        if (!Array.isArray(scopes) || !scopes.includes("workers"))
          return answer(400, null, "no workers scope");
      }
      const names = body.map((secret) => textOf(secret, "name"));
      account.storeSecrets.push(...names);
      wrote(method, at, names.join(", "));
      return answer(
        200,
        names.map((name) => ({ name })),
      );
    }
  }
  if (method === "GET" && (m = /^\/workers\/scripts\/([^/]+)\/secrets$/.exec(at))) {
    const worker = account.workers[m[1] ?? ""];
    return worker === undefined
      ? answer(404, null)
      : answer(
          200,
          worker.secrets.map((name) => ({ name, type: "secret_text" })),
        );
  }
  if (method === "GET" && (m = /^\/workers\/scripts\/([^/]+)\/settings$/.exec(at))) {
    const worker = account.workers[m[1] ?? ""];
    if (worker === undefined) return answer(404, null);
    return answer(200, {
      bindings: [
        ...Object.entries(worker.vars).flatMap(([name, text]) =>
          typeof text === "string" ? [{ name, type: "plain_text", text }] : [],
        ),
        ...worker.secrets.map((name) => ({ name, type: "secret_text" })),
      ],
    });
  }
  throw new Error(`fake account: a call it does not know: ${method} ${at}`);
}

async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const address = new URL(input instanceof Request ? input.url : String(input));
  const m = /^\/client\/v4\/accounts\/[0-9a-f]{32}(\/.*)$/.exec(address.pathname);
  const at = m?.[1];
  if (address.hostname !== "api.cloudflare.com" || at === undefined)
    throw new Error(`fake account: a call that is not to an account: ${address.href}`);
  const method = init?.method ?? "GET";
  if (new Headers(init?.headers).get("authorization") !== `Bearer ${FAKE_TOKEN}`)
    return answer(401, null, "bad token");
  if (account.deny.some((prefix) => at.startsWith(prefix))) return answer(403, null, "forbidden");
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const result = route(method, at, address.searchParams, body);
  save();
  return result;
}
Object.assign(globalThis, { fetch });

/** The configs the install rendered in this run, by their path from the root. */
const rendered = new Map<string, string>();
const writeFileSync = fs.writeFileSync;
Object.assign(fs, {
  writeFileSync(file: fs.PathOrFileDescriptor, data: string, ...rest: unknown[]): void {
    if (typeof file === "string" && path.basename(file) === "wrangler.deploy.jsonc") {
      rendered.set(path.relative(ROOT, file), data);
      return;
    }
    Reflect.apply(writeFileSync, fs, [file, data, ...rest]);
  },
});

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const named = (value: unknown, key: string): string => String(field(value, key));

/** The rendered config wrangler was pointed at, as an object. */
function configIn(dir: string): unknown {
  const raw = rendered.get(path.join(dir, "wrangler.deploy.jsonc"));
  if (raw === undefined) throw new Error(`fake wrangler: nothing rendered in ${dir}`);
  return parse(raw);
}

/** Deploys a Worker as Cloudflare would: refused for anything its config names that the account does not hold. */
function deploy(dir: string, env: NodeJS.ProcessEnv, given: readonly string[]): string {
  const config = configIn(dir);
  const name = env["WRANGLER_CI_OVERRIDE_NAME"] ?? named(config, "name");
  const queues = field(config, "queues");
  const host = String(field(field(config, "vars"), "KEEL_HOST"));
  const wrong = [
    ...list(field(config, "d1_databases"))
      .filter((db) => !account.d1.some((held) => held.uuid === field(db, "database_id")))
      .map((db) => `D1 ${named(db, "database_id")}`),
    ...list(field(config, "r2_buckets"))
      .filter((b) => !account.buckets.includes(named(b, "bucket_name")))
      .map((b) => `R2 ${named(b, "bucket_name")}`),
    ...[...list(field(queues, "producers")), ...list(field(queues, "consumers"))]
      .filter((q) => !account.queues.some((held) => held.queue_name === field(q, "queue")))
      .map((q) => `queue ${named(q, "queue")}`),
    ...list(field(config, "artifacts"))
      .filter((a) => !account.namespaces.includes(named(a, "namespace")))
      .map((a) => `Artifacts namespace ${named(a, "namespace")}`),
    ...list(field(config, "services"))
      .filter((s) => !(named(s, "service") in account.workers))
      .map((s) => `Worker ${named(s, "service")}`),
    ...list(field(field(config, "durable_objects"), "bindings"))
      .filter(
        (d) =>
          field(d, "script_name") !== undefined && !(named(d, "script_name") in account.workers),
      )
      .map((d) => `Worker ${named(d, "script_name")}`),
    ...list(field(config, "secrets_store_secrets"))
      .filter(
        (s) =>
          !account.stores.some((store) => store.id === field(s, "store_id")) ||
          !account.storeSecrets.includes(named(s, "secret_name")),
      )
      .map((s) => `Secrets Store secret ${named(s, "secret_name")}`),
    ...(account.subdomain !== null && host.endsWith(`.${account.subdomain}.workers.dev`)
      ? []
      : [`a KEEL_HOST on the account's subdomain, not ${host}`]),
  ];
  const held = new Set([...(account.workers[name]?.secrets ?? []), ...given]);
  const unset = list(field(field(config, "secrets"), "required")).filter(
    (secret) => !held.has(String(secret)),
  );
  if (unset.length > 0) wrong.push(`the required secrets ${unset.join(", ")}`);
  if (wrong.length > 0)
    throw new Error(`fake wrangler: ${name} cannot deploy without ${wrong.join("; ")}`);
  account.workers[name] = { secrets: [...held], vars: Object(field(config, "vars")) };
  return name;
}

Object.assign(cp, {
  execFileSync(
    command: string,
    args: readonly string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
  ): string {
    if (command === "pnpm") {
      account.run.push({ kind: "pnpm", args: args.map((arg) => arg.replace(ROOT, ".")) });
      save();
      return "";
    }
    if (!command.endsWith("/wrangler"))
      throw new Error(`fake build box: a command it does not know: ${command}`);
    const env = options.env ?? process.env;
    if (
      env["CLOUDFLARE_API_TOKEN"] !== FAKE_TOKEN ||
      !/^[0-9a-f]{32}$/.test(env["CLOUDFLARE_ACCOUNT_ID"] ?? "")
    )
      throw new Error("fake wrangler: no token or no account in its environment");
    const dir = path.relative(ROOT, options.cwd ?? process.cwd()) || ".";
    const names = ["WRANGLER_CI_OVERRIDE_NAME", "WRANGLER_CI_MATCH_TAG"].filter(
      (name) => env[name] !== undefined,
    ).length;
    const given = options.input === undefined ? [] : Object.keys(Object(JSON.parse(options.input)));
    const step = {
      kind: "wrangler",
      args,
      dir,
      buildNames: names === 2 ? "kept" : names === 0 ? "dropped" : "half",
      given,
    } as const;
    if (args[0] === "deploy") {
      account.run.push({ ...step, deployedAs: deploy(dir, env, given) });
    } else if (args.slice(0, 3).join(" ") === "d1 migrations apply") {
      for (const db of list(field(configIn(dir), "d1_databases")))
        if (!account.d1.some((held) => held.uuid === field(db, "database_id")))
          throw new Error(`fake wrangler: no D1 database ${named(db, "database_id")} to migrate`);
      account.run.push(step);
    } else if (args.slice(0, 4).join(" ") === "r2 bucket lifecycle add") {
      account.lifecycle[args[4] ?? ""] = [{ id: args[5] ?? "" }];
      account.run.push(step);
    } else {
      throw new Error(`fake wrangler: a command it does not know: ${args.join(" ")}`);
    }
    save();
    return "";
  },
});

syncBuiltinESMExports();
