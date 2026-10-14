// Writes worker-configuration.d.ts with the Worker's own Durable Objects typed.
// Flue's build owns the deployed entry, so wrangler.jsonc names none, and
// `wrangler types` needs one to find the classes: the types are made from a
// copy of the config that names src/cloudflare.ts, under .wrangler/. Wrangler
// writes the arguments it was given into the file's header, so the copy is
// named relative to this directory: an absolute path would put this machine's
// home directory in the file.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "jsonc-parser";

const root = join(import.meta.dirname, "..");
const config: unknown = parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
if (typeof config !== "object" || config === null)
  throw new Error("wrangler.jsonc is not an object");
mkdirSync(join(root, ".wrangler"), { recursive: true });
const copy = join(root, ".wrangler", "types.wrangler.json");
writeFileSync(copy, JSON.stringify({ ...config, main: "../src/cloudflare.ts" }));
execFileSync(
  "wrangler",
  [
    "types",
    "-c",
    relative(root, copy),
    "--include-runtime=true",
    "--strict-vars=false",
    "worker-configuration.d.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
