// Sends a candidate's sources to the router, which builds it in-Worker with
// @cloudflare/worker-bundler and stores it in R2 under its content hash.
//
//   ROUTER_URL=https://keel-spike-16-router.<subdomain>.workers.dev \
//   ADMIN_TOKEN_FILE=<file> node scripts/build-candidate.ts <candidate-dir> [salt]
//
// <candidate-dir> is a copy of fixtures/forge-lite (optionally with a scenario
// patch applied). Only src/** and package.json are sent; the router installs
// `dependencies` from npm. A salt adds a /.salt asset, which changes the
// content hash (and so the id) without changing behaviour: a fresh cold id.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [dir, salt] = process.argv.slice(2);
const routerUrl = process.env.ROUTER_URL;
const tokenFile = process.env.ADMIN_TOKEN_FILE;
if (!dir || !routerUrl || !tokenFile) {
  console.error("usage: ROUTER_URL=... ADMIN_TOKEN_FILE=... node scripts/build-candidate.ts <candidate-dir> [salt]");
  process.exit(2);
}

function walk(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files: Record<string, string> = { "package.json": readFileSync(join(dir, "package.json"), "utf8") };
for (const p of walk(join(dir, "src"))) files[relative(dir, p)] = readFileSync(p, "utf8");

const assetsDir = new URL("../assets/", import.meta.url).pathname;
const assets: Record<string, string> = {};
for (const p of walk(assetsDir)) assets[`/${relative(assetsDir, p)}`] = readFileSync(p, "utf8");
if (salt) assets["/.salt"] = salt;

const t0 = performance.now();
const res = await fetch(`${routerUrl}/admin/build`, {
  method: "POST",
  headers: { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`, "content-type": "application/json" },
  body: JSON.stringify({ files, assets, server: "src/index.ts" }),
});
const body = await res.text();
const roundTripMs = Math.round(performance.now() - t0);
if (!res.ok) {
  console.error(`build failed: HTTP ${res.status}\n${body}`);
  process.exit(1);
}
console.log(JSON.stringify({ ...JSON.parse(body), roundTripMs, sourceFiles: Object.keys(files).length }));
