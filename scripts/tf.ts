// Runs Terraform for an environment: `node scripts/tf.ts staging plan`.
// Credentials come from the operator's wrangler login and CLOUDFLARE_ACCOUNT_ID.
// After every apply, a timestamped copy of the state goes to the keel-tfstate
// R2 bucket, so the state is shared and recoverable (infra/README.md).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountId, apiToken, root, wrangler } from "./env.ts";

const [environment, ...args] = process.argv.slice(2);
if (environment === undefined || args.length === 0) {
  console.error("usage: node scripts/tf.ts <environment> <terraform args…>");
  process.exit(2);
}
const dir = join(root, "infra", environment);

/**
 * The account API token that makes keel's OAuth client, which a wrangler login
 * cannot: one permission, Account › OAuth Clients › Edit, on the account Keel
 * deploys to. The operator keeps it in this file, readable by them alone; it is
 * never in the repository, and nothing here prints it.
 */
const OAUTH_CLIENTS_TOKEN = join(homedir(), ".keel", "cloudflare-oauth-clients-token");

/**
 * The token, when the operator has made it. Without it Terraform makes no OAuth client and applies everything
 * else: the client is for the instance's users, never a condition of the instance's own infrastructure.
 */
function oauthClientsToken(): string | undefined {
  if (!existsSync(OAUTH_CLIENTS_TOKEN)) {
    console.error(
      `note: ${OAUTH_CLIENTS_TOKEN} is absent, so Terraform makes no OAuth client for Connect. To make one: an account API token on the account Keel deploys to, holding only Account › OAuth Clients › Edit, written there readable by you alone (chmod 600).`,
    );
    return undefined;
  }
  if ((statSync(OAUTH_CLIENTS_TOKEN).mode & 0o077) !== 0) {
    console.error(`${OAUTH_CLIENTS_TOKEN} is readable by others: chmod 600 it, then run again.`);
    process.exit(2);
  }
  const token = readFileSync(OAUTH_CLIENTS_TOKEN, "utf8").trim();
  if (token === "") {
    console.error(`${OAUTH_CLIENTS_TOKEN} is empty.`);
    process.exit(2);
  }
  return token;
}

const oauthClients = oauthClientsToken();
const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: apiToken(),
  TF_VAR_account_id: accountId(),
  ...(oauthClients === undefined ? {} : { TF_VAR_oauth_clients_api_token: oauthClients }),
};
const run = spawnSync("terraform", [`-chdir=${dir}`, ...args], { stdio: "inherit", env });
if (run.status !== 0) process.exit(run.status ?? 1);

const state = join(dir, "terraform.tfstate");
if (args[0] === "apply" && existsSync(state)) {
  const key = `keel-tfstate/${environment}/backups/${new Date().toISOString().replaceAll(":", "-")}.tfstate`;
  wrangler(["r2", "object", "put", key, "--file", state, "--remote"]);
  console.log(`state backed up to ${key}`);
}
