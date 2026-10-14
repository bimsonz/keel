// Runs loadgen once against a Keel and writes its report. One agent account
// (signed up by key on the first run, its key kept on this machine) owns the
// projects; each synthetic agent is a run of that account.
//
//   node examples/loadgen/scripts/run.ts --agents 5 [--projects 1] [--seed 42]
//     [--run r1] [--keel https://keel.town] [--minutes 60] [--seal-only]
//
// Each project's Trunk promotes one batch at a time; --projects spreads the
// agents over that many of the account's own projects (`loadgen`,
// `loadgen-1`, …), each with its own lane and Trunk, and each with its own
// share of the overlap.
//
// --seal-only writes the run's benchmark key and prints its digest, and starts
// nothing: publish the digest, then run again with the same arguments.
import { createHash } from "node:crypto";
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
import { compare, expectedTrunk, type Break } from "../src/integrity.ts";
import { Pace, TOKENS_PER_MINUTE, paced } from "../src/limits.ts";
import { anchoredAt, planRun, sealed, type PairKey, type Plan } from "../src/plan.ts";
import { summarise, ties, type KeelEvent, type LoadReport } from "../src/report.ts";
import { Watch } from "../src/watch.ts";

const { values } = parseArgs({
  options: {
    agents: { type: "string" },
    projects: { type: "string", default: "1" },
    seed: { type: "string", default: "42" },
    run: { type: "string" },
    keel: { type: "string", default: "https://keel.town" },
    minutes: { type: "string", default: "60" },
    "seal-only": { type: "boolean", default: false },
  },
});
if (values.agents === undefined) throw new Error("--agents is required");
const count = Number(values.agents);
const shards = Number(values.projects);
const seed = Number(values.seed);
const run = values.run ?? `r${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}`;
const keel = values.keel;
const deadline = Date.now() + Number(values.minutes) * 60_000;
const BATCH = 16;
const runs = join(import.meta.dirname, "..", "runs");
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`${stamp()} ${line}`);

// The plans and their sealed key, before anything reaches Keel. One project keeps the run's own label.
const projectName = (k: number) => (k === 0 ? "loadgen" : `loadgen-${k}`);
const plans: Plan[] = Array.from({ length: shards }, (_, k) =>
  planRun({
    run: shards === 1 ? run : `${run}-p${k}`,
    seed: seed + k,
    count: Math.floor(count / shards) + (k < count % shards ? 1 : 0),
  }),
);
const seal =
  shards === 1 && plans[0] !== undefined
    ? sealed(plans[0])
    : (() => {
        const text = `${JSON.stringify(
          {
            run,
            seed,
            shards: plans.map((p, k) => ({
              project: projectName(k),
              run: p.run,
              seed: p.seed,
              pairs: p.key,
            })),
          },
          null,
          2,
        )}\n`;
        return { text, sha256: createHash("sha256").update(text).digest("hex") };
      })();
mkdirSync(runs, { recursive: true });
const keyFile = join(runs, `${run}.key.json`);
if (existsSync(keyFile) && readFileSync(keyFile, "utf8") !== seal.text)
  throw new Error(`${keyFile} holds another key: this --run was sealed with other arguments`);
writeFileSync(keyFile, seal.text);
log(
  `run ${run}: ${count} agents over ${shards} project(s), seed ${seed}; the benchmark's key is sealed, sha256 ${seal.sha256}`,
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
const { tokenEndpoint } = await discover(keel);
// Each client its own pace-held fetch: a slot it was given and could not use is kept for its retry.
const client = (runLabel: string, project?: string) =>
  new KeelClient({
    baseUrl: keel,
    agentId: me.agentId,
    key: me.signer,
    run: runLabel,
    fetch: paced((input, init) => globalThis.fetch(input, init), pace, tokenEndpoint),
    ...(project === undefined ? {} : { project }),
  });
const own = client(`lg-${run}-owner`);

// The account's own private projects aren't in the list it can read, so their ids are kept beside the key.
async function projectId(name: string): Promise<string> {
  const held: unknown = JSON.parse(readFileSync(keep, "utf8"));
  const projects: unknown = Reflect.get(Object(held), "projects");
  const known: unknown = Reflect.get(Object(projects), name);
  if (typeof known === "string") return known;
  const made = await own.createProject(
    { namespace: me.handle, name, source: { kind: "empty" } },
    { idempotencyKey: `lg:project:${name}` },
  );
  writeFileSync(
    keep,
    JSON.stringify({ ...Object(held), projects: { ...Object(projects), [name]: made.id } }),
    { mode: 0o600 },
  );
  log(`made ${me.handle}/${name} (${made.id}), empty`);
  return made.id;
}

/** Every event of the project after `cursor`, oldest first, and the cursor after the last. */
async function eventsAfter(reader: KeelClient, project: string, cursor: string | undefined) {
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

interface Shard {
  readonly name: string;
  readonly project: string;
  readonly reader: KeelClient;
  readonly plan: Plan;
  readonly watch: Watch;
  readonly baseCommit: string;
}

/** A project made ready for its share of the run: its settings, and the base files landed by one change. */
async function prepare(k: number, plan: Plan): Promise<Shard> {
  const name = projectName(k);
  const project = await projectId(name);
  const admin = client(`lg-${plan.run}-admin`, project);
  const settings = await admin.settings(project);
  if (settings.verification !== "off" || settings.maxBatchSize !== BATCH) {
    await admin.putSettings(project, {
      ...settings,
      protectedPaths: [...settings.protectedPaths],
      verification: "off",
      maxBatchSize: BATCH,
    });
    log(`set ${me.handle}/${name}: verification off, batches of up to ${BATCH}`);
  }
  const reader = client(`lg-${plan.run}-reader`, project);
  const start = await eventsAfter(reader, project, undefined);
  const seeder = client(`lg-${plan.run}-seed`, project);
  const goal = `Lay out loadgen run ${plan.run}'s base files`;
  const { result: seeded } = await patiently(
    () =>
      seeder.declare(
        {
          goal,
          footprint: plan.base.map((f) => ({ path: f.path, op: "create" as const })),
          premises: [],
        },
        { idempotencyKey: `lg:${plan.run}:seed:declare` },
      ),
    deadline,
  );
  const lease = seeded.lease.id;
  const { result: committed } = await patiently(
    () =>
      seeder.commitEdits(
        seeded.change.id,
        {
          expectedHead: seeded.workspace.baseSha,
          message: goal,
          edits: plan.base.map((f) => ({ path: f.path, content: f.content })),
        },
        { lease, idempotencyKey: `lg:${plan.run}:seed:commit` },
      ),
    deadline,
  );
  await patiently(
    () =>
      seeder.submit(
        { changeId: seeded.change.id, commitSha: committed.commitSha },
        { lease, idempotencyKey: `lg:${plan.run}:seed:submit` },
      ),
    deadline,
  );
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a long poll
    const { result } = await patiently(
      () => seeder.status(seeded.change.id, { wait: 30 }),
      deadline,
    );
    if (result.state === "landed") break;
    if (["bounced", "withdrawn", "superseded"].includes(result.state) || Date.now() > deadline)
      throw new Error(`the base files' change ${seeded.change.id} in ${name} is ${result.state}`);
  }
  const baseCommit = (await reader.commits(project, { limit: 1 })).items[0]?.sha;
  if (baseCommit === undefined)
    throw new Error(`${name}'s trunk has no head after the base landed`);
  log(`${name}: the base files landed at ${baseCommit.slice(0, 12)} (${plan.base.length} files)`);
  return {
    name,
    project,
    reader,
    plan: anchoredAt(plan, baseCommit),
    watch: new Watch(reader, project, start.cursor),
    baseCommit,
  };
}
const ready = await Promise.all(plans.map((plan, k) => prepare(k, plan)));

// The agents: every run at once; the token pace sets how fast they start.
const results = new Map<Shard, AgentResult[]>(ready.map((s) => [s, []]));
const all = () => [...results.values()].flat();
const progress = setInterval(() => {
  const done = all();
  const by = (o: AgentResult["outcome"]) => done.filter((r) => r.outcome === o).length;
  log(
    `${done.length}/${count} done: ${by("landed")} landed, ${by("gave-up")} gave up, ${by("failed")} failed; token refusals ${pace.refused}`,
  );
}, 30_000);
const following = ready.map((s) =>
  s.watch.follow(() => (results.get(s)?.length ?? 0) === s.plan.tasks.length),
);
// Started in turn across the projects, so each project's agents arrive at the same pace.
const order = ready.flatMap((s) => s.plan.tasks.map((task) => ({ s, task })));
order.sort((x, y) => x.task.index - y.task.index || ready.indexOf(x.s) - ready.indexOf(y.s));
await Promise.all(
  order.map(async ({ s, task }) => {
    const result = await work(
      client(`lg-${s.plan.run}-${task.index}`, s.project),
      s.project,
      task,
      {
        key: `lg:${s.plan.run}:${task.index}`,
        deadline,
        settled: (changeId, nth) => s.watch.settled(changeId, nth),
      },
    );
    results.get(s)?.push(result);
    if (result.outcome !== "landed")
      log(`${s.name} agent ${task.index} ${result.outcome}: ${result.reason ?? ""}`);
  }),
);
clearInterval(progress);
await Promise.all(following);

/** One project's share, read back from Keel: its numbers, its benchmark's ties, and its trunk's integrity. */
async function readBack(s: Shard) {
  const mine = results.get(s) ?? [];
  const { events: after } = await eventsAfter(s.reader, s.project, s.watch.cursor);
  const events = [...s.watch.events, ...after];
  const changeOf = new Map(
    mine.flatMap((r) => (r.changeId === undefined ? [] : [[r.index, r.changeId] as const])),
  );
  const indexOf = new Map([...changeOf].map(([index, id]) => [id, index] as const));
  const landedInOrder = events.flatMap((e) =>
    e.payload._tag === "ChangeLanded" && indexOf.has(e.payload.changeId)
      ? [indexOf.get(e.payload.changeId) ?? -1]
      : [],
  );
  const expected = expectedTrunk(s.plan, landedInOrder);
  const served = new Map<string, string>();
  const head = (await s.reader.commits(s.project, { limit: 1 })).items[0]?.sha;
  const walk = async (path: string): Promise<void> => {
    let tree;
    try {
      tree = await s.reader.tree(s.project, { path, ...(head === undefined ? {} : { ref: head }) });
    } catch (error) {
      if (error instanceof KeelProblem && error.status === 404) return;
      throw error;
    }
    for (const entry of tree.entries) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time keeps the reader's load low
      if (entry.kind === "tree") await walk(entry.path);
      else {
        // oxlint-disable-next-line no-await-in-loop -- one read at a time
        const blob = await s.reader.blob(
          s.project,
          entry.path,
          head === undefined ? {} : { ref: head },
        );
        served.set(entry.path, blob.content ?? "");
      }
    }
  };
  await walk(s.plan.dir);
  const breaks: Break[] = [...expected.breaks, ...compare(expected.files, served)];
  const declareMs = mine.flatMap((r) => (r.declareMs === undefined ? [] : [r.declareMs]));
  return {
    s,
    mine,
    events,
    changeOf,
    breaks,
    head,
    report: summarise(events, new Set(changeOf.values()), mine.length, declareMs),
  };
}
const read = await Promise.all(ready.map(readBack));

/** Landings a minute: the changes landed over the time from the first declaration to the last landing. */
function perMinute(events: readonly KeelEvent[], changes: ReadonlySet<string>): number | null {
  const at = (tag: string) =>
    events.flatMap((e) => {
      const id: unknown = Reflect.get(e.payload, "changeId");
      return e.payload._tag === tag && typeof id === "string" && changes.has(id)
        ? [Date.parse(e.at)]
        : [];
    });
  const declared = at("IntentDeclared");
  const landings = at("ChangeLanded");
  const span = Math.max(...landings) - Math.min(...declared);
  return landings.length === 0 || !(span > 0) ? null : landings.length / (span / 60_000);
}

// The whole run: every project's events together, and the key with every pair's agents numbered across the projects.
const offsets = read.map((_, k) => read.slice(0, k).reduce((n, r) => n + r.s.plan.tasks.length, 0));
const globalKey: PairKey[] = read.flatMap((r, k) =>
  r.s.plan.key.map((p) => ({
    ...p,
    pair: p.pair + k * 10_000,
    a: p.a + (offsets[k] ?? 0),
    b: p.b + (offsets[k] ?? 0),
  })),
);
const globalChange = new Map(
  read.flatMap((r, k) =>
    [...r.changeOf].map(([index, id]) => [index + (offsets[k] ?? 0), id] as const),
  ),
);
const events = read.flatMap((r) => r.events);
const declareMs = read.flatMap((r) =>
  r.mine.flatMap((m) => (m.declareMs === undefined ? [] : [m.declareMs])),
);
const report: LoadReport = summarise(events, new Set(globalChange.values()), count, declareMs);
const bench = score(globalKey, (i) => globalChange.get(i), ties(events));
const breaks = read.flatMap((r) => r.breaks);
const landed = new Set(
  read.flatMap((r, k) =>
    r.mine.filter((m) => m.outcome === "landed").map((m) => m.index + (offsets[k] ?? 0)),
  ),
);
const bothLanded = globalKey.filter((k) => landed.has(k.a) && landed.has(k.b));
const outcomes = all();

const written = {
  run,
  seed,
  keel,
  landingsPerMinute: perMinute(events, new Set(globalChange.values())),
  projects: read.map((r) => ({
    landingsPerMinute: perMinute(r.events, new Set(r.changeOf.values())),
    name: `${me.handle}/${r.s.name}`,
    id: r.s.project,
    run: r.s.plan.run,
    baseCommit: r.s.baseCommit,
    trunkHead: r.head,
    agents: r.mine.length,
    report: r.report,
    trunkBreaks: r.breaks.length,
  })),
  verification:
    "off, the owner's setting; no suite, no guards; this measures coordination and the Trunk, not CI",
  lane: `each project's lane forms batches of up to ${BATCH}, the owner's setting; the changes each batch landed are in the report`,
  maxBatchSize: BATCH,
  keySha256: seal.sha256,
  endedAt: new Date().toISOString(),
  timedOut: Date.now() > deadline,
  tokenRefusals: pace.refused,
  tokensSignedAgain: pace.signedAgain,
  outcomes: {
    landed: outcomes.filter((r) => r.outcome === "landed").length,
    gaveUp: outcomes.filter((r) => r.outcome === "gave-up").length,
    failed: outcomes.filter((r) => r.outcome === "failed").length,
    reasons: Object.entries(
      outcomes.reduce<Record<string, number>>((acc, r) => {
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
  // The key's pairs numbered across the projects, as the bench scored them.
  globalKey,
  agents: read
    .flatMap((r, k) =>
      r.mine.map((m) => ({ ...m, project: r.s.name, global: m.index + (offsets[k] ?? 0) })),
    )
    .toSorted((a, b) => a.global - b.global),
};
writeFileSync(join(runs, `${run}.json`), `${JSON.stringify(written, null, 2)}\n`);

const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);
const sec = (x: number | null) => (x === null ? "–" : `${(x / 1000).toFixed(1)} s`);
const num = (x: number | null, d = 2) => (x === null ? "–" : x.toFixed(d));
const row = (name: string, cell: (r: LoadReport) => string) =>
  `| ${name} | ${cell(report)} |${shards > 1 ? ` ${read.map((r) => cell(r.report)).join(" | ")} |` : ""}`;
const rates = read.map((r) => perMinute(r.events, new Set(r.changeOf.values())));
const rateRow = `| Landings a minute | ${num(perMinute(events, new Set(globalChange.values())), 1)} |${shards > 1 ? ` ${rates.map((x) => num(x, 1)).join(" | ")} |` : ""}`;
console.log(`
verification: off, the owner's setting; no suite, no guards; this measures coordination and the Trunk, not CI
${count} runs of one agent account (${me.handle}) over ${shards} project(s) of its own; each project's lane forms batches of up to ${BATCH}

| | ${run}${shards > 1 ? ` | ${read.map((r) => r.s.name).join(" | ")}` : ""} |
|---|---:|${shards > 1 ? read.map(() => "---:|").join("") : ""}
${[
  row("Agents", (r) => String(r.agents)),
  row("Declared", (r) => String(r.declared)),
  row("Landed", (r) => String(r.landed)),
  rateRow,
  row("Not landed", (r) => String(r.notLanded)),
  row("Bounces", (r) => String(r.bounces)),
  row("Contention density", (r) => pct(r.contentionDensity)),
  row("Rework rate (bounces per landing)", (r) => num(r.reworkRate)),
  row("Time in queue p50 / p95", (r) => `${sec(r.queueMs.p50)} / ${sec(r.queueMs.p95)}`),
  row(
    "Preflight (the declare call) p50 / p99",
    (r) => `${sec(r.preflightMs.p50)} / ${sec(r.preflightMs.p99)}`,
  ),
  row("Trunk promotions", (r) => String(r.trunk.promotions)),
  row("Promotions a second", (r) => num(r.trunk.promotionsPerSecond, 3)),
  row(
    "Changes per group commit (mean / max)",
    (r) => `${num(r.trunk.changesPerGroupCommit.mean)} / ${r.trunk.changesPerGroupCommit.max}`,
  ),
  row(
    "Promotion latency p50 / p95",
    (r) => `${sec(r.trunk.promotionMs.p50)} / ${sec(r.trunk.promotionMs.p95)}`,
  ),
].join("\n")}

Trunk breaks: ${breaks.length}. Token refusals (429): ${pace.refused}. Token requests held past their signature's life and signed again: ${pace.signedAgain}.
Benchmark recall (≥ 70%): ${pct(bench.recall)}; decoy false positives (≤ 20%): ${pct(bench.falsePositiveRate)}; pairs Keel never saw: ${bench.unrun}.`);
for (const [kind, k] of Object.entries(bench.byKind))
  console.log(
    `  ${kind}: recalled ${k.recalled}/${k.planted}, false positives ${k.falsePositives}/${k.decoys}`,
  );
