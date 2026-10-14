// Sets a swarm up on Keel as the person signed in under a keeltown profile:
// makes the project from the fixture's template in their namespace (or takes
// the one --project names), invites the swarm's accounts to it, and has each
// accept. Run it within ten minutes of `keeltown --profile <name> login`
// approved with a passkey: inviting an agent needs a fresh passkey sign-in.
//
//   SWARM_URL=… SWARM_ADMIN_TOKEN=… node examples/swarm/scripts/setup.ts \
//     --shape one --namespace <handle> [--name swarm] [--project prj_…] [--profile swarm]
//
// Every Keel call is the CLI's, from this checkout, under the profile: this
// script reads no sign-in, cookie or token. Use a profile that holds no agent
// key, so the CLI acts as the person.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Anything, Roster, swarmAdmin } from "./admin.ts";

const { values } = parseArgs({
  options: {
    shape: { type: "string" },
    namespace: { type: "string" },
    name: { type: "string", default: "swarm" },
    project: { type: "string" },
    profile: { type: "string", default: "swarm" },
  },
});
const shape = values.shape;
if (shape !== "one" && shape !== "many")
  throw new Error("--shape is one (an account with many runs) or many (an account each)");
const keel = process.env["KEEL_URL"] ?? "https://keel.town";
const cli = join(import.meta.dirname, "../../../packages/cli/src/bin.ts");
const admin = swarmAdmin();

/** One keeltown command under the profile, its answer as JSON. */
function keeltown(args: readonly string[]): unknown {
  const out = execFileSync(
    process.execPath,
    ["--no-warnings", cli, ...args, "--profile", values.profile, "--json"],
    {
      env: { ...process.env, KEEL_URL: keel },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return JSON.parse(out);
}

const roster =
  shape === "one"
    ? await admin(Roster, "POST", "/admin/agents", { shape: "one" })
    : await admin(Roster, "GET", "/admin/agents");
const handles = shape === "one" ? [roster.one?.handle] : roster.many.map((m) => m.handle);
if (handles.length === 0 || handles.some((h) => h === undefined))
  throw new Error(`The swarm has no ${shape} accounts signed up yet: POST /admin/agents first.`);

let project = values.project;
if (project === undefined) {
  if (values.namespace === undefined)
    throw new Error("--namespace names whose project it is (or --project an existing one)");
  const made = keeltown([
    "project",
    "create",
    "--namespace",
    values.namespace,
    "--name",
    values.name,
    "--template",
    "fixture-forge-lite",
  ]);
  const id: unknown =
    typeof made === "object" && made !== null ? Reflect.get(made, "id") : undefined;
  if (typeof id !== "string")
    throw new Error(`project create answered no id: ${JSON.stringify(made)}`);
  project = id;
  console.log(`made ${values.namespace}/${values.name} (${project}), private`);
}
for (const handle of handles) {
  keeltown(["project", "invite", "--project", project, "--agent", String(handle)]);
  console.log(`invited ${String(handle)}`);
}
console.log(JSON.stringify(await admin(Anything, "POST", "/admin/accept", { shape, project })));
console.log(`\nset up: project ${project}, ${handles.length} account(s) of shape ${shape}`);
