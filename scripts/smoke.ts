// The live smoke after a deploy: node scripts/smoke.ts staging
// Seeds two throwaway agents straight into the environment's D1, asks each
// "who am I?" over REST and over MCP, and requires the two surfaces to agree
// for each agent and to disagree across agents (so the comparison can fail).
// The rows are deleted afterwards, whatever happened. KEEL_URL overrides the
// site URL; `--repeat N` also times N more rounds for the first agent.
import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clientFor, readSeeded } from "../e2e/src/lib/seeded.ts";
import { documentSmoke } from "../e2e/src/smoke/document.ts";
import { routesSmoke } from "../e2e/src/smoke/routes.ts";
import { workLoopSmoke } from "../e2e/src/smoke/work-loop.ts";
import { whoamiSmoke, type WhoamiSmokeResult } from "../e2e/src/smoke/whoami.ts";
import { root, siteHost, wrangler } from "./env.ts";

const environment = process.argv[2] ?? "staging";
const repeatAt = process.argv.indexOf("--repeat");
const repeat = repeatAt === -1 ? 0 : Number(process.argv[repeatAt + 1] ?? "0");
const appDir = join(root, "apps/keel");
if (!existsSync(join(appDir, "wrangler.deploy.jsonc")))
  throw new Error(
    `no apps/keel/wrangler.deploy.jsonc: run \`node scripts/deploy.ts ${environment}\` first`,
  );

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(): string {
  let time = "";
  for (let t = Date.now(), i = 0; i < 10; i += 1, t = Math.floor(t / 32))
    time = CROCKFORD.charAt(t % 32) + time;
  return (
    time +
    [...crypto.getRandomValues(new Uint8Array(16))].map((b) => CROCKFORD.charAt(b % 32)).join("")
  );
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function d1(sql: string): void {
  wrangler(["d1", "execute", "DB", "--remote", "-c", "wrangler.deploy.jsonc", "--command", sql], {
    cwd: appDir,
    quiet: true,
  });
}

/** The project smoke agents are enrolled in; nothing else lives there. */
const SMOKE_PROJECT = "prj_0SM0KE0000000000000000000Z";

interface Seeded {
  readonly id: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Two agents written straight into D1, placed in the seed user's org and
 * sponsored by it (the gate refuses an agent with neither), in a project of
 * their own that is placed there too and holds nothing else.
 */
async function seed(
  name: string,
  owner: { readonly userId: string; readonly org: string },
): Promise<Seeded> {
  const id = `agt_${ulid()}`;
  const clientId = `smoke-${crypto.randomUUID()}`;
  const clientSecret = crypto.randomUUID() + crypto.randomUUID();
  if (!/^usr_[0-9A-Z]{26}$/.test(owner.userId) || !/^org_[0-9A-Z]{26}$/.test(owner.org))
    throw new Error("the seed user's ids are malformed: run the seed again");
  // Every value is generated here or checked above, so inlining is safe.
  d1(
    `INSERT OR IGNORE INTO projects (id, org_id, name, created_at) VALUES ('${SMOKE_PROJECT}', '${owner.org}', 'smoke', ${Date.now()});` +
      ` INSERT INTO agents (id, project_id, name, kind, scopes, state, revocation_epoch, created_at, org_id, sponsor_user) VALUES ('${id}', '${SMOKE_PROJECT}', '${name}', 'interactive', '["agent:read","agent:work"]', 'active', 0, ${Date.now()}, '${owner.org}', '${owner.userId}');` +
      ` INSERT INTO credentials (client_id, agent_id, secret_hash) VALUES ('${clientId}', '${id}', '${await sha256(clientSecret)}');`,
  );
  return { id, clientId, clientSecret };
}

const keelUrl = process.env["KEEL_URL"] ?? `https://${siteHost(environment)}`;
const seeded: Seeded[] = [];
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

try {
  const document = await documentSmoke(keelUrl);
  check(document.ok, document.what);
  if (!document.ok) console.log(JSON.stringify(document.detail));
  const routes = await routesSmoke(keelUrl);
  check(routes.ok, routes.what);
  if (!routes.ok) console.log(JSON.stringify(routes.detail));
  const { seedUser } = readSeeded(root, environment);
  seeded.push(await seed("smoke-a", seedUser), await seed("smoke-b", seedUser));
  const results: WhoamiSmokeResult[] = [];
  for (const agent of seeded) results.push(await whoamiSmoke(keelUrl, agent));
  console.log(JSON.stringify({ keelUrl, results }, null, 2));
  for (const [index, result] of results.entries()) {
    const agent = seeded[index];
    const named = ["result", "agent", "id"].reduce<unknown>(
      (value, key) => Reflect.get(Object(value), key),
      result.rest,
    );
    check(named === agent?.id, `REST names agent ${agent?.id}`);
    check(
      isDeepStrictEqual(result.tool, result.rest),
      `MCP whoami's structuredContent equals the REST body for ${agent?.id}`,
    );
  }
  check(
    !isDeepStrictEqual(results[0]?.rest, results[1]?.tool),
    "two agents' identities differ across surfaces (the comparison can fail)",
  );
  // The work loop needs a project with a stocked pool: the seed's forge-lite (scripts/seed.ts).
  if (existsSync(join(root, ".keel", `${environment}.json`))) {
    const s0 = readSeeded(root, environment);
    const agent = s0.projects["forge-lite"]?.agents[0];
    if (agent === undefined) throw new Error("the seed holds no forge-lite agent");
    const run = new Date().toISOString().replace(/[:.]/g, "-");
    for (const c of await workLoopSmoke(keelUrl, clientFor(keelUrl, agent), run)) {
      check(c.ok, c.what);
      if (!c.ok) console.log(JSON.stringify(c.detail, null, 2));
    }
  } else {
    check(
      false,
      `no .keel/${environment}.json: run \`node scripts/seed.ts ${environment}\` for the work-loop smoke`,
    );
  }
  if (repeat > 0 && seeded[0] !== undefined) {
    const rounds: WhoamiSmokeResult[] = [];
    for (let i = 0; i < repeat; i += 1) rounds.push(await whoamiSmoke(keelUrl, seeded[0]));
    for (const call of ["token", "rest", "mcp"] as const) {
      const sorted = rounds.map((r) => r.timings[call]).toSorted((a, b) => a - b);
      const at = (q: number) => sorted[Math.floor(q * (sorted.length - 1))];
      console.log(
        `${call.padEnd(5)} over ${repeat} warm rounds, client-side: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms`,
      );
    }
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (seeded.length > 0) {
    const ids = seeded.map((s) => `'${s.id}'`).join(", ");
    d1(
      `DELETE FROM credentials WHERE agent_id IN (${ids}); DELETE FROM agents WHERE id IN (${ids});`,
    );
    console.log(`cleaned up ${seeded.length} smoke agent(s)`);
  }
}
process.exit(failures === 0 ? 0 : 1);
