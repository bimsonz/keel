// Two real agents at once against a deployed Keel: pnpm e2e:agents [env]
//
// Each agent is an MCP-capable agent CLI, run headless with one MCP server,
// Keel's own (`<KEEL_URL>/mcp`, a bearer token from a fresh exchange), and a
// task of its own on forge-lite: declare, push to its workspace, submit, wait.
// They run concurrently, each in a scratch directory of its own.
//
// Keel names no agent CLI: any agent that speaks MCP can drive S-0. Which one
// runs, and how it is told its prompt and MCP config, comes from a local file,
// `.keel/agents.json` (gitignored), or from KEEL_AGENTS_CONFIG naming one; see
// `e2e/agents/agents.example.json`. Its `args` may hold `{prompt}`,
// `{mcpConfig}` and `{workdir}`. The arguments must load that MCP config as the
// agent's only server and allow it Keel's tools, git, and file edits inside
// the working directory, and nothing else: no general shell, no web tools.
//
// Afterwards both changes must have landed through verified advances, read
// from the observer's feed. Transcripts (stream-json) go to
// `.keel/runs/<run>/<agent>.jsonl` with the run's record.
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { clientFor, readSeeded } from "../src/lib/seeded.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const environment = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "staging";
const run = new Date().toISOString().replace(/[:.]/g, "-");

interface AgentCli {
  readonly command: string;
  readonly args: readonly string[];
}

/** The agent CLI and how to call it, from the operator's own config: there is no default. */
function agentCli(): AgentCli {
  const path = process.env["KEEL_AGENTS_CONFIG"] ?? join(root, ".keel", "agents.json");
  if (!existsSync(path))
    throw new Error(
      `No agent CLI is configured: write ${path} (see e2e/agents/agents.example.json) naming an MCP-capable agent CLI and its arguments.`,
    );
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  const command: unknown = Reflect.get(Object(config), "command");
  const args: unknown = Reflect.get(Object(config), "args");
  if (
    typeof command !== "string" ||
    command === "" ||
    !Array.isArray(args) ||
    !args.every((a) => typeof a === "string")
  )
    throw new Error(`${path} must hold {"command": string, "args": string[]}`);
  if (!args.some((a) => a.includes("{prompt}")) || !args.some((a) => a.includes("{mcpConfig}")))
    throw new Error(`${path}: args must pass {prompt} and {mcpConfig} to the agent`);
  return { command, args };
}
const cli = agentCli();
const TIMEOUT_MS = Number(process.env["AGENTS_TIMEOUT_MS"] ?? 20 * 60_000);

const seeded = readSeeded(root, environment);
const keelUrl = process.env["KEEL_URL"] ?? seeded.keelUrl;
const project = seeded.projects["forge-lite"];
if (project === undefined || project.agents.length < 2)
  throw new Error("seed forge-lite with two agents");

const TASKS = {
  a1: `Add a test to test/repos.test.ts that creating a repository twice with the same name answers 409. Note the run id ${run} in the test's title.`,
  a2: `Add a section to scenarios/README.md, headed "Run ${run}", saying in one sentence what S-0 checks.`,
} as const;

function prompt(agent: keyof typeof TASKS): string {
  return [
    `You are ${agent}, an agent working on the forge-lite repository through Keel, an agent-first git platform.`,
    "Keel is your only way to change the code. Use its MCP tools:",
    "1. Call `declare` with a one-line goal, the footprint of files you will touch, and no premises. Keep the lease id, the workspace remote and its token from the answer.",
    "2. Clone the workspace remote into the current directory with git, passing the token only as an HTTP header:",
    '   git -c http.extraHeader="Authorization: Bearer <token>" clone <remote> repo',
    "3. Make the change below, commit it, and push it to the workspace's main the same way.",
    "4. Call `submit` with the change id, the commit sha and the lease.",
    "5. Call `status` with wait=30 until the change is landed or bounced. If it bounced, follow the next actions it names.",
    "Push nowhere but your workspace. Do not use any other remote.",
    `Your change: ${TASKS[agent]}`,
  ].join("\n");
}

interface Outcome {
  readonly agent: string;
  readonly exit: number | null;
  readonly transcript: string;
}

async function runAgent(agent: keyof typeof TASKS, index: number, dir: string): Promise<Outcome> {
  const credential = project?.agents[index];
  if (credential === undefined) throw new Error(`no seeded ${agent}`);
  const token = await clientFor(keelUrl, credential).token({ fresh: true });
  const scratch = mkdtempSync(join(tmpdir(), `keel-${agent}-`));
  const mcpConfig = join(scratch, ".mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        keel: {
          type: "http",
          url: `${keelUrl}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }),
    { mode: 0o600 },
  );
  const transcript = join(dir, `${agent}.jsonl`);
  const out = createWriteStream(transcript);
  const fill = (arg: string) =>
    arg
      .replaceAll("{prompt}", prompt(agent))
      .replaceAll("{mcpConfig}", mcpConfig)
      .replaceAll("{workdir}", scratch);
  const child = spawn(cli.command, cli.args.map(fill), {
    cwd: scratch,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
  const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  rmSync(scratch, { recursive: true, force: true });
  return { agent, exit, transcript };
}

const dir = join(root, ".keel", "runs", run);
mkdirSync(dir, { recursive: true });
const observer = clientFor(keelUrl, seeded.observer);
let from = (await observer.events({ limit: 500 })).nextCursor;
for (
  let page = await observer.events({ cursor: from, limit: 500 });
  page.items.length > 0;
  page = await observer.events({ cursor: from, limit: 500 })
)
  from = page.nextCursor;

console.log(`two agents on forge-lite, run ${run}`);
const outcomes = await Promise.all([runAgent("a1", 0, dir), runAgent("a2", 1, dir)]);
for (const o of outcomes)
  console.log(`     ${o.agent} exited ${o.exit}; transcript ${o.transcript}`);

const events = [];
for (
  let page = await observer.events({ cursor: from, limit: 500 });
  page.items.length > 0;
  page = await observer.events({ cursor: page.nextCursor, limit: 500 })
) {
  events.push(...page.items);
  if (page.items.length < 500) break;
}
const landedBy = new Map<string, string>();
const agentOf = new Map<string, string>();
for (const e of events) {
  if (e.payload._tag === "IntentDeclared" && e.project === project.id)
    agentOf.set(e.payload.changeId, e.payload.agentId);
  if (
    e.payload._tag === "TrunkAdvanced" &&
    e.project === project.id &&
    e.payload.verified !== false
  )
    for (const landing of e.payload.landings) landedBy.set(landing.changeId, landing.commitSha);
}
const wanted = project.agents.slice(0, 2).map((a) => a.agentId);
const landedAgents = new Set([...landedBy.keys()].map((id) => agentOf.get(id)));
const ok = wanted.every((id) => landedAgents.has(id));
writeFileSync(
  join(dir, "agents.json"),
  `${JSON.stringify({ run, outcomes, landed: [...landedBy.entries()] }, null, 2)}\n`,
);
console.log(
  ok
    ? "both agents' changes landed through verified advances"
    : "FAIL: not every agent's change landed",
);
process.exit(ok ? 0 : 1);
