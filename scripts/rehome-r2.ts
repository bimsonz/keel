// Copies a namespace's R2 objects to the id a migration gives it. Migration
// 0010 makes each personal org's projects its person's own, and Keel reads
// `ns/<namespaceId>/…` only, so without this every such object is unread after
// the deploy.
//   node scripts/rehome-r2.ts staging mapping --out <file>
//       BEFORE the deploy: who becomes whom, by the migration's own join over
//       the live D1. The migration deletes the personal orgs, so this cannot
//       be asked afterwards; the file is the only record.
//   node scripts/rehome-r2.ts staging copy --mapping <file>
//       the dry run: every key under each old id and where it would go
//   node scripts/rehome-r2.ts staging copy --mapping <file> --apply
//       copies. Run it before the deploy, and again after it and before the
//       smoke, so an object written under an old id in between is carried too.
// A destination is never overwritten and no source is deleted. Exit 1 when a
// destination holds other bytes or a source cannot be checked: both are listed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { accountId, root, wrangler } from "./env.ts";
import {
  type Bucket,
  mappingFromD1,
  mappingOf,
  mappingQueryFor,
  MIGRATION,
  type Move,
  type Rehoming,
  rehome,
  unsettled,
} from "./lib/rehome-r2.ts";

const USAGE = `usage: node scripts/rehome-r2.ts <env> mapping --out <file> [--migration <file>]
       node scripts/rehome-r2.ts <env> copy --mapping <file> [--apply]`;

function usage(reason: string): never {
  console.error(`${reason}\n${USAGE}`);
  process.exit(2);
}

/** The buckets Keel keys by namespace, by their binding in apps/keel/wrangler.jsonc. */
const BINDINGS = ["BUNDLES", "ARCHIVE"] as const;

const [environment, command, ...rest] = process.argv.slice(2);
if (environment === undefined || !/^[a-z]+$/.test(environment)) usage("Name the environment.");

function option(name: string): string | undefined {
  const at = rest.indexOf(name);
  if (at === -1) return undefined;
  const value = rest[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`${name} needs a value.`);
  return value;
}
const known = new Set(["--out", "--migration", "--mapping", "--apply"]);
for (const [index, word] of rest.entries())
  if (!known.has(word) && !known.has(rest[index - 1] ?? "")) usage(`Unknown argument ${word}.`);

const describe = (mapping: readonly Rehoming[]): string =>
  mapping.map((row) => `  ${row.handle}: ${row.from} -> ${row.to}`).join("\n");

function readMapping(): void {
  const out = option("--out") ?? usage("mapping needs --out <file>.");
  const query = mappingQueryFor(
    readFileSync(option("--migration") ?? join(root, MIGRATION), "utf8"),
  );
  // Run where no wrangler config is, so the database is found by its name in the account.
  const nowhere = mkdtempSync(join(tmpdir(), "keel-rehome-"));
  try {
    const answer: unknown = JSON.parse(
      wrangler(["d1", "execute", `keel-${environment}`, "--remote", "--json", "--command", query], {
        cwd: nowhere,
        quiet: true,
      }),
    );
    const mapping = mappingFromD1(answer);
    // Never over a file that is there: after the migration it cannot be read again.
    writeFileSync(out, `${JSON.stringify(mapping, null, 2)}\n`, { flag: "wx" });
    console.log(
      `${environment}: ${mapping.length} personal orgs become their person's namespace, written to ${out}\n${describe(mapping)}`,
    );
  } finally {
    rmSync(nowhere, { recursive: true, force: true });
  }
}

/** Each bucket's name in the environment, read from the config Keel deploys from. */
function bucketNames(): Map<string, string> {
  const config: unknown = parse(readFileSync(join(root, "apps/keel/wrangler.jsonc"), "utf8"), [], {
    allowTrailingComma: true,
  });
  const bound: unknown = Reflect.get(Object(config), "r2_buckets");
  const names = new Map<string, string>();
  for (const binding of BINDINGS) {
    const entry: unknown = Array.isArray(bound)
      ? bound.find((item: unknown) => Reflect.get(Object(item), "binding") === binding)
      : undefined;
    const name: unknown = Reflect.get(Object(entry), "bucket_name");
    if (typeof name !== "string" || !name.startsWith(`keel-${environment}-`))
      throw new Error(`apps/keel/wrangler.jsonc binds no ${environment} bucket as ${binding}`);
    names.set(binding, name);
  }
  return names;
}

const isBucket = (value: unknown): value is Bucket =>
  ["list", "head", "get", "put"].every(
    (method) => typeof Reflect.get(Object(value), method) === "function",
  );

interface Proxy {
  readonly env: Readonly<Record<string, unknown>>;
  dispose(): Promise<void>;
}

/** The buckets through R2's own binding, from this machine, under the operator's wrangler login. */
async function withBuckets<A>(
  use: (buckets: Readonly<Record<string, Bucket>>) => Promise<A>,
): Promise<A> {
  accountId();
  const names = bucketNames();
  const scratch = mkdtempSync(join(tmpdir(), "keel-rehome-"));
  const configPath = join(scratch, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "keel-rehome-r2",
      compatibility_date: "2026-09-01",
      r2_buckets: [...names].map(([binding, bucket_name]) => ({
        binding,
        bucket_name,
        remote: true,
      })),
    }),
  );
  const platform: { getPlatformProxy(options: object): Promise<Proxy> } = createRequire(
    join(root, "apps/keel/package.json"),
  )("wrangler");
  const proxy = await platform.getPlatformProxy({ configPath, persist: false });
  try {
    const buckets: Record<string, Bucket> = {};
    for (const [binding, name] of names) {
      const bucket = proxy.env[binding];
      if (!isBucket(bucket)) throw new Error(`${binding} (${name}) is not bound as a bucket`);
      buckets[name] = bucket;
    }
    return await use(buckets);
  } finally {
    await proxy.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}

const count = (moves: readonly Move[], ...states: Move["state"][]): number =>
  moves.filter((move) => states.includes(move.state)).length;

async function copy(): Promise<void> {
  const file = option("--mapping") ?? usage("copy needs --mapping <file>.");
  const apply = rest.includes("--apply");
  const mapping = mappingOf(JSON.parse(readFileSync(file, "utf8")));
  console.log(`${environment}: ${mapping.length} namespaces to carry\n${describe(mapping)}\n`);
  const moves = await withBuckets((buckets) => rehome(buckets, mapping, { apply }));
  for (const move of moves)
    console.log(
      `${move.state.padEnd(8)} ${move.bucket} ${move.source} -> ${move.destination} (${move.size} bytes)`,
    );
  const need = moves.filter(unsettled);
  console.log(
    `\n${environment}: ${moves.length} objects under the old ids: ${
      apply
        ? `${count(moves, "copied")} copied`
        : `${count(moves, "copy")} to copy (dry run: nothing written)`
    }, ${count(moves, "same")} already there, ${count(moves, "differs")} differing and left, ${count(moves, "in-parts")} uploaded in parts and left`,
  );
  if (need.length > 0) {
    console.error(`${need.length} need a look before this counts as done (listed above).`);
    process.exit(1);
  }
}

if (command === "mapping") readMapping();
else if (command === "copy") await copy();
else usage("Say mapping or copy.");
