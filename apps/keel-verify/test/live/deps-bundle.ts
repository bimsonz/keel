// A world's deps bundle, where the Tier 1 runner looks for it: a hoisted,
// production-only install from the world's own pnpm lockfile, written as an
// ordinary content-addressed bundle of node_modules plus that lockfile, and
// named by the lockfile's sha256 (`deps/<sha256>` holds the bundle's hex).
// Probe isolates never install from npm; this script is where npm is read.
//
//   node apps/keel-verify/test/live/deps-bundle.ts <dir>             build, check and describe it
//   CLOUDFLARE_ACCOUNT_ID=… node apps/keel-verify/test/live/deps-bundle.ts <dir> --upload
//                                                                    also put bundles/<hex> and deps/<sha256> in R2
//
// <dir> holds the world's package.json and pnpm-lock.yaml (for S-1's worlds,
// fixtures/forge-lite: its patches never touch either).
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  type BundleFile,
  depsNeed,
  LOCKFILE,
  readBundle,
  sha256Hex,
  writeBundle,
} from "@keeltown/runner-protocol";

const KEEL = join(import.meta.dirname, "../../../keel");
const BUCKET = "keel-staging-bundles";

const [dirArg, ...flags] = process.argv.slice(2);
if (dirArg === undefined) throw new Error("usage: deps-bundle.ts <dir> [--upload]");
const dir = resolve(dirArg);
const upload = flags.includes("--upload");

/** The world's own package.json and lockfile, and its workspace file when it has one. */
const WORLD_FILES = ["package.json", LOCKFILE, "pnpm-workspace.yaml"];

/**
 * Every regular file under node_modules, relative to `root`. Symlinks
 * (`.bin`) are left out, as a bundle holds regular files only, and so is
 * pnpm's own state at the top of node_modules (`.modules.yaml` and the like),
 * which names the install's directory and would make the bundle differ
 * between two installs of one lockfile.
 */
const nodeModules = (root: string): BundleFile[] => {
  const out: BundleFile[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const rel = relative(root, path);
      if (at === join(root, "node_modules") && name.startsWith(".")) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        out.push({
          path: rel,
          bytes: new Uint8Array(readFileSync(path)),
          executable: (stat.mode & 0o111) !== 0,
        });
    }
  };
  walk(join(root, "node_modules"));
  return out;
};

const lockfile = new Uint8Array(readFileSync(join(dir, LOCKFILE)));
const world: BundleFile[] = [
  { path: "package.json", bytes: new Uint8Array(readFileSync(join(dir, "package.json"))) },
  { path: LOCKFILE, bytes: lockfile },
];
const need = await depsNeed(world);
if (need._tag !== "lockfile")
  throw new Error(`${dir} needs no deps bundle the runner would look up: ${JSON.stringify(need)}`);

const install = mkdtempSync(join(tmpdir(), "keel-deps-"));
for (const name of WORLD_FILES)
  if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(install, name));
execFileSync(
  "pnpm",
  [
    "install",
    "--prod",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--config.node-linker=hoisted",
    "--config.confirmModulesPurge=false",
  ],
  { cwd: install, stdio: "inherit", env: { ...process.env, npm_config_userconfig: "/dev/null" } },
);

const files = [{ path: LOCKFILE, bytes: lockfile }, ...nodeModules(install)];
const bytes = await writeBundle(files);
const hex = await sha256Hex(bytes);

// The runner's own checks, before anything leaves: it reads back, and its lockfile is the world's.
const back = await readBundle(bytes);
const lock = back.find((f) => f.path === LOCKFILE);
if (lock === undefined || (await sha256Hex(lock.bytes)) !== need.sha256)
  throw new Error("the deps bundle's lockfile is not the world's");
if (!back.some((f) => f.path.startsWith("node_modules/")))
  throw new Error("the install left no node_modules: nothing to bundle");

const packages = [
  ...new Set(
    back
      .filter((f) => /^node_modules\/(@[^/]+\/)?[^/@]+\/package\.json$/.test(f.path))
      .map((f) => f.path.slice("node_modules/".length, -"/package.json".length)),
  ),
].toSorted();
console.log(
  JSON.stringify({
    lockSha: need.sha256,
    bundle: `sha256:${hex}`,
    files: back.length,
    bytes: bytes.length,
    packages,
  }),
);

if (upload) {
  const account = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  if (!/^[0-9a-f]{32}$/.test(account)) throw new Error("set CLOUDFLARE_ACCOUNT_ID");
  const put = (key: string, file: string, contentType: string) =>
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "put",
        `${BUCKET}/${key}`,
        "--file",
        file,
        "--content-type",
        contentType,
        "--remote",
      ],
      { cwd: KEEL, encoding: "utf8", env: { ...process.env, npm_config_userconfig: "/dev/null" } },
    );
  const out = mkdtempSync(join(tmpdir(), "keel-deps-out-"));
  writeFileSync(join(out, "bundle.tgz"), bytes);
  writeFileSync(join(out, "pointer"), hex);
  // The bundle first, so a pointer never names a bundle that is not there yet.
  put(`bundles/${hex}`, join(out, "bundle.tgz"), "application/gzip");
  put(`deps/${need.sha256}`, join(out, "pointer"), "text/plain");
  console.log(JSON.stringify({ uploaded: [`bundles/${hex}`, `deps/${need.sha256}`] }));
}
