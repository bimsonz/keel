// The live S-1 probe: two changes that merge cleanly and disagree about
// one premise, through the deployed Keel.
//
//   KEEL_SESSION=<token> [KEEL_ORG=<org>] KEEL_NAMESPACE_ID=<id> node apps/keel-verify/test/live/d22-live.ts <run>
//
// KEEL_SESSION is the maintainer's bearer session (a maintainer of KEEL_ORG,
// `keel` by default); it is read, never printed. KEEL_NAMESPACE_ID is the id
// of the namespace KEEL_ORG names: the stored plan is read from R2 under it. In a project of its own
// (d22-live-<run>, forked from the seeded fixture repo):
//   A relies on permission evaluation being fresh at most per-request, and adds
//     the revoke route (scenarios/s1/a.patch);
//   B declares the effect freshness = per-session, and adds the role cache
//     (scenarios/s1/b.patch).
// The Subject DO's fallout suspects a conflict, which starts the Probe Workflow
// (`probe-<conflictId>` on keel-probe). Judged from the project's event feed:
//   - the probe's cells equal S26's matrix (trunk n/a, A pass, B n/a, AB fail,
//     A-noop fail, three runs each). AB and A-noop failing is the arm that can
//     fail: a vacuous probe passes there, and is discarded;
//   - GuardAdmitted and ConflictProven name the probe, and the Probe's end
//     names the guard and its commit on the guard repo;
//   - a third change that edits a file the tenet anchors compiles a plan one
//     step longer than A's, and the stored plan carries `guard:<guardId>` pinned
//     to the probe's bundle hash;
//   - the five world checks are recorded on the conflict after it was proven.
// `wrangler tail` on keel and keel-verify records the serving versions, and is
// searched for bare "internal error" lines. Every change the run leaves open is
// abandoned at the end. KEEL_URL overrides keel.town; KEEL_ARCHIVE_BUCKET names
// the bucket the plans are stored in when it is not the committed config's.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namespaceKey } from "@keeltown/core/application/verification";
import {
  ANCHORED,
  applyPatch,
  brief,
  type Declared,
  declareS1,
  declareWhenPooled,
  type EventRecord,
  feedOf,
  field,
  FIXTURE,
  pushAndSubmit,
  scenarioPatch,
  SUBJECT,
  tagOf,
} from "../../../../e2e/src/lib/s1.ts";
import { KeelClient, KeelProblem } from "../../../../packages/sdk/src/index.ts";
import { harnessNamespace } from "./bundles.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const KEEL = join(ROOT, "apps/keel");
const KEEL_URL = process.env["KEEL_URL"] ?? "https://keel.town";
const WORLDS = ["trunk", "A", "B", "AB", "A-noop"] as const;
/** S26's matrix: what S-1's freshness probe answers in each world, on every run. */
const S26: Readonly<Record<string, string>> = {
  trunk: "n/a",
  A: "pass",
  B: "n/a",
  AB: "fail",
  "A-noop": "fail",
};
const SUSPECT_MS = 3 * 60_000;
const DECIDE_MS = 25 * 60_000;
const CHECKS_MS = 12 * 60_000;
const SETTLE_MS = 10 * 60_000;

const run = process.argv[2];
if (run === undefined || !/^[a-z0-9-]+$/.test(run))
  throw new Error("usage: d22-live.ts <run>, the run a lower-case slug");
const session = process.env["KEEL_SESSION"];
if (session === undefined) throw new Error("set KEEL_SESSION to the maintainer's session");
const ORG = process.env["KEEL_ORG"] ?? "keel";
const PROJECT = `d22-live-${run}`;

const wranglerEnv = {
  ...process.env,
  npm_config_userconfig: "/dev/null",
  WRANGLER_SEND_METRICS: "false",
};
const wrangler = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: KEEL,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: wranglerEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The maintainer: it creates the project, puts its settings and enrols its agents, which it sponsors. */
function operatorClient(): KeelClient {
  return new KeelClient({ baseUrl: KEEL_URL, session: session ?? "" });
}

interface Step {
  readonly name: string;
  readonly output: unknown;
  readonly ms: number | undefined;
}

const decoded = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** A Workflow instance as the API reports it: its status, its steps (names carry a `-<n>` suffix) and its output. */
function describe(
  workflow: string,
  id: string,
): { status: string; steps: Step[]; output: unknown } | undefined {
  let text: string;
  try {
    text = wrangler("workflows", "instances", "describe", workflow, id, "--json");
  } catch (error) {
    console.log(
      `     ${workflow} ${id}: not described (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`,
    );
    return undefined;
  }
  const json: unknown = JSON.parse(text);
  const body = Reflect.get(Object(json), "result") ?? json;
  const steps: unknown[] = Reflect.get(Object(body), "steps") ?? [];
  return {
    status: String(Reflect.get(Object(body), "status")),
    steps: steps.map((s) => {
      const start = Date.parse(String(Reflect.get(Object(s), "start")));
      const end = Date.parse(String(Reflect.get(Object(s), "end")));
      return {
        name: String(Reflect.get(Object(s), "name") ?? "?"),
        output: decoded(Reflect.get(Object(s), "output")),
        ms: Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined,
      };
    }),
    output: decoded(Reflect.get(Object(body), "output")),
  };
}

/** The instance once it has ended: the event that decides a probe comes before its last step is over. */
async function ended(
  workflow: string,
  id: string,
  ms: number,
): Promise<ReturnType<typeof describe>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const described = describe(workflow, id);
    const live = ["queued", "running", "waiting", "paused"].includes(described?.status ?? "");
    if (!live || Date.now() > deadline) return described;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

const stepNamed = (steps: readonly Step[], name: string): Step | undefined =>
  steps.find((s) => s.name === name || s.name.replace(/-\d+$/, "") === name);

/** `wrangler tail` on a Worker, into a file: every event it delivers names the version that ran it. */
function tail(worker: string): { file: string; stop: () => { versions: string[]; text: string } } {
  const file = join(mkdtempSync(join(tmpdir(), "keel-d22-tail-")), `${worker}.jsonl`);
  writeFileSync(file, "");
  const child = spawn("pnpm", ["exec", "wrangler", "tail", worker, "--format", "json"], {
    cwd: KEEL,
    stdio: ["ignore", "pipe", "pipe"],
    env: wranglerEnv,
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => {
    chunks.push(b);
    appendFileSync(file, b);
  });
  return {
    file,
    stop: () => {
      child.kill("SIGTERM");
      const text = Buffer.concat(chunks).toString("utf8");
      const versions = [...text.matchAll(/"scriptVersion":\s*\{\s*"id":\s*"([0-9a-f-]+)"/g)].map(
        (m) => m[1] ?? "",
      );
      return { versions, text };
    },
  };
}

const archiveBucket = (): string => {
  const named = process.env["KEEL_ARCHIVE_BUCKET"];
  if (named !== undefined) return named;
  const config = readFileSync(join(KEEL, "wrangler.jsonc"), "utf8");
  const found = /"binding":\s*"ARCHIVE",\s*"bucket_name":\s*"([^"]+)"/.exec(config)?.[1];
  if (found === undefined) throw new Error("wrangler.jsonc names no ARCHIVE bucket");
  return found;
};

const stepsOf = (e: EventRecord | undefined) => (e === undefined ? undefined : field(e, "steps"));

/** The role cache's effect, as B's code makes it: freshness is per-session on the permission check. */
const perSession = (effect: unknown): boolean => {
  const proposition = Object(Reflect.get(Object(effect), "proposition"));
  return (
    Reflect.get(proposition, "subject") === SUBJECT &&
    Reflect.get(proposition, "predicate") === "freshness" &&
    Reflect.get(proposition, "relation") === "is" &&
    Reflect.get(proposition, "value") === "per-session"
  );
};

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};

const open: string[] = [];
const tails = { keel: tail("keel"), verify: tail("keel-verify") };
let operator: KeelClient | undefined;
try {
  for (const worker of ["keel", "keel-verify"])
    console.log(
      `     ${worker} deployed: ${wrangler("deployments", "status", "--name", worker)
        .trim()
        .split("\n")
        .filter((l) => /version|Version|%/.test(l))
        .join(" | ")}`,
    );
  operator = operatorClient();
  const admin = operator;
  const project = await admin.createProject(
    { namespace: ORG, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: `live:${PROJECT}:project` },
  );
  console.log(`     project ${PROJECT}: ${project.id}`);
  await admin.putSettings(project.id, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
  });
  const enrol = async (name: string) => {
    const enrolled = await admin.enrolAgent(
      { name, kind: "interactive", scopes: ["agent:read", "agent:work"], projectId: project.id },
      { idempotencyKey: `live:${PROJECT}:${name}` },
    );
    return new KeelClient({
      baseUrl: KEEL_URL,
      clientId: enrolled.clientId,
      clientSecret: enrolled.clientSecret,
    });
  };
  const agentA = await enrol("d22-a");
  const agentB = await enrol("d22-b");
  // Trunk's head, from its history: the trunk view is not served yet.
  const base = (await agentA.commits(project.id, { limit: 1 })).items[0]?.sha;
  if (base === undefined) throw new Error("the project's trunk has no commit");
  console.log(`     trunk at ${base.slice(0, 12)}`);
  const feed = feedOf(agentA);
  const about = (changeId: string, tag: string) =>
    feed.seen.find((e) => tagOf(e) === tag && field(e, "changeId") === changeId);

  const patches = { a: scenarioPatch("a"), b: scenarioPatch("b") };

  /** Applies `write` in the change's workspace, pushes it and submits the commit. */
  const work = (
    agent: KeelClient,
    declared: Declared,
    name: string,
    write: (dir: string) => void,
  ): Promise<string> =>
    pushAndSubmit(
      agent,
      declared,
      {
        author: name,
        message: `probe ${run}: ${name}`,
        idempotencyKey: `d22:${run}:${name}:submit`,
      },
      write,
    );

  console.log("\n[conflict] A relies on freshness at most per-request; B declares per-session");
  const { a, b } = await declareS1(
    { a: agentA, b: agentB },
    base,
    (party) => `d22:${run}:${party}`,
    SETTLE_MS,
    (changeId) => open.push(changeId),
  );
  const [A, B] = [a.result.change.id, b.result.change.id];
  console.log(`     A ${A}; B ${B}`);
  console.log(
    `     B's preflight: ${b.result.preflight.contradictions.length} contradiction(s), suggested move ${brief(b.result.preflight.suggestedMove)}`,
  );

  const suspected = () =>
    feed.seen.find((e) => {
      const parties = field(e, "parties");
      return (
        tagOf(e) === "ConflictSuspected" &&
        Array.isArray(parties) &&
        parties.includes(A) &&
        parties.includes(B)
      );
    });
  await feed.until(() => suspected() !== undefined, SUSPECT_MS);
  const conflict = suspected();
  check(
    conflict !== undefined,
    `ConflictSuspected ${conflict?.eventId ?? "(none)"} names A and B on ${SUBJECT}`,
  );
  if (conflict === undefined) throw new Error("no conflict was suspected, so no Probe started");
  const conflictId = String(field(conflict, "conflictId"));
  console.log(`     conflict ${conflictId}: ${brief(conflict.payload, 700)}`);
  check(
    field(conflict, "subjectKey") === SUBJECT,
    "ConflictSuspected carries the subject key the Probe is started with",
  );
  const ofConflict = (tag: string) =>
    feed.seen.filter((e) => tagOf(e) === tag && field(e, "conflictId") === conflictId);

  const submittedAt = Date.now();
  await work(agentA, a, "d22-a", applyPatch(patches.a.file));
  await work(agentB, b, "d22-b", applyPatch(patches.b.file));

  const DECIDING = ["GuardAdmitted", "ProbeDiscarded", "ConflictEscalated", "ConflictDismissed"];
  const decided = await feed.until(
    () => DECIDING.some((tag) => ofConflict(tag).length > 0),
    DECIDE_MS,
  );
  console.log(
    `\n[probe] ${decided ? "decided" : "NOT decided"} ${Math.round((Date.now() - submittedAt) / 1000)} s after the submissions`,
  );
  const mine = feed.seen.filter(
    (e) => field(e, "conflictId") === conflictId || e.entity.id === conflictId,
  );
  for (const e of mine)
    console.log(
      `     ${e.eventId} ${e.entity.kind}#${e.seq} ${e.at} ${tagOf(e)} ${brief(e.payload, 260)}`,
    );

  const drafted = ofConflict("ProbeDrafted")[0];
  const admitted = ofConflict("GuardAdmitted")[0];
  const proven = ofConflict("ConflictProven")[0];
  const cells = ofConflict("ProbeRan");
  check(
    drafted !== undefined,
    `ProbeDrafted ${drafted?.eventId ?? "(none)"} after ${String(drafted === undefined ? "?" : field(drafted, "attempts"))} attempt(s)`,
  );
  const probeId = drafted === undefined ? undefined : field(drafted, "probeId");
  const bundleHash = drafted === undefined ? undefined : field(drafted, "bundleHash");
  console.log(`     probe ${String(probeId)}, bundle ${String(bundleHash)}`);

  console.log("     world    run 1  run 2  run 3   (S26)");
  let matching = 0;
  for (const world of WORLDS) {
    const row = [1, 2, 3].map((n) => {
      const cell = cells.find((e) => field(e, "world") === world && field(e, "run") === n);
      const outcome = cell === undefined ? "-" : String(field(cell, "outcome"));
      if (outcome === S26[world]) matching += 1;
      return outcome.padEnd(6);
    });
    console.log(`     ${world.padEnd(8)} ${row.join(" ")}  ${S26[world] ?? ""}`);
  }
  check(cells.length === 15, `the ledger recorded ${cells.length} of the 15 cells`);
  check(matching === 15, `${matching}/15 cells equal S26's matrix`);
  const order = [...cells, ...(admitted === undefined ? [] : [admitted])]
    .toSorted((x, y) => (x.eventId < y.eventId ? -1 : 1))
    .map((e) =>
      tagOf(e) === "ProbeRan"
        ? `${String(field(e, "world"))}@${String(field(e, "run"))}`
        : "ADMITTED",
    );
  console.log(`     in event order: ${order.join(" ")}`);
  check(
    admitted !== undefined && field(admitted, "probeId") === probeId,
    `GuardAdmitted ${admitted?.eventId ?? "(none)"}: guard ${String(admitted === undefined ? "?" : field(admitted, "guardId"))} after ${String(admitted === undefined ? "?" : field(admitted, "runs"))} runs`,
  );
  check(
    proven !== undefined && Reflect.get(Object(field(proven, "evidence")), "probeId") === probeId,
    `ConflictProven ${proven?.eventId ?? "(none)"} cites the probe`,
  );
  const guardId = admitted === undefined ? undefined : String(field(admitted, "guardId"));

  const probe = await ended("keel-probe", `probe-${conflictId}`, 3 * 60_000);
  if (probe !== undefined) {
    console.log(`     probe-${conflictId}: ${probe.status}`);
    console.log(
      `     steps: ${probe.steps.map((s) => `${s.name}${s.ms === undefined ? "" : ` ${s.ms}ms`}`).join(" → ")}`,
    );
    console.log(`     end: ${brief(probe.output, 600)}`);
    const guardStep = stepNamed(probe.steps, "guard");
    console.log(`     guard step: ${brief(guardStep?.output, 400)}`);
    check(
      probe.status === "complete" && Reflect.get(Object(probe.output), "outcome") === "admitted",
      "the Probe Workflow completed as admitted",
    );
    check(
      guardId !== undefined && Reflect.get(Object(probe.output), "guardId") === guardId,
      "the Probe's end names the admitted guard",
    );
    const guardCommit: unknown = Reflect.get(Object(probe.output), "guardCommit");
    check(
      typeof guardCommit === "string" && /^[0-9a-f]{40}$/.test(guardCommit),
      `the guard repo holds the guard at commit ${String(guardCommit)}`,
    );
  } else check(false, "the Probe Workflow's instance could be described");

  console.log("\n[world checks] the changes' suites in each world");
  await feed.until(() => ofConflict("WorldCheckRan").length >= 5, CHECKS_MS);
  const ran = ofConflict("WorldCheckRan");
  for (const e of ran)
    console.log(
      `     ${e.eventId} ${e.entity.kind}#${e.seq} ${e.at} ${String(field(e, "world"))} ${String(field(e, "check"))}: ${String(field(e, "outcome"))} ${brief(field(e, "counts"))} ${brief(field(e, "reason"))}`,
    );
  const expected = [
    ["trunk", "suite:trunk"],
    ["A", `suite:${A}`],
    ["B", `suite:${B}`],
    ["AB", `suite:${A}`],
    ["AB", `suite:${B}`],
  ] as const;
  for (const [world, name] of expected) {
    const cell = ran.find((e) => field(e, "world") === world && field(e, "check") === name);
    check(
      cell !== undefined && field(cell, "outcome") === "pass",
      `${world} ${name === "suite:trunk" ? name : name === `suite:${A}` ? "suite:A" : "suite:B"}: ${String(cell === undefined ? "not recorded" : field(cell, "outcome"))}`,
    );
  }
  const afterProof = ran.filter((e) => proven !== undefined && e.eventId > proven.eventId);
  check(
    proven !== undefined && afterProof.length > 0,
    `${afterProof.length} of ${ran.length} world checks were recorded after ConflictProven`,
  );
  for (const world of ["trunk", "A", "B", "AB"]) {
    const instance = describe("keel-world-check", `world-${conflictId}-${world}`);
    if (instance !== undefined)
      console.log(
        `     world-${conflictId}-${world}: ${instance.status}, steps ${instance.steps.map((s) => s.name).join(" → ")}`,
      );
  }

  console.log("\n[next change] a third change edits a file the tenet anchors");
  const c = await declareWhenPooled(
    agentA,
    {
      goal: `probe ${run}: a later edit to the permission check`,
      footprint: [{ path: ANCHORED, op: "edit" }],
      premises: [],
    },
    `d22:${run}:c`,
    SETTLE_MS,
  );
  const C = c.result.change.id;
  open.push(C);
  await work(agentA, c, "d22-c", (dir) => {
    appendFileSync(join(dir, ANCHORED), `// D2.2 live ${run}\n`);
  });
  await feed.until(
    () => about(C, "PlanCompiled") !== undefined || about(C, "ChangeBounced") !== undefined,
    SETTLE_MS,
  );
  const compiled = {
    a: about(A, "PlanCompiled"),
    b: about(B, "PlanCompiled"),
    c: about(C, "PlanCompiled"),
  };
  console.log(
    `     PlanCompiled steps: A ${String(stepsOf(compiled.a))}, B ${String(stepsOf(compiled.b))}, C ${String(stepsOf(compiled.c))}`,
  );
  const submittedC = about(C, "ChangeSubmitted");
  if (submittedC !== undefined) {
    const precheck = describe("keel-precheck", `precheck-${submittedC.eventId}`);
    if (precheck !== undefined) {
      console.log(
        `     precheck-${submittedC.eventId}: ${precheck.status}, steps ${precheck.steps.map((s) => s.name).join(" → ")}`,
      );
      console.log(`     guards step: ${brief(stepNamed(precheck.steps, "guards")?.output, 900)}`);
    }
  }
  check(
    typeof stepsOf(compiled.a) === "number" &&
      stepsOf(compiled.c) === Number(stepsOf(compiled.a)) + 1,
    "C's plan is one step longer than A's, which compiled before the guard was admitted",
  );
  const planHash = compiled.c === undefined ? undefined : field(compiled.c, "planHash");
  if (typeof planHash === "string" && guardId !== undefined) {
    let plan = "";
    try {
      plan = wrangler(
        "r2",
        "object",
        "get",
        // PlanStoreR2's key: the plans of the namespace the project is in, by id (KEEL_NAMESPACE_ID).
        `${archiveBucket()}/${namespaceKey(harnessNamespace(), "plans", planHash.slice("sha256:".length))}`,
        "--remote",
        "--pipe",
      );
    } catch (error) {
      console.log(
        `     the stored plan was not read: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
      );
    }
    const at = plan.indexOf(`guard:${guardId}`);
    console.log(`     stored plan ${planHash}: ${plan.length} bytes`);
    if (at >= 0) console.log(`     … ${plan.slice(Math.max(0, at - 40), at + 420)} …`);
    check(at >= 0, `the stored plan carries the step guard:${guardId}`);
    check(
      typeof bundleHash === "string" && plan.includes(bundleHash),
      "and pins it to the probe's bundle hash",
    );
  } else check(false, "C compiled a plan to read the guard step from");

  console.log("\n[derive] each Precheck derives its submission's effects from the code");
  /** The derivation record a Precheck kept, read from the archive by its hash. */
  const derivationOf = (ref: string): unknown => {
    try {
      return JSON.parse(
        wrangler(
          "r2",
          "object",
          "get",
          `${archiveBucket()}/${namespaceKey(harnessNamespace(), "evidence", ref.slice("sha256:".length))}`,
          "--remote",
          "--pipe",
        ),
      );
    } catch (error) {
      console.log(
        `     the derivation ${ref} was not read: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
      );
      return undefined;
    }
  };
  const derived: Record<"A" | "B" | "C", unknown[]> = { A: [], B: [], C: [] };
  for (const [name, changeId] of [
    ["A", A],
    ["B", B],
    ["C", C],
  ] as const) {
    const submitted = about(changeId, "ChangeSubmitted");
    const precheck =
      submitted === undefined
        ? undefined
        : describe("keel-precheck", `precheck-${submitted.eventId}`);
    const names = precheck?.steps.map((s) => s.name.replace(/-\d+$/, "")) ?? [];
    console.log(
      `     ${name} precheck-${submitted?.eventId ?? "?"}: ${precheck?.status ?? "?"}, steps ${names.join(" → ")}`,
    );
    const at = (step: string) => names.indexOf(step);
    check(
      at("guards") >= 0 &&
        at("derive") > at("guards") &&
        at("derived") === at("derive") + 1 &&
        at("decide") > at("derived"),
      `${name}'s Precheck ran derive and then derived, after guards and before decide`,
    );
    const derive = stepNamed(precheck?.steps ?? [], "derive");
    console.log(
      `     ${name} derive step (${derive?.ms ?? "?"} ms): ${brief(derive?.output, 500)}`,
    );
    const event = about(changeId, "EffectsDerived");
    const ref = event === undefined ? undefined : field(event, "derivationRef");
    // The step answers `{_tag: "Done", value: {derivationRef, subjects}}`.
    const kept = Reflect.get(Object(Reflect.get(Object(derive?.output), "value")), "derivationRef");
    check(
      typeof ref === "string" && kept === ref,
      `${name}: EffectsDerived ${event?.eventId ?? "(none)"} names the record its derive step kept, ${String(ref)}`,
    );
    const record = typeof ref === "string" ? derivationOf(ref) : undefined;
    const readings = Object(Reflect.get(Object(record), "readings"));
    const parsers = [
      Reflect.get(Object(Reflect.get(readings, "base")), "parser"),
      Reflect.get(Object(Reflect.get(readings, "head")), "parser"),
    ];
    console.log(
      `     ${name} record: kind ${String(Reflect.get(Object(record), "kind"))}, base ${String(Reflect.get(Object(record), "base")).slice(0, 12)}, head ${String(Reflect.get(Object(record), "head")).slice(0, 12)}, seeds ${brief(Reflect.get(Object(record), "seeds"), 400)}, readings ${brief(readings, 500)}, undecided ${brief(Reflect.get(Object(record), "undecided"), 300)}`,
    );
    check(
      Reflect.get(Object(record), "kind") === "keel.derivation/1" &&
        parsers.every((p) => typeof p === "string" && p.startsWith("keel-syntax/")),
      `${name}: the kept record holds a reading of its base and of its head, each stamped by the parser (${String(parsers[1])})`,
    );
    const effects = event === undefined ? undefined : field(event, "effects");
    if (Array.isArray(effects)) derived[name].push(...effects);
    console.log(`     ${name} derived ${derived[name].length} effect(s): ${brief(effects, 900)}`);
  }
  const cache = derived.B.filter(perSession);
  check(
    cache.length > 0,
    `B's commit derives freshness is per-session on ${SUBJECT}: the role cache, read from the code`,
  );
  check(
    cache.length > 0 && cache.every((e) => Reflect.get(Object(e), "declared") === true),
    "and the derivation marks it as an effect B declared",
  );
  // The arm that can fail: A adds a route and C a comment, and neither holds a cache.
  check(
    !derived.A.some(perSession) && !derived.C.some(perSession),
    "A's commit and C's derive no such effect: neither adds a cache",
  );

  await feed.until(
    () =>
      about(C, "ChangeBounced") !== undefined ||
      feed.seen.some((e) => {
        const landings = field(e, "landings");
        return (
          tagOf(e) === "TrunkAdvanced" &&
          Array.isArray(landings) &&
          landings.some((l: unknown) => Reflect.get(Object(l), "changeId") === C)
        );
      }),
    SETTLE_MS,
  );
  const formed = feed.seen.find((e) => {
    const members = field(e, "members");
    return tagOf(e) === "BatchFormed" && Array.isArray(members) && members.includes(C);
  });
  if (formed !== undefined) {
    const verify = describe("keel-verify-batch", `keel-verify-${formed.eventId}`);
    if (verify !== undefined) {
      console.log(
        `     keel-verify-${formed.eventId}: ${verify.status}, steps ${verify.steps.map((s) => s.name).join(" → ")}`,
      );
      for (const s of verify.steps.filter((x) => x.name.includes("guard")))
        console.log(`     ${s.name}: ${brief(s.output, 700)}`);
      console.log(`     verdict step: ${brief(stepNamed(verify.steps, "verdict")?.output, 700)}`);
    }
  }
  for (const e of feed.seen.filter(
    (x) =>
      ["GuardFailed", "VerdictIssued", "ChangeBounced", "TrunkAdvanced"].includes(tagOf(x)) &&
      x.eventId > (submittedC?.eventId ?? ""),
  ))
    console.log(`     ${e.eventId} ${tagOf(e)} ${brief(e.payload, 420)}`);
  for (const [name, id] of [
    ["A", A],
    ["B", B],
    ["C", C],
  ] as const)
    console.log(`     ${name} ${id} is ${(await admin.change(id)).state}`);
} catch (error) {
  failures += 1;
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.message}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // A landed change is done; anything else the run declared is withdrawn.
  for (const changeId of open) {
    try {
      const state = (await operator?.change(changeId))?.state;
      if (state === "landed" || state === "withdrawn" || state === "superseded") continue;
      await operator?.abandon(
        changeId,
        { reason: `probe check ${run} finished` },
        { idempotencyKey: `d22:${run}:abandon:${changeId}` },
      );
      console.log(`     abandoned ${changeId} (was ${String(state)})`);
    } catch (error) {
      console.log(
        `FAIL abandon ${changeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failures += 1;
    }
  }
  for (const [worker, tailed] of Object.entries(tails)) {
    const { versions, text } = tailed.stop();
    const counts = Object.entries(
      versions.reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {}),
    );
    const internal = text.match(/internal error/g)?.length ?? 0;
    console.log(`     ${worker} tail (${tailed.file}): ${JSON.stringify(counts)}`);
    console.log(`     ${worker} tail: ${internal} "internal error" line(s)`);
    check(versions.length > 0, `${worker}'s tail delivered events during the run`);
  }
}
console.log(failures === 0 ? "\nall D2.2 live checks hold" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
