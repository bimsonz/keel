// A live check of deploys on a deployed Keel: a project connected to a Cloudflare
// account previews an agent's change on that account, smokes the preview into
// the verdict, lands the change and deploys trunk there; a broken change's
// preview fails its smoke and the change bounces.
//   KEEL_URL=<keel> node e2e/src/w2a.ts <run> <namespace>/<project>
//
// The project is an empty one whose owner has connected a Cloudflare account
// as its target `production`. An agent that holds nothing but a key signs
// itself up and prints its handle; the owner invites it to the project with
// read and work, and it waits for that, accepts, and then:
//   (1) writes fixtures/worker-lite into the project, so trunk holds its
//       .keel/deploy.json (this change has no deploy steps: its base has none);
//   (2) adds a /version route: PreviewDeployed reaches its inbox with an
//       address that answers, the change lands, DeploymentPromoted follows,
//       and the Worker's own address answers /version;
//   (3) makes /health answer 500: the change bounces, citing deploy.smoke,
//       and nothing more is promoted.
// Each run needs a run of its own, since a handle is taken for good. It leaves
// the agent behind, whose key is gone with the run, and the Worker on the
// owner's account. No key, token or session is printed.
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKey, KeelClient, signUp } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush } from "./lib/git.ts";
import { declareWhenPooled, line, SETTLE_MS } from "./lib/live.ts";

const [run, path] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9]{1,12}$/.test(run) || path === undefined || !path.includes("/"))
  throw new Error("usage: w2a.ts <run> <namespace>/<project>");
const [namespace, projectName] = path.split("/");
const keelUrl = process.env.KEEL_URL ?? "";
if (keelUrl === "") throw new Error("KEEL_URL is not set: the Keel to check");
const FIXTURE = join(import.meta.dirname, "../../fixtures/worker-lite");
const TERMINAL = new Set(["landed", "bounced", "withdrawn", "superseded", "parked"]);
const key = (what: string) => `w2a:${run}:${what}`;
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (text: string) => console.log(`${stamp()} ${text}`);

let failures = 0;
const check = (ok: boolean, what: string) => {
  say(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

/** Every object inside `value` whose `_tag` is `tag`, however deep a notice or page holds it. */
function tagged(value: unknown, tag: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((item) => tagged(item, tag));
  if (typeof value !== "object" || value === null) return [];
  const own = Reflect.get(value, "_tag") === tag ? [Object.fromEntries(Object.entries(value))] : [];
  return [...own, ...Object.values(value).flatMap((item) => tagged(item, tag))];
}

/** What an address answers: its status and the start of its body, or why it answered nothing. */
async function answer(url: string): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, { redirect: "manual" });
    return { status: response.status, body: (await response.text()).slice(0, 200) };
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

/** The address's answer once it is `status` with `text` in it, or its last one at the deadline. */
async function answerWhen(url: string, status: number, text: string, ms = 90_000) {
  const deadline = Date.now() + ms;
  let last = await answer(url);
  while (!(last.status === status && last.body.includes(text)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    last = await answer(url);
  }
  return last;
}

const { signer } = await generateAgentKey();
const account = await signUp({ baseUrl: keelUrl, signer, name: `w2a-${run}` });
const agentClient = (project?: string) =>
  new KeelClient({
    baseUrl: keelUrl,
    agentId: account.agentId,
    key: signer,
    run: "w2a",
    ...(project === undefined ? {} : { project }),
  });
const own = agentClient();
say(`agent signed up: invite ${account.handle} to ${path} with read and work`);

// The owner's invitation, as the agent's lists show it: to the project itself, or into its org, through which the
// agent reaches the org's projects (an org's project settings offer no invitation of their own).
let projectId: string | undefined;
for (const deadline = Date.now() + 90 * 60_000; projectId === undefined;) {
  if (Date.now() > deadline) throw new Error(`no invitation to ${path} in 90 minutes`);
  const toProject = (await own.projectInvitations()).items.find(
    (item) => item.project.namespace === namespace && item.project.name === projectName,
  );
  if (toProject !== undefined) {
    const joined = await own.acceptProjectInvitation(toProject.project.id, {
      idempotencyKey: key("accept"),
    });
    check(
      joined.state === "joined",
      `accepted the invitation to ${path} (${toProject.project.id}): ${joined.state}`,
    );
    projectId = toProject.project.id;
    break;
  }
  const toOrg = (await own.invitations()).items.find((item) => item.namespace.handle === namespace);
  if (toOrg !== undefined) {
    if (toOrg.state !== "joined") {
      const joined = await own.acceptInvitation(toOrg.namespace.handle, {
        idempotencyKey: key("accept-org"),
      });
      check(
        joined.state === "joined",
        `accepted the invitation into ${namespace}: ${joined.state}`,
      );
    }
    projectId = (await own.reachableProjects()).items.find(
      (item) => item.project.namespace === namespace && item.project.name === projectName,
    )?.project.id;
    if (projectId !== undefined) break;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
const project = projectId;
const client = agentClient(project);

interface Submitted {
  readonly changeId: string;
  readonly commitSha: string;
}

/** Declare, clone the workspace, make the edit, push it and submit it, as an agent's harness would. */
async function work(
  name: string,
  goal: string,
  footprint: { path: string; op: "create" | "edit" }[],
  edit: (dir: string) => void,
): Promise<Submitted> {
  const declared = await declareWhenPooled(client, { goal, footprint }, key(name));
  const { change, workspace, lease } = declared;
  if (workspace.token === undefined)
    throw new Error(`${name}: declare answered no workspace token`);
  const dir = cloneWorkspace(workspace.remote, workspace.token);
  try {
    edit(dir);
    const commitSha = commitAndPush(dir, workspace.token, account.handle, goal);
    await client.submit(
      { changeId: change.id, commitSha },
      { lease: lease.id, idempotencyKey: key(`${name}:submit`) },
    );
    say(`${name}: submitted ${change.id} at ${commitSha.slice(0, 12)}`);
    return { changeId: change.id, commitSha };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The change's last status once it lands or bounces, or as it stands at the deadline. */
async function settle(name: string, submitted: Submitted) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const status = await client.status(submitted.changeId, { wait: 30 });
    if (TERMINAL.has(status.result.state) || Date.now() > deadline) {
      say(`${name}: ${submitted.changeId} is ${status.result.state}`);
      return status.result;
    }
  }
}

/** The project's events so far, oldest first. */
async function events() {
  const seen: Parameters<typeof line>[0][] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.events({
      project,
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    seen.push(...page.items);
    if (page.items.length === 0 || page.nextCursor === cursor) return seen;
    cursor = page.nextCursor;
  }
}

const SOURCE = "src/index.ts";
const editSource = (dir: string, from: string, to: string) => {
  const file = join(dir, SOURCE);
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`${SOURCE} no longer holds ${from}`);
  writeFileSync(file, text.replace(from, to));
};

// (1) The fixture, written into the empty project.
const files = readdirSync(FIXTURE, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && !join(entry.parentPath, entry.name).includes("node_modules"))
  .map((entry) => join(entry.parentPath, entry.name).slice(FIXTURE.length + 1));
const first = await work(
  "fixture",
  "Write the worker-lite Worker, its test and its deploy spec",
  files.map((file) => ({ path: file, op: file === "README.md" ? "edit" : "create" })),
  (dir) =>
    cpSync(FIXTURE, dir, {
      recursive: true,
      filter: (source) => !source.includes("node_modules"),
    }),
);
check((await settle("fixture", first)).state === "landed", "(1) the fixture lands");

// (2) A /version route: previewed, smoked, landed and deployed.
const VERSION = `w2a-${run}`;
const second = await work(
  "version",
  "Answer the Worker's version at /version",
  [{ path: SOURCE, op: "edit" }],
  (dir) =>
    editSource(
      dir,
      'app.get("/health", (c) => c.text("ok"));',
      `app.get("/health", (c) => c.text("ok"));\napp.get("/version", (c) => c.text("${VERSION}"));`,
    ),
);
const settled = await settle("version", second);
const preview = tagged(await client.inbox({ wait: 0 }), "PreviewDeployed").find(
  (p) => p.changeId === second.changeId,
);
check(
  preview !== undefined,
  `(2) PreviewDeployed reached the agent's inbox for ${second.changeId}`,
);
if (preview !== undefined) {
  say(
    `     preview ${String(preview.url)} alias ${typeof preview.aliasUrl === "string" ? preview.aliasUrl : "-"}`,
  );
  const at = await answerWhen(`${String(preview.url)}/version`, 200, VERSION);
  check(
    at.status === 200 && at.body.includes(VERSION),
    `(2) the preview answers /version: ${at.status} ${at.body}`,
  );
}
check(settled.state === "landed", `(2) the change lands: ${settled.state}`);
const afterLanding = await (async () => {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const seen = await events();
    if (seen.some((e) => e.payload._tag === "DeploymentPromoted") || Date.now() > deadline)
      return seen;
    await new Promise((r) => setTimeout(r, 5_000));
  }
})();
for (const event of afterLanding.filter((e) =>
  /Deploy|Delivery|Preview|Verdict/.test(e.payload._tag),
))
  say(`     ${line(event)}`);
check(
  afterLanding.some((e) => e.payload._tag === "DeploymentPromoted"),
  "(2) Deliver promoted the previewed version: DeploymentPromoted is on the project's feed",
);
if (preview !== undefined) {
  const live = String(preview.url).replace(/^https:\/\/[0-9a-f]{8}-/, "https://");
  const at = await answerWhen(`${live}/version`, 200, VERSION);
  check(
    at.status === 200 && at.body.includes(VERSION),
    `(2) ${live}/version answers: ${at.status} ${at.body}`,
  );
}

// (3) /health answers 500: the preview fails its smoke and the change bounces.
const promotedBefore = afterLanding.filter((e) => e.payload._tag === "DeploymentPromoted").length;
const third = await work(
  "broken",
  "Answer /health with 500",
  [{ path: SOURCE, op: "edit" }],
  (dir) => editSource(dir, 'c.text("ok")', 'c.text("down", 500)'),
);
const bounced = await settle("broken", third);
say(`     ${JSON.stringify(bounced).slice(0, 600)}`);
check(bounced.state === "bounced", `(3) the broken change bounces: ${bounced.state}`);
check(JSON.stringify(bounced).includes("deploy.smoke"), "(3) its bounce cites deploy.smoke");
const atEnd = await events();
for (const event of atEnd
  .slice(afterLanding.length)
  .filter((e) => /Deploy|Delivery|Preview|Verdict|Bounced/.test(e.payload._tag)))
  say(`     ${line(event)}`);
check(
  atEnd.filter((e) => e.payload._tag === "DeploymentPromoted").length === promotedBefore,
  "(3) nothing more is promoted",
);

say(failures === 0 ? "w2a: every check passed" : `w2a: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
