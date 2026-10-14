// Runs loadgen once against a Keel and writes its report. One agent account
// (signed up by key on the first run, its key kept on this machine) owns the
// project; each synthetic agent is a run of that account.
//
//   node examples/loadgen/scripts/run.ts --agents 5 [--seed 42] [--run r1]
//     [--keel https://keel.town] [--project loadgen] [--minutes 60] [--seal-only]
//
// --seal-only writes the run's benchmark key and prints its digest, and starts
// nothing: publish the digest, then run again with the same --run and --seed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  KeelClient,
  KeelProblem,
  discover,
  generateAgentKey,
  signUp,
  signerFromJwk,
  type AgentSigner,
} from "@keeltown/sdk";
import { patiently, work, type AgentResult } from "../src/agent.ts";
import { score } from "../src/bench.ts";
import { compare, expectedTrunk } from "../src/integrity.ts";
import { Pace, TOKENS_PER_MINUTE, paced } from "../src/limits.ts";
import { anchoredAt, planRun, sealed, type Plan } from "../src/plan.ts";
import { summarise, ties, type KeelEvent } from "../src/report.ts";

const { values } = parseArgs({
  options: {
    agents: { type: "string" },
    seed: { type: "string", default: "42" },
    run: { type: "string" },
    keel: { type: "string", default: "https://keel.town" },
    project: { type: "string", default: "loadgen" },
    minutes: { type: "string", default: "60" },
    "seal-only": { type: "boolean", default: false },
  },
});
if (values.agents === undefined) throw new Error("--agents is required");
const count = Number(values.agents);
const seed = Number(values.seed);
const run = values.run ?? `r${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}`;
const keel = values.keel;
const deadline = Date.now() + Number(values.minutes) * 60_000;
const BATCH = 16;
const runs = join(import.meta.dirname, "..", "runs");
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`${stamp()} ${line}`);

// The plan and its sealed key, before anything reaches Keel.
const plan = planRun({ run, seed, count });
const seal = sealed(plan);
mkdirSync(runs, { recursive: true });
const keyFile = join(runs, `${run}.key.json`);
if (existsSync(keyFile) && readFileSync(keyFile, "utf8") !== seal.text)
  throw new Error(
    `${keyFile} holds another key: this --run was sealed with another --seed or --agents`,
  );
writeFileSync(keyFile, seal.text);
log(
  `run ${run}: ${count} agents, seed ${seed}; the benchmark's key is sealed, sha256 ${seal.sha256}`,
);
if (values["seal-only"]) process.exit(0);

// The account: one agent, its key in a file only this user reads.
const keep = join(homedir(), ".keel", "loadgen-agent.json");
async function account(): Promise<{
  readonly agentId: string;
  readonly handle: string;
  readonly signer: AgentSigner;
}> {
  if (existsSync(keep)) {
    const held: unknown = JSON.parse(readFileSync(keep, "utf8"));
    const agentId: unknown = Reflect.get(Object(held), "agentId");
    const handle: unknown = Reflect.get(Object(held), "handle");
    if (typeof agentId !== "string" || typeof handle !== "string")
      throw new Error(`${keep} holds no account`);
    return {
      agentId,
      handle,
      signer: await signerFromJwk(Reflect.get(Object(held), "privateJwk")),
    };
  }
  const { signer, privateJwk } = await generateAgentKey();
  const made = await signUp({ baseUrl: keel, signer, name: "loadgen" });
  mkdirSync(join(homedir(), ".keel"), { recursive: true });
  writeFileSync(keep, JSON.stringify({ agentId: made.agentId, handle: made.handle, privateJwk }), {
    mode: 0o600,
  });
  chmodSync(keep, 0o600);
  log(`signed up the loadgen agent ${made.handle} (${made.agentId}); its key is in ${keep}`);
  return { agentId: made.agentId, handle: made.handle, signer };
}
const me = await account();
const pace = new Pace(TOKENS_PER_MINUTE);
const fetch = paced(
  (input, init) => globalThis.fetch(input, init),
  pace,
  (await discover(keel)).tokenEndpoint,
);
const client = (runLabel: string, project?: string) =>
  new KeelClient({
    baseUrl: keel,
    agentId: me.agentId,
    key: me.signer,
    run: runLabel,
    fetch,
    ...(project === undefined ? {} : { project }),
  });

// The project, the account's own, with verification off and batches of up to 16.
const own = client(`lg-${run}-owner`);
async function projectId(): Promise<string> {
  for (let cursor: string | undefined; ;) {
    // oxlint-disable-next-line no-await-in-loop -- page after page
    const page = await own.projects({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    const found = page.items.find(
      (p) => p.name === values.project && p.namespace.handle === me.handle,
    );
    if (found !== undefined) return found.id;
    if (page.nextCursor === undefined || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  const made = await own.createProject(
    { namespace: me.handle, name: values.project, source: { kind: "empty" } },
    { idempotencyKey: `lg:project:${values.project}` },
  );
  log(`made ${me.handle}/${values.project} (${made.id}), empty`);
  return made.id;
}
const project = await projectId();
const admin = client(`lg-${run}-admin`, project);
const settings = await admin.settings(project);
if (settings.verification !== "off" || settings.maxBatchSize !== BATCH) {
  await admin.putSettings(project, {
    ...settings,
    protectedPaths: [...settings.protectedPaths],
    verification: "off",
    maxBatchSize: BATCH,
  });
  log(`set ${me.handle}/${values.project}: verification off, batches of up to ${BATCH}`);
}

/** Every event of the project after `cursor`, oldest first, and the cursor after the last. */
async function eventsAfter(reader: KeelClient, cursor: string | undefined) {
  const events: KeelEvent[] = [];
  let at = cursor;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- page after page
    const page = await reader.events({
      project,
      limit: 500,
      ...(at === undefined ? {} : { cursor: at }),
    });
    events.push(...page.items.filter((e) => e.project === project));
    if (page.items.length === 0 || page.nextCursor === at) return { events, cursor: at };
    at = page.nextCursor;
  }
}
const reader = client(`lg-${run}-reader`, project);
const start = await eventsAfter(reader, undefined);

// The run's base files, landed by one change before any agent starts.
const seedTask = {
  index: -1,
  kind: "disjoint" as const,
  goal: `Lay out loadgen run ${run}'s base files`,
  footprint: plan.base.map((f) => ({ path: f.path, op: "create" as const })),
  premises: [],
  edit: { op: "create" as const, path: plan.base[0]?.path ?? `${plan.dir}/README.md`, content: "" },
};
const seeder = client(`lg-${run}-seed`, project);
const { result: seeded } = await patiently(
  () =>
    seeder.declare(
      { goal: seedTask.goal, footprint: seedTask.footprint, premises: [] },
      { idempotencyKey: `lg:${run}:seed:declare` },
    ),
  deadline,
);
const seedLease = seeded.lease.id;
const seedBase = seeded.workspace.baseSha;
const { result: seedCommit } = await patiently(
  () =>
    seeder.commitEdits(
      seeded.change.id,
      {
        expectedHead: seedBase,
        message: seedTask.goal,
        edits: plan.base.map((f) => ({ path: f.path, content: f.content })),
      },
      { lease: seedLease, idempotencyKey: `lg:${run}:seed:commit` },
    ),
  deadline,
);
await patiently(
  () =>
    seeder.submit(
      { changeId: seeded.change.id, commitSha: seedCommit.commitSha },
      { lease: seedLease, idempotencyKey: `lg:${run}:seed:submit` },
    ),
  deadline,
);
for (;;) {
  // oxlint-disable-next-line no-await-in-loop -- a long poll
  const { result } = await patiently(() => seeder.status(seeded.change.id, { wait: 30 }), deadline);
  if (result.state === "landed") break;
  if (["bounced", "withdrawn", "superseded"].includes(result.state) || Date.now() > deadline)
    throw new Error(`the base files' change ${seeded.change.id} is ${result.state}`);
}
const baseCommit = (await reader.commits(project, { limit: 1 })).items[0]?.sha;
if (baseCommit === undefined) throw new Error("trunk has no head after the base landed");
log(`the base files landed at ${baseCommit.slice(0, 12)} (${plan.base.length} files)`);
const anchored: Plan = anchoredAt(plan, baseCommit);

// The agents: every run at once; the token pace sets how fast they start.
const results: AgentResult[] = [];
const progress = setInterval(() => {
  const by = (o: AgentResult["outcome"]) => results.filter((r) => r.outcome === o).length;
  log(
    `${results.length}/${count} done: ${by("landed")} landed, ${by("gave-up")} gave up, ${by("failed")} failed; token refusals ${pace.refused}`,
  );
}, 30_000);
await Promise.all(
  anchored.tasks.map(async (task) => {
    const result = await work(client(`lg-${run}-${task.index}`, project), project, task, {
      key: `lg:${run}:${task.index}`,
      deadline,
    });
    results.push(result);
  }),
);
clearInterval(progress);

// Keel's record of the run, read back.
const { events } = await eventsAfter(reader, start.cursor);
const changeOf = new Map(
  results.flatMap((r) => (r.changeId === undefined ? [] : [[r.index, r.changeId] as const])),
);
const indexOf = new Map([...changeOf].map(([index, id]) => [id, index] as const));
const changes = new Set(changeOf.values());
const report = summarise(
  events,
  changes,
  count,
  results.flatMap((r) => (r.declareMs === undefined ? [] : [r.declareMs])),
);
const bench = score(anchored.key, (i) => changeOf.get(i), ties(events));

// The integrity check: the trunk Keel serves against the trunk the landings make.
const landedInOrder = events.flatMap((e) =>
  e.payload._tag === "ChangeLanded" && indexOf.has(e.payload.changeId)
    ? [indexOf.get(e.payload.changeId) ?? -1]
    : [],
);
const expected = expectedTrunk(anchored, landedInOrder);
const served = new Map<string, string>();
const head = (await reader.commits(project, { limit: 1 })).items[0]?.sha;
async function walk(path: string): Promise<void> {
  let tree;
  try {
    tree = await reader.tree(project, { path, ...(head === undefined ? {} : { ref: head }) });
  } catch (error) {
    if (error instanceof KeelProblem && error.status === 404) return;
    throw error;
  }
  for (const entry of tree.entries) {
    const at = entry.path;
    // oxlint-disable-next-line no-await-in-loop -- one read at a time keeps the reader's load low
    if (entry.kind === "tree") await walk(at);
    else {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time
      const blob = await reader.blob(project, at, head === undefined ? {} : { ref: head });
      served.set(at, blob.content ?? "");
    }
  }
}
await walk(plan.dir);
const breaks = [...expected.breaks, ...compare(expected.files, served)];

// Pairs whose two sides both landed, by kind: a planted pair here is a conflict now on trunk.
const landed = new Set(results.filter((r) => r.outcome === "landed").map((r) => r.index));
const bothLanded = anchored.key.filter((k) => landed.has(k.a) && landed.has(k.b));

const written = {
  run,
  seed,
  keel,
  project: `${me.handle}/${values.project}`,
  projectId: project,
  verification:
    "off, the owner's setting; no suite, no guards; this measures coordination and the Trunk, not CI",
  maxBatchSize: BATCH,
  keySha256: seal.sha256,
  baseCommit,
  trunkHead: head,
  endedAt: new Date().toISOString(),
  timedOut: Date.now() > deadline,
  tokenRefusals: pace.refused,
  outcomes: {
    landed: results.filter((r) => r.outcome === "landed").length,
    gaveUp: results.filter((r) => r.outcome === "gave-up").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    reasons: Object.entries(
      results.reduce<Record<string, number>>((acc, r) => {
        if (r.reason !== undefined)
          acc[r.reason.slice(0, 120)] = (acc[r.reason.slice(0, 120)] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 10),
  },
  report,
  trunkBreaks: breaks.length,
  breaks: breaks.slice(0, 50),
  bench,
  bothLanded: bothLanded.map((k) => ({ pair: k.pair, kind: k.kind, planted: k.planted })),
  agents: results.toSorted((a, b) => a.index - b.index),
};
writeFileSync(join(runs, `${run}.json`), `${JSON.stringify(written, null, 2)}\n`);

const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);
const sec = (x: number | null) => (x === null ? "–" : `${(x / 1000).toFixed(1)} s`);
console.log(`
verification: off, the owner's setting; no suite, no guards; this measures coordination and the Trunk, not CI
${count} runs of one agent account (${me.handle}) in ${me.handle}/${values.project}, batches of up to ${BATCH}

| | ${run} |
|---|---:|
| Agents | ${report.agents} |
| Declared | ${report.declared} |
| Landed | ${report.landed} |
| Not landed | ${report.notLanded} |
| Bounces | ${report.bounces} |
| Contention density | ${pct(report.contentionDensity)} |
| Rework rate (bounces per landing) | ${report.reworkRate === null ? "–" : report.reworkRate.toFixed(2)} |
| Time in queue p50 / p95 | ${sec(report.queueMs.p50)} / ${sec(report.queueMs.p95)} |
| Preflight (the declare call) p50 / p99 | ${sec(report.preflightMs.p50)} / ${sec(report.preflightMs.p99)} |
| Trunk promotions | ${report.trunk.promotions} |
| Promotions a second | ${report.trunk.promotionsPerSecond === null ? "–" : report.trunk.promotionsPerSecond.toFixed(3)} |
| Changes per group commit (mean / max) | ${report.trunk.changesPerGroupCommit.mean === null ? "–" : report.trunk.changesPerGroupCommit.mean.toFixed(2)} / ${report.trunk.changesPerGroupCommit.max} |
| Promotion latency p50 / p95 | ${sec(report.trunk.promotionMs.p50)} / ${sec(report.trunk.promotionMs.p95)} |
| Trunk breaks | ${breaks.length} |
| Token refusals (429) | ${pace.refused} |
| Benchmark recall (≥ 70%) | ${pct(bench.recall)} |
| Decoy false positives (≤ 20%) | ${pct(bench.falsePositiveRate)} |
`);
for (const [kind, k] of Object.entries(bench.byKind))
  console.log(
    `  ${kind}: recalled ${k.recalled}/${k.planted}, false positives ${k.falsePositives}/${k.decoys}`,
  );
