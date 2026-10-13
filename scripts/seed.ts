// Seeds an environment for S-0: node scripts/seed.ts staging [--agents N]
//
// 1. The fixture: keel-core/fixture-forge-lite holds fixtures/forge-lite as one
//    commit, made with a fixed author and date so the same tree is the same
//    commit. A repo already at that commit is left alone; one at any other
//    commit stops the seed rather than being overwritten.
// 2. The seed's automation user, `keel-seed`, signs up with a passkey as any
//    visitor does: its handle is its own namespace. Its session is
//    kept while it still works, and its passkey signs in again after that.
// 3. That user creates forge-lite and forge-lite-control in its namespace and puts
//    each one's declared settings: verification off in the control project
//    only (S-0's negative control); both private. The seed is staging's
//    declared state, so a second run restores it rather than keeping
//    whatever drifted. Then it enrols agents a1..aN in each project, which
//    it sponsors.
// 4. Everything a run needs is written to .keel/<env>.json (gitignored, 0600),
//    keeping what scripts/deploy.ts put there (the console's keys).
//
// Every call carries the Idempotency-Key `seed:<env>:<role>`, so a second run
// reaches the same ids. A credential the file already holds is kept while it
// still exchanges for a token, because replaying an enrolment re-issues its
// secret and would void the copy a deployed console holds; one that no longer
// works is re-issued under the same key. KEEL_URL overrides the site URL.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "../packages/sdk/src/index.ts";
import type { SavedPasskey } from "../packages/testing/src/passkey.ts";
import { root, siteHost, wrangler } from "./env.ts";
import { AccountRefused, signIn, signUp, whoIs } from "./lib/account.ts";

const environment = process.argv[2] ?? "staging";
const agentsAt = process.argv.indexOf("--agents");
const agentCount = agentsAt === -1 ? 2 : Number(process.argv[agentsAt + 1] ?? "2");
if (!Number.isInteger(agentCount) || agentCount < 1 || agentCount > 16)
  throw new Error("--agents takes a whole number from 1 to 16");

const CORE = "keel-core";
const FIXTURE = "fixture-forge-lite";
/** Each seeded project's declared settings. */
const PROJECTS = {
  "forge-lite": { verification: "required", visibility: "private" },
  "forge-lite-control": { verification: "off", visibility: "private" },
} as const;
const key = (role: string) => `seed:${environment}:${role}`;

/** git with no global or system config, so nothing on this machine shapes the commit. */
function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  }).trim();
}

/** The token rides only in an Authorization header set through GIT_CONFIG_*: never argv, a URL or .git/config. */
const withToken = (token: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
});

function artifacts(args: readonly string[]): string {
  return wrangler(["artifacts", "repos", ...args, "--namespace", CORE], { quiet: true });
}

/** The fixture repo's remote, creating the repo the first time. */
function fixtureRemote(): string {
  const existing = spawnSync(
    join(root, "apps/keel/node_modules/.bin/wrangler"),
    ["artifacts", "repos", "get", FIXTURE, "--namespace", CORE, "--json"],
    {
      cwd: join(root, "apps/keel"),
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  const json = existing.status === 0 ? existing.stdout : artifacts(["create", FIXTURE, "--json"]);
  const remote: unknown = Reflect.get(Object(JSON.parse(json)), "remote");
  if (typeof remote !== "string") throw new Error(`no remote for ${CORE}/${FIXTURE}: ${json}`);
  return remote;
}

/** fixtures/forge-lite as one commit, its id fixed by the tree: the same files give the same commit. */
function fixtureCommit(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "keel-seed-"));
  cpSync(join(root, "fixtures/forge-lite"), dir, {
    recursive: true,
    filter: (path) => !/\/(node_modules|\.wrangler|dist|coverage)(\/|$)/.test(path),
  });
  const fixed = {
    GIT_AUTHOR_NAME: "Keel Seed",
    GIT_AUTHOR_EMAIL: "seed@keel.invalid",
    GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Keel Seed",
    GIT_COMMITTER_EMAIL: "seed@keel.invalid",
    GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z",
  };
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "forge-lite: the S-0 fixture"], fixed);
  return { dir, sha: git(dir, ["rev-parse", "HEAD"]) };
}

function seedFixture(): string {
  const remote = fixtureRemote();
  const token = JSON.parse(
    artifacts(["issue-token", FIXTURE, "--scope", "write", "--ttl", "600", "--json"]),
  );
  const plaintext: unknown =
    Reflect.get(Object(token), "plaintext") ?? Reflect.get(Object(token), "token");
  if (typeof plaintext !== "string") throw new Error("issue-token answered no token");
  const { dir, sha } = fixtureCommit();
  try {
    const head =
      git(dir, ["ls-remote", remote, "refs/heads/main"], withToken(plaintext)).split(/\s/)[0] ?? "";
    if (head === sha) {
      console.log(`ok   ${CORE}/${FIXTURE} already holds the fixture at ${sha.slice(0, 12)}`);
    } else if (head !== "") {
      throw new Error(
        `${CORE}/${FIXTURE} is at ${head.slice(0, 12)}, not the fixture's ${sha.slice(0, 12)}: fixtures/forge-lite changed. Delete the repo (wrangler artifacts repos delete ${FIXTURE} --namespace ${CORE}) and seed again.`,
      );
    } else {
      git(dir, ["push", "-q", remote, "main:refs/heads/main"], withToken(plaintext));
      console.log(`ok   pushed the fixture to ${CORE}/${FIXTURE} at ${sha.slice(0, 12)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return sha;
}

interface Credential {
  readonly agentId: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

const out = join(root, ".keel", `${environment}.json`);

/**
 * What an earlier seed wrote. Its keys this script does not write (deploy.ts's
 * `console` keys) are kept as they are when the file is written again.
 */
const earlier: Record<string, unknown> = existsSync(out)
  ? Object(JSON.parse(readFileSync(out, "utf8")))
  : {};

/** The credentials an earlier seed wrote, by role, so a second seed need not rotate them. */
function previousCredentials(): Map<string, Credential> {
  const previous = new Map<string, Credential>();
  const seeded: unknown = earlier;
  const put = (role: string, value: unknown) => {
    const c = Object(value);
    if (typeof c.agentId === "string" && typeof c.clientSecret === "string") previous.set(role, c);
  };
  const projects = Object(Reflect.get(Object(seeded), "projects"));
  for (const [name, project] of Object.entries<unknown>(projects)) {
    const agents: unknown = Reflect.get(Object(project), "agents");
    if (Array.isArray(agents)) agents.forEach((agent, i) => put(`${name}:a${i + 1}`, agent));
  }
  return previous;
}
const previous = previousCredentials();

/** The seed's automation user: its handle is its own namespace, where the seed's projects live. */
const SEED_HANDLE = "keel-seed";

interface SeedUser {
  readonly userId: string;
  readonly handle: string;
  readonly token: string;
}

const isSeedUser = (value: unknown): value is SeedUser =>
  typeof value === "object" &&
  value !== null &&
  ["userId", "handle", "token"].every((field) => typeof Reflect.get(value, field) === "string");

/** What an earlier seed wrote, without the operator and observer credentials tenancy retired. */
function withoutRetired(seeded: Record<string, unknown>): Record<string, unknown> {
  const { operator: _operator, observer: _observer, ...rest } = seeded;
  return rest;
}

const isPasskey = (value: unknown): value is SavedPasskey =>
  typeof value === "object" && value !== null && "credentialId" in value && "privateKey" in value;

/** Writes the passkey beside whatever the file holds, before anything depends on it. */
function keepPasskey(seedPasskey: SavedPasskey): void {
  mkdirSync(join(root, ".keel"), { recursive: true, mode: 0o700 });
  const now = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  writeFileSync(out, `${JSON.stringify({ ...now, seedPasskey }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
}

/**
 * The seed's user and the passkey that signs in to it: the session an earlier
 * seed wrote while it still works, else a new session from the kept passkey,
 * else a sign-up, as any visitor's. A handle that is taken with no passkey
 * kept here cannot be signed in to: the seed stops and says so.
 */
async function automationUser(): Promise<{ seedUser: SeedUser; seedPasskey?: SavedPasskey }> {
  const kept: unknown = earlier["seedUser"];
  const passkey: unknown = earlier["seedPasskey"];
  const seedPasskey = isPasskey(passkey) ? passkey : undefined;
  if (isSeedUser(kept) && (await whoIs(keelUrl, kept.token)).handle === SEED_HANDLE) {
    console.log(`ok   ${SEED_HANDLE}: ${kept.userId} (session kept)`);
    return { seedUser: kept, ...(seedPasskey === undefined ? {} : { seedPasskey }) };
  }
  try {
    const account =
      seedPasskey === undefined
        ? await signUp(keelUrl, SEED_HANDLE, { keep: keepPasskey })
        : await signIn(keelUrl, SEED_HANDLE, seedPasskey);
    const { userId, handle, token } = account.session;
    console.log(
      `ok   ${SEED_HANDLE}: ${userId} (${seedPasskey === undefined ? "signed up" : "signed in again"})`,
    );
    return { seedUser: { userId, handle, token }, seedPasskey: account.passkey };
  } catch (error) {
    if (error instanceof AccountRefused && error.code === "NAME_TAKEN")
      throw new Error(
        `${SEED_HANDLE} exists but ${out} holds neither a working session nor its passkey`,
        { cause: error },
      );
    throw error;
  }
}

/** Whether a stored credential still exchanges for a token. */
async function stillWorks(credential: Credential): Promise<boolean> {
  try {
    await new KeelClient({ baseUrl: keelUrl, ...credential }).token({ fresh: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Enrols `role` under its key, unless the credential an earlier seed stored
 * still works: a replayed enrolment re-issues the secret, which would void
 * the copy a deployed console holds.
 */
async function enrol(
  by: KeelClient,
  role: string,
  request: Parameters<KeelClient["enrolAgent"]>[0],
): Promise<Credential> {
  const kept = previous.get(role);
  // A credential is kept only for the project it was enrolled in: the seed's projects live in its own namespace.
  if (kept !== undefined && kept.projectId === request.projectId && (await stillWorks(kept))) {
    console.log(`ok   ${role}: ${kept.agentId} in ${kept.projectId} (credential kept)`);
    return kept;
  }
  const enrolled = await by.enrolAgent(request, { idempotencyKey: key(role) });
  console.log(`ok   ${role}: ${enrolled.agent.id} in ${request.projectId}`);
  return {
    agentId: enrolled.agent.id,
    projectId: request.projectId,
    clientId: enrolled.clientId,
    clientSecret: enrolled.clientSecret,
  };
}

const keelUrl = process.env["KEEL_URL"] ?? `https://${siteHost(environment)}`;

try {
  const fixtureSha = seedFixture();
  const { seedUser, seedPasskey } = await automationUser();
  const asSeed = new KeelClient({ baseUrl: keelUrl, session: seedUser.token });
  const projects: Record<string, { id: string; verification: string; agents: Credential[] }> = {};
  for (const [name, declared] of Object.entries(PROJECTS)) {
    const project = await asSeed.createProject(
      { namespace: SEED_HANDLE, name, source: { kind: "template", name: FIXTURE } },
      { idempotencyKey: key(`project:${name}`) },
    );
    console.log(`ok   project ${name}: ${project.id}`);
    const settings = await asSeed.putSettings(project.id, {
      protectedPaths: [],
      maxBatchSize: 1,
      verification: declared.verification,
      visibility: declared.visibility,
    });
    console.log(
      `ok   ${name} verification: ${settings.verification}, visibility: ${settings.visibility}`,
    );
    const agents: Credential[] = [];
    for (let i = 1; i <= agentCount; i += 1) {
      agents.push(
        await enrol(asSeed, `${name}:a${i}`, {
          name: `a${i}`,
          kind: "interactive",
          scopes: ["agent:read", "agent:work"],
          projectId: project.id,
        }),
      );
    }
    projects[name] = { id: project.id, verification: settings.verification ?? "required", agents };
  }

  mkdirSync(join(root, ".keel"), { recursive: true, mode: 0o700 });
  writeFileSync(
    out,
    `${JSON.stringify({ ...withoutRetired(earlier), environment, keelUrl, fixture: { repo: `${CORE}/${FIXTURE}`, sha: fixtureSha }, seedUser, ...(seedPasskey === undefined ? {} : { seedPasskey }), projects }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(out, 0o600);
  console.log(`\nwrote ${out} (0600)`);
} catch (error) {
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.message}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
