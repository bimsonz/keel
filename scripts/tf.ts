// Runs Terraform for an environment: `node scripts/tf.ts staging plan`.
// Credentials come from the operator's wrangler login and CLOUDFLARE_ACCOUNT_ID.
// After every apply, a timestamped copy of the state goes to the keel-tfstate
// R2 bucket, so the state is shared and recoverable (infra/README.md).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { accountId, apiToken, root, wrangler } from "./env.ts";

const [environment, ...args] = process.argv.slice(2);
if (environment === undefined || args.length === 0) {
  console.error("usage: node scripts/tf.ts <environment> <terraform args…>");
  process.exit(2);
}
const dir = join(root, "infra", environment);
const env = { ...process.env, CLOUDFLARE_API_TOKEN: apiToken(), TF_VAR_account_id: accountId() };
const run = spawnSync("terraform", [`-chdir=${dir}`, ...args], { stdio: "inherit", env });
if (run.status !== 0) process.exit(run.status ?? 1);

const state = join(dir, "terraform.tfstate");
if (args[0] === "apply" && existsSync(state)) {
  const key = `keel-tfstate/${environment}/backups/${new Date().toISOString().replaceAll(":", "-")}.tfstate`;
  wrangler(["r2", "object", "put", key, "--file", state, "--remote"]);
  console.log(`state backed up to ${key}`);
}
