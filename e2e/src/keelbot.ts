// keelbot's live check against a deployed Keel: an agent whose key this
// machine's key store holds lands a change on a project of its own namespace,
// or of an org that invited it, and its held inbox tells it so.
//   KEEL_URL=<keel> node e2e/src/keelbot.ts <prj_…> <namespace>/<project> <run> [profile]
//
// The agent is the one `keeltown agent signup --profile <profile>` signed up
// (`keelbot` when no profile is given), its key read from the key store as
// keeltown reads it, or from KEEL_AGENT_KEY with KEEL_AGENT_ID where there is
// no store. Nothing is signed up or made here: the project is there already.
//   (a) whoami names the agent, in the run given;
//   (b) the namespace is its own, or an org it has joined with work, and it
//       reads the project's trunk;
//   (c) it clones the project's trunk from Keel, with a plain token as git's
//       bearer, at trunk's head;
//   (d) it declares a change, pushes one file to the change's workspace and
//       submits it;
//   (e) its inbox, read from its end before the submit and held, tells the run
//       the change landed;
//   (f) trunk, fetched again, is at a commit written by the agent that names
//       the change, the agent and the run in its trailers.
// No token, key or remote URL is printed.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { machineAgent } from "@keeltown/cli";
import { KeelClient } from "@keeltown/sdk";
import { cloneWorkspace, commitAndPush, git } from "./lib/git.ts";
import { declareWhenPooled } from "./lib/live.ts";

/**
 * The command line and KEEL_URL, read once: the project's id (a token names a
 * project by it, and a token that names none reads no project) and its two
 * names, the run, the profile and Keel.
 */
function asked() {
  const usage = "usage: keelbot.ts <prj_…> <namespace>/<project> <run> [profile]";
  const [projectId, path, run, profile = "keelbot"] = process.argv.slice(2);
  const [namespace, name, ...rest] = (path ?? "").split("/");
  if (projectId === undefined || !projectId.startsWith("prj_")) throw new Error(usage);
  if (namespace === undefined || name === undefined || rest.length > 0) throw new Error(usage);
  if (run === undefined || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(run))
    throw new Error(`${usage}, the run a lower-case slug`);
  const keelUrl = process.env.KEEL_URL;
  if (keelUrl === undefined) throw new Error("KEEL_URL is not set");
  return { projectId, namespace, name, run, profile, keelUrl };
}
const { projectId, namespace, name, run, profile, keelUrl } = asked();
const HOST = new URL(keelUrl).host;
/** How long the held inbox is read for the landing: the verifier's runs and the integrator's, with room. */
const LAND_MS = 10 * 60_000;
const stamp = new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, "")
  .slice(0, 14);
const key = (what: string) => `keelbot:${run}:${stamp}:${what}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

const dirs: string[] = [];

async function land(): Promise<void> {
  const held = await machineAgent(process.platform, process.env, keelUrl, profile);
  if (held === undefined)
    throw new Error(
      `no key for profile ${profile}: run \`keeltown agent signup --profile ${profile}\``,
    );
  const { agentId, signer } = held;
  const as = (project?: string, bound = true) =>
    new KeelClient({
      baseUrl: keelUrl,
      agentId,
      key: signer,
      run,
      ...(project === undefined ? {} : { project }),
      ...(bound ? {} : { bound: false }),
    });

  // (a) who the key is.
  const own = as();
  const me = (await own.whoami()).result;
  const handle = me.agent.handle;
  if (handle === undefined) throw new Error("whoami answered no handle: this is not a key's agent");
  const runId = me.run?.id ?? "";
  console.log(`     ${me.agent.name} ${handle} (${agentId}), run ${me.run?.label} (${runId})`);
  check(me.run?.label === run, `(a) whoami names the agent ${handle}, in the run ${run}`);

  // (b) its own namespace, or the org's invitation accepted, and the project there.
  if (namespace === handle) check(true, `(b) ${namespace} is the agent's own namespace`);
  else {
    const joined = (await own.invitations()).items.find((i) => i.namespace.handle === namespace);
    console.log(
      `     ${namespace}: ${joined?.state ?? "not invited"} with ${joined?.scopes.join(" ")}`,
    );
    check(
      joined?.state === "joined" && joined.scopes.includes("agent:work"),
      `(b) it has joined ${namespace} with work`,
    );
  }
  const worker = as(projectId);
  const project = await worker.project(namespace, name);
  console.log(`     project ${namespace}/${name}: ${project.id}`);
  if (project.id !== projectId) throw new Error(`${namespace}/${name} is not ${projectId}`);
  const trunk = (await worker.commits(project.id, { limit: 1 })).items[0]?.sha ?? "";
  check(trunk !== "", `(b) it reads ${namespace}/${name}'s trunk`);

  // (c) trunk, cloned from Keel as stock git clones it, with a plain token.
  const bearer = as(project.id, false);
  const remote = `${keelUrl.replace(/\/+$/, "")}/${namespace}/${name}.git`;
  const dirT = cloneWorkspace(remote, await bearer.token());
  dirs.push(dirT);
  check(git(dirT, ["rev-parse", "HEAD"]) === trunk, "(c) its clone of trunk is at trunk's head");

  // (d) a change: declared, one file pushed to its workspace, submitted.
  const file = `notes/keelbot-${run}-${stamp}.md`;
  const goal = `keelbot ${run}: a note from Keel's own agent`;
  const declared = await declareWhenPooled(
    worker,
    { goal, footprint: [{ path: file, op: "create" }] },
    key("land"),
  );
  const changeId = declared.change.id;
  if (declared.workspace.token === undefined)
    throw new Error("declare answered no workspace token");
  const token = declared.workspace.token;
  const dir = cloneWorkspace(declared.workspace.remote, token);
  dirs.push(dir);
  git(dir, ["checkout", "-q", "-B", "main", "origin/main"]);
  if (git(dir, ["rev-parse", "HEAD"]) !== declared.workspace.baseSha)
    throw new Error("the workspace's main is not at the base it was granted at");
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), `Landed by ${handle}, Keel's own agent, in run ${run}.\n`);
  const pushed = commitAndPush(dir, token, handle, goal);
  const { cursor } = (await worker.inbox({ cursor: "end" })).result;
  await worker.submit(
    { changeId, commitSha: pushed },
    { lease: declared.lease.id, idempotencyKey: key("submit") },
  );
  console.log(`     ${changeId} submitted at ${pushed.slice(0, 12)}`);
  check(true, "(d) it declares a change, pushes one file to its workspace and submits it");

  // (e) the held inbox, from its end: nothing is polled.
  const deadline = Date.now() + LAND_MS;
  let from = cursor;
  let told: { readonly kind: string; readonly title?: string } | undefined;
  while (told === undefined && Date.now() < deadline) {
    const wait = Math.min(900, Math.ceil((deadline - Date.now()) / 1000));
    const page = (await worker.inbox({ cursor: from, wait })).result;
    from = page.cursor;
    for (const n of page.notices) console.log(`     notice ${n.kind} ${n.ref ?? ""}`);
    told = page.notices.find(
      (n) =>
        n.ref === `change:${changeId}` && (n.kind === "ChangeLanded" || n.kind === "ChangeBounced"),
    );
  }
  const state = (await worker.status(changeId)).result.state;
  console.log(`     ${changeId}: ${state}`);
  check(
    told?.kind === "ChangeLanded",
    `(e) its held inbox tells run ${run} the change landed (${told?.kind ?? "no notice"}; the change is ${state})`,
  );
  if (state !== "landed") return;

  // (f) trunk, fetched again, is the agent's commit.
  git(dirT, ["fetch", "-q", "origin", "main"], await bearer.token({ fresh: true }));
  const show = (format: string) => git(dirT, ["log", "-1", `--format=${format}`, "FETCH_HEAD"]);
  const trailer = (label: string) => show(`%(trailers:key=${label},valueonly)`).trim();
  console.log(`     trunk ${show("%h")} by ${show("%an <%ae>")}, committed by ${show("%cn")}`);
  check(
    show("%an <%ae>") === `${handle} <${agentId}@agents.${HOST}>` &&
      git(dirT, ["cat-file", "-p", `FETCH_HEAD:${file}`]).includes(run),
    "(f) trunk is at the agent's commit, holding its file",
  );
  check(
    trailer("Change-Id") === changeId &&
      trailer("Keel-Agent") === agentId &&
      trailer("Keel-Run") === runId,
    "(f) its trailers name the change, the agent and the run",
  );
}

try {
  await land();
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "all keelbot checks hold" : `${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
