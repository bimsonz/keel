// S-2's live proof against a deployed Keel: memory stops a regression later.
// A person's ruling on S-1's proven conflict is kept as a decision, and the
// Probe's proof as a guard that holds it; a later change that undoes the fix
// the ruling asked for is bounced by that guard, citing the decision, while
// the same change in a fork of the same code, which holds no decision, lands.
//
//   KEEL_URL=<keel> CLOUDFLARE_ACCOUNT_ID=<account> node e2e/src/s2.ts <run> [--public]
//
// It takes no Keel credential. A person, `s2-<run>-p`, signs up by passkey and
// works in their own namespace: they create the project `s2` (from the fixture
// template), enrol its agents and so sponsor them, which makes them the person
// an escalation asks. First the fixture's deps bundle goes under that
// namespace (with the operator's wrangler on CLOUDFLARE_ACCOUNT_ID): a deps
// bundle is one namespace's, and the Probe's runner is unavailable for a world
// with none, so without it nothing is proven and no guard is admitted.
//   (1) S-1 to its ruling, as t35 runs it: changes that each add one file hold
//       the lane; A, relying on permission evaluation being fresh at most
//       per-request, and B, declaring it per-session, are declared and
//       submitted behind them; Keel suspects the conflict, the Probe proves it
//       (ConflictProven) and keeps its probe as a guard (GuardAdmitted, G-1);
//       B escalates under its own lease; the person rules that the premise
//       holds: DecisionRecorded (D-1), ConflictResolved carrying D-1 against B,
//       B bounced by D-1, and A resumed;
//   (2) A lands. B revises its intent as its bounce says, withdrawing the
//       per-session effect, rebases onto trunk (which now has A), merges
//       keel/trunk, applies b-revised.patch (the cache evicts a revoked
//       collaborator), pushes and submits: B′ lands;
//   (3) a third agent declares "Simplify the permissions code" on trunk
//       (A + B′) and submits careless.patch, which drops the eviction and keeps
//       the suite green: it bounces on a verdict whose reasons name G-1 failing
//       and the decision it holds, D-1, and whose next actions read D-1; that
//       agent reads D-1: premise-holds, active, held by G-1, about S-1's
//       conflict;
//   (4) the negative control: the person forks the project (`s2-control`: its
//       trunk only, the code with A and B′, and no guard or decision), with the
//       same settings, enrols one agent there and submits the same careless
//       patch: it lands, its verdict's suite passing and no guard run.
// When the Probe proves nothing (Keel escalates the conflict as unprovable,
// or dismisses it) there is no guard to remember a ruling by: the run says so
// and exits 3.
//
// Each run needs a run of its own, since a handle is taken for good. It leaves
// behind the person's account, its two projects and their enrolled agents.
// Every change the run leaves open is abandoned at the end, except a parked
// one, which awaits the person's ruling. No session, passkey, credential or
// remote URL is printed.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "@keeltown/sdk";
import { AccountRefused, signUp } from "../../scripts/lib/account.ts";
import { cloneWorkspace, commitAndPush, git } from "./lib/git.ts";
import {
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
  tagOf,
} from "./lib/s1.ts";

const [run, ...flags] = process.argv.slice(2);
/**
 * With `--public` the person makes both projects public at the end, a visitor
 * reads D-1 and both feeds, and the person makes them private again, which a
 * visitor then reads as absent: no test project stays public.
 */
const PUBLIC = flags.includes("--public");
if (run === undefined || !/^[a-z0-9]{1,12}$/.test(run))
  throw new Error("usage: s2.ts <run>, the run up to twelve lower-case letters and digits");
const keelUrl = process.env.KEEL_URL ?? "";
if (keelUrl === "") throw new Error("KEEL_URL is not set: the Keel to check");
if ((process.env.CLOUDFLARE_ACCOUNT_ID ?? "") === "")
  throw new Error("CLOUDFLARE_ACCOUNT_ID is not set: the deps bundle's upload needs it");
const ROOT = join(import.meta.dirname, "../..");
const SCENARIOS = join(ROOT, "fixtures/forge-lite/scenarios");
/** B′: the cache evicts a revoked collaborator. It applies on base + A + B. */
const B_REVISED = join(SCENARIOS, "s1/b-revised.patch");
/** "Simplify the permissions code": drops the eviction. It applies on base + A + B + B′. */
const CARELESS = join(SCENARIOS, "s2/careless.patch");
const PERSON = `s2-${run}-p`;
const PROJECT = "s2";
const CONTROL = `${PROJECT}-control`;
const CARELESS_GOAL = "Simplify the permissions code";
const key = (what: string) => `s2:${run}:${what}`;
const SETTLE_MS = 10 * 60_000;
/** How long the changes ahead of the parties should keep the lane busy: longer than a proof has taken. */
const HOLD_MS = 7 * 60_000;
/** The fewest changes queued ahead of the parties: ten held them queued four minutes. */
const AHEAD = 25;
/** The Probe's budget from the parties' submissions to its verdict. */
const PROOF_MS = 10 * 60_000;
const STEP_MS = 2 * 60_000;

let failures = 0;
/** Whether the Probe proved nothing, so no guard was admitted and S-2 cannot be shown. */
let unproven = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};
/** How a call was refused, as `status code`; a call that answered is not a refusal. */
async function refusalOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "answered";
  } catch (error) {
    if (error instanceof KeelProblem) return `${error.status} ${error.code}`;
    throw error;
  }
}
/** A call Keel may answer 503 while a workspace is busy: asked again, at most five times. */
async function unlessBusy<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof KeelProblem) || error.status !== 503 || attempt === 5) throw error;
      console.log(`     ${error.code}; asking again in ${error.retryAfterMs ?? 3_000} ms`);
      await new Promise((r) => setTimeout(r, error.retryAfterMs ?? 3_000));
    }
  }
}

const seconds = (from: number) => Math.round((Date.now() - from) / 1000);
/** When an event was committed, by its own object's clock; NaN for one that is not there, which no comparison holds for. */
const when = (e: EventRecord | undefined) => (e === undefined ? Number.NaN : Date.parse(e.at));
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const prop = (value: unknown, name: string): unknown => Reflect.get(Object(value), name);
/** A string a payload holds, or the empty string. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The footprint a patch edits, as `scenarioPatch` reads one. */
const footprintOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/^diff --git a\/(\S+) b\/\S+\n(new file mode)?/gm)].map(
    (m) => ({
      path: m[1] ?? "",
      op: m[2] === undefined ? ("edit" as const) : ("create" as const),
    }),
  );

/** Whether `patch` applies to the clone in `dir` as it stands. */
const applies = (dir: string, patch: string): boolean => {
  try {
    git(dir, ["apply", "--check", patch]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Applies `patch` in the change's workspace, pushes it as `author` and submits
 * it under the change's lease. A workspace the pool granted before trunk last
 * moved holds an older trunk, where the patch does not apply: the change is
 * then first rebased onto trunk and its clone fast-forwarded there, as the
 * first change is.
 */
async function submitOnTrunk(
  agent: KeelClient,
  declared: Declared,
  author: string,
  patch: string,
  what: string,
): Promise<string> {
  const { change, workspace, lease } = declared.result;
  if (workspace.token === undefined) throw new Error("declare answered no workspace token");
  const token = workspace.token;
  const dir = cloneWorkspace(workspace.remote, token);
  let sha: string;
  try {
    if (!applies(dir, patch)) {
      const { result } = await unlessBusy(() =>
        agent.rebase(change.id, { lease: lease.id, idempotencyKey: key(`${what}:rebase`) }),
      );
      git(dir, ["fetch", "-q", "origin", "keel/trunk"], token);
      git(dir, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
      console.log(
        `     ${author}'s workspace was behind trunk: rebased onto ${result.base.slice(0, 12)}`,
      );
    }
    applyPatch(patch)(dir);
    sha = commitAndPush(dir, token, author, `S-2 live ${run}: ${what}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await agent.submit(
    { changeId: change.id, commitSha: sha },
    { lease: lease.id, idempotencyKey: key(`${what}:submit`) },
  );
  console.log(`     ${author}: change ${change.id} submitted at ${sha.slice(0, 12)}`);
  return sha;
}

/**
 * Whether a project's trunk, as its repo read answers, holds A's revoke route
 * and B′'s eviction: read again for up to `ms`, since that read can lag a landing.
 */
async function holdsTheFix(reader: KeelClient, projectId: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  const read = async (path: string) =>
    text(prop(await reader.blob(projectId, path).catch(() => undefined), "content"));
  for (;;) {
    const held =
      (await read("src/routes/collaborators.ts")).includes("removeCollaborator") &&
      (await read("src/authz/cache.ts")).includes("evict(");
    if (held || Date.now() > deadline) return held;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

/** The person's client, once they have signed up: who withdraws what the run leaves open. */
const signedUp: { person?: KeelClient } = {};
const open: string[] = [];

async function walk(): Promise<void> {
  const account = await signUp(keelUrl, PERSON);
  const me = new KeelClient({ baseUrl: keelUrl, session: account.session.token });
  signedUp.person = me;
  const handle = account.session.namespace;
  const namespace = await me.namespace(handle);
  console.log(
    `     ${PERSON} signed up by passkey: ${account.session.userId}; namespace ${namespace.handle} is ${namespace.id}`,
  );

  console.log(
    "\n[deps] the fixture's deps bundle goes under the person's namespace, where the Probe's runner looks",
  );
  const uploaded = execFileSync(
    "node",
    [
      join(ROOT, "apps/keel-verify/test/live/deps-bundle.ts"),
      join(ROOT, "fixtures/forge-lite"),
      "--upload",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, KEEL_NAMESPACE_ID: namespace.id },
    },
  );
  console.log(`     put: ${uploaded.trim().split("\n").at(-1)?.slice(0, 160) ?? ""}`);

  const configure = (projectId: string) =>
    me.putSettings(projectId, { protectedPaths: [], maxBatchSize: 1, verification: "required" });
  const project = await me.createProject(
    { namespace: handle, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  await configure(project.id);
  console.log(`     project ${handle}/${PROJECT}: ${project.id} (${project.visibility})`);
  const enrol = async (name: string, projectId: string) => {
    const enrolled = await me.enrolAgent(
      { name, kind: "interactive", scopes: ["agent:read", "agent:work"], projectId },
      { idempotencyKey: key(`agent:${name}`) },
    );
    console.log(`     agent ${name}: ${enrolled.agent.id}`);
    return new KeelClient({
      baseUrl: keelUrl,
      clientId: enrolled.clientId,
      clientSecret: enrolled.clientSecret,
    });
  };
  const agentA = await enrol("s2-a", project.id);
  const agentB = await enrol("s2-b", project.id);
  const holder = await enrol("s2-hold", project.id);
  const carelessAgent = await enrol("s2-careless", project.id);
  const base = (await agentA.commits(project.id, { limit: 1 })).items[0]?.sha;
  if (base === undefined) throw new Error("the project's trunk has no commit");
  const { cursor } = await me.snapshot({ project: project.id });
  console.log(`     trunk at ${base.slice(0, 12)}; feed cursor ${cursor}`);
  // The person's own read of the project: its owner's, so it holds the members-only events too.
  const feed = feedOf(me, { project: project.id, cursor });
  const of = (tag: string, id: string) =>
    feed.seen.filter(
      (e) =>
        tagOf(e) === tag &&
        (e.entity.id === id ||
          ["changeId", "conflictId", "escalationId", "decisionId"].some((k) => field(e, k) === id)),
    );
  const stateOf = async (id: string) => (await me.change(id)).state;

  console.log("\n[a] changes ahead of the parties hold the lane");
  const hold = async (n: number): Promise<Declared> => {
    const path = `notes/hold-${run}-${n}.md`;
    const declared = await declareWhenPooled(
      holder,
      { goal: `Hold the lane (${n})`, footprint: [{ path, op: "create" }], premises: [] },
      key(`hold:${n}`),
      SETTLE_MS,
    );
    open.push(declared.result.change.id);
    await pushAndSubmit(
      holder,
      declared,
      {
        author: "s2-hold",
        message: `S-2 live ${run}: hold ${n}`,
        idempotencyKey: key(`hold:${n}:submit`),
      },
      (dir) => {
        mkdirSync(join(dir, "notes"), { recursive: true });
        writeFileSync(join(dir, path), `Holds the lane in S-2 live run ${run}.\n`);
      },
    );
    return declared;
  };
  const timedAt = Date.now();
  const timed = (await hold(1)).result.change.id;
  const moved = await feed.until(
    () => of("ChangeLanded", timed).length + of("ChangeBounced", timed).length > 0,
    SETTLE_MS,
  );
  const landMs = Date.now() - timedAt;
  check(
    moved && of("ChangeLanded", timed).length === 1,
    `the first of them landed, ${seconds(timedAt)} s after its push began`,
  );
  const ahead = Math.min(30, Math.max(AHEAD, Math.ceil(HOLD_MS / landMs)));
  console.log(
    `     ${ahead} more go ahead of the parties, to hold the lane ${HOLD_MS / 1000} s or longer`,
  );
  const held: string[] = [];
  for (let n = 2; n < 2 + ahead; n++) held.push((await hold(n)).result.change.id);
  const queued = await feed.until(
    () => held.every((id) => of("ChangeQueued", id).length > 0),
    SETTLE_MS,
  );
  check(queued, `all ${held.length} are queued before either party is submitted`);

  console.log("\n[b] A relies on freshness at most per-request; B declares per-session");
  const { a, b } = await declareS1(
    { a: agentA, b: agentB },
    base,
    (party) => key(party),
    SETTLE_MS,
    (changeId) => open.push(changeId),
  );
  const [A, B] = [a.result.change.id, b.result.change.id];
  console.log(`     A ${A}; B ${B}`);
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
  await feed.until(() => suspected() !== undefined, STEP_MS);
  const conflict = suspected();
  check(conflict !== undefined, `ConflictSuspected ${conflict?.eventId ?? "(none)"} names A and B`);
  if (conflict === undefined) throw new Error("no conflict was suspected, so no Probe started");
  const conflictId = String(field(conflict, "conflictId"));
  console.log(`     conflict ${conflict.label ?? ""} ${conflictId}`);

  const submittedAt = Date.now();
  const patches = { a: scenarioPatch("a"), b: scenarioPatch("b") };
  await pushAndSubmit(
    agentA,
    a,
    { author: "s2-a", message: `S-2 live ${run}: A`, idempotencyKey: key("a:submit") },
    applyPatch(patches.a.file),
  );
  await pushAndSubmit(
    agentB,
    b,
    { author: "s2-b", message: `S-2 live ${run}: B`, idempotencyKey: key("b:submit") },
    applyPatch(patches.b.file),
  );
  // What ends the Probe's part: a proof, or the conflict escalated or dismissed without one.
  const ENDS = ["ConflictProven", "ConflictEscalated", "ConflictDismissed"];
  const VERDICTS = [...ENDS, "ProbeDiscarded"];
  await feed.until(() => VERDICTS.some((tag) => of(tag, conflictId).length > 0), PROOF_MS);
  // A discarded probe is not the end: Keel then escalates the conflict itself, a moment later.
  await feed.until(() => ENDS.some((tag) => of(tag, conflictId).length > 0), STEP_MS);
  const proven = of("ConflictProven", conflictId)[0];
  console.log(
    `     ${held.filter((id) => of("ChangeLanded", id).length > 0).length} of ${held.length} ahead of the parties have landed at the Probe's end`,
  );
  if (proven === undefined) {
    for (const tag of VERDICTS)
      for (const e of of(tag, conflictId)) console.log(`     ${e.at} ${tag} ${brief(e.payload)}`);
    const own = of("ConflictEscalated", conflictId)[0];
    const dismissed = of("ConflictDismissed", conflictId)[0];
    if (dismissed === undefined && (own === undefined || field(own, "reason") !== "unprovable"))
      throw new Error("the conflict was neither proven, nor escalated by Keel, nor dismissed");
    unproven = true;
    console.log(
      `\n     NOT PROVEN, ${seconds(submittedAt)} s after the parties' submissions: Keel ${dismissed === undefined ? "escalated the conflict as unprovable" : "dismissed the conflict"}, so no guard was admitted and there is nothing for memory to stop a regression with`,
    );
    return;
  }
  check(
    true,
    `ConflictProven ${proven.eventId}, ${seconds(submittedAt)} s after the parties' submissions`,
  );

  // The escalate goes at once: every second here is one in which a party may leave the queue.
  console.log("\n[c] B escalates the proven conflict");
  const escalating = { move: "escalate" as const, changeId: B };
  check(
    (await refusalOf(() =>
      agentB.resolve(conflictId, escalating, {
        lease: a.result.lease.id,
        idempotencyKey: key("escalate:wrong-lease"),
      }),
    )) === "409 change.lease_stale",
    "an escalate under another change's lease is refused: 409 change.lease_stale",
  );
  const escalated = await agentB.resolve(
    conflictId,
    {
      ...escalating,
      note: "The cache keeps a revoked collaborator's role for the session. Which should give way?",
    },
    { lease: b.result.lease.id, idempotencyKey: key("escalate") },
  );
  check(
    escalated.result.conflict.state === "escalated",
    `the escalate answers the conflict as ${escalated.result.conflict.state}`,
  );
  await feed.until(() => of("ConflictEscalated", conflictId).length > 0, STEP_MS);
  const said = of("ConflictEscalated", conflictId)[0];
  const escalationId = String(said === undefined ? "" : field(said, "escalationId"));
  check(
    said !== undefined && field(said, "reason") === "human-class",
    `ConflictEscalated ${said?.eventId ?? "(none)"} says human-class and names ${escalationId}`,
  );
  await feed.until(
    () =>
      of("EscalationRaised", escalationId).length > 0 &&
      [A, B].some((id) => of("ChangeParked", id).length > 0),
    STEP_MS,
  );
  // One more read, so a second party's park a moment after the first is on the page.
  await feed.until(() => [A, B].every((id) => of("ChangeParked", id).length > 0), 20_000);
  const raised = of("EscalationRaised", escalationId)[0];
  check(
    raised !== undefined,
    `EscalationRaised ${raised?.eventId ?? "(none)"} is in the person's feed`,
  );
  const parked = [A, B].filter((id) => of("ChangeParked", id).length > 0);
  for (const id of parked) {
    const event = of("ChangeParked", id)[0];
    check(
      event !== undefined &&
        field(event, "reason") === "awaiting-ruling" &&
        field(event, "escalationId") === escalationId,
      `${id === A ? "A" : "B"} parked awaiting the ruling on ${escalationId}`,
    );
  }
  check(parked.length > 0, `${parked.length} of the two parties parked`);
  for (const id of parked) {
    const state = await stateOf(id);
    check(
      state === "parked",
      `${id === A ? "A" : "B"} reads as ${state} while the question is open`,
    );
  }

  console.log("\n[d] the person asked first rules that the premise holds");
  const asked = (await me.escalations({ state: "open" })).items.find(
    (item) => item.id === escalationId,
  );
  check(asked !== undefined, "the escalation is among the person's open ones");
  if (asked !== undefined) {
    console.log(`     ${asked.label} in ${asked.project.name}: ${asked.question}`);
    for (const option of asked.options)
      console.log(
        `       ${option.id}${option.id === asked.default ? " (the default)" : ""}: ${option.label}`,
      );
  }
  check(
    (await refusalOf(() =>
      me.giveRuling(escalationId, { option: "neither" }, { idempotencyKey: key("ruling:unknown") }),
    )) === "400 escalation.option_unknown",
    "a ruling for an option the question does not offer is refused: 400 escalation.option_unknown",
  );
  const ruling = await me.giveRuling(
    escalationId,
    {
      option: "premise-holds",
      rationale: "A revocation takes effect at once: a cache may stay only if a revoke evicts it.",
    },
    { idempotencyKey: key("ruling") },
  );
  check(ruling.state === "ruled", `the ruling answers the escalation as ${ruling.state}`);
  // The premise holds, so the ruling goes against B, which makes the effect: B bounces and A resumes.
  const movedBy = (id: string) => of(id === B ? "ChangeBounced" : "ChangeResumed", id);
  await feed.until(
    () =>
      of("ConflictResolved", conflictId).length > 0 && parked.every((id) => movedBy(id).length > 0),
    STEP_MS,
  );
  const given = of("RulingGiven", escalationId)[0];
  const resolved = of("ConflictResolved", conflictId)[0];
  const decisionId = String(resolved === undefined ? "" : field(resolved, "decisionId"));
  const recorded = of("DecisionRecorded", decisionId)[0];
  const D1 = recorded?.label ?? "D-?";
  check(given !== undefined, `RulingGiven ${given?.eventId ?? "(none)"} is in the person's feed`);
  check(
    recorded !== undefined && resolved !== undefined,
    `DecisionRecorded ${recorded?.eventId ?? "(none)"} (${D1}); ConflictResolved ${resolved?.eventId ?? "(none)"} carries ${decisionId}`,
  );
  const against = resolved === undefined ? undefined : field(resolved, "against");
  check(
    Array.isArray(against) && against.length === 1 && against[0] === B,
    `the resolution names who the ruling goes against: ${JSON.stringify(against)} (B is ${B})`,
  );
  check(parked.includes(B), "B was parked for the ruling, so the ruling can bounce it");
  const consequence = asked?.options.find((option) => option.id === "premise-holds")?.consequence;
  for (const id of parked) {
    const event = movedBy(id)[0];
    const state = await stateOf(id);
    if (id !== B) {
      check(
        event !== undefined && field(event, "decisionId") === decisionId,
        `A resumed on ${decisionId}, and is ${state}`,
      );
      continue;
    }
    const reasons = event === undefined ? undefined : field(event, "reasons");
    const next = event === undefined ? undefined : field(event, "nextActions");
    check(
      event !== undefined && field(event, "decisionId") === decisionId && state === "bounced",
      `B was bounced by ${decisionId}, and is ${state}`,
    );
    check(
      consequence !== undefined && Array.isArray(reasons) && reasons[0] === consequence,
      `its reason is the chosen option's consequence: ${JSON.stringify(reasons)}`,
    );
    check(
      Array.isArray(next) &&
        next.map((action) => prop(action, "operationId")).join() === "revise,abandon",
      "its ways on are to revise its intent or to withdraw",
    );
    check(
      of("ChangeResumed", B).length === 0 && of("ChangeLanded", B).length === 0,
      "B neither resumed nor landed",
    );
  }
  // Each object commits on its own clock and the feed is in the order the events reached it,
  // so the order is read from the commit times, a step never before the one that caused it.
  const parks = parked.map((id) => when(of("ChangeParked", id)[0]));
  const resumes = parked.map((id) => when(movedBy(id)[0]));
  check(
    when(proven) <= when(said) &&
      parks.every((at) => at >= when(said) && at < when(given)) &&
      when(given) <= when(resolved) &&
      resumes.every((at) => at >= when(resolved)),
    "by their commit times: proven, escalated, parked, ruled, resolved, bounced or resumed",
  );
  check(
    (await refusalOf(() =>
      me.giveRuling(
        escalationId,
        { option: "effect-stands" },
        { idempotencyKey: key("ruling:again") },
      ),
    )) === "409 escalation.state_refused",
    "a second ruling is refused: 409 escalation.state_refused",
  );
  const visitor = await fetch(`${keelUrl}/v1/events?project=${project.id}`);
  const visitorBody: unknown = await visitor.json().catch(() => ({}));
  check(
    visitor.status !== 200,
    `a visitor reads nothing of the private project's feed: ${visitor.status} ${String(prop(visitorBody, "code"))}`,
  );
  // The proof's probe, kept as the guard that holds the decision: committed with the proof.
  await feed.until(() => of("GuardAdmitted", conflictId).length > 0, STEP_MS);
  const admitted = of("GuardAdmitted", conflictId)[0];
  const guardId = String(admitted === undefined ? "" : field(admitted, "guardId"));
  const G1 = admitted?.label ?? "G-?";
  check(
    admitted !== undefined && guardId.length > 0,
    `GuardAdmitted ${admitted?.eventId ?? "(none)"}: the proof's probe is kept as guard ${G1} ${guardId}, after ${String(admitted === undefined ? 0 : field(admitted, "runs"))} runs`,
  );

  console.log("\n[e] B revises as its bounce says, rebases onto trunk with A, and B′ lands");
  // B's lease may have lapsed while Keel held B; then B adopts its own change again, for a new lease.
  let leaseB = b.result.lease.id;
  let workspaceB = b.result.workspace;
  const adoptB = async () => {
    const adopted = await agentB.adopt(B, { idempotencyKey: key("b:adopt") });
    leaseB = adopted.result.lease.id;
    workspaceB = adopted.result.workspace ?? workspaceB;
    console.log(
      `     B's lease lapsed while Keel held it: B adopts its change again, and it is ${adopted.result.change.state}`,
    );
  };
  const underLease = async <T>(call: (lease: string) => Promise<T>): Promise<T> => {
    try {
      return await call(leaseB);
    } catch (error) {
      if (
        !(error instanceof KeelProblem) ||
        !error.nextActions.some((next) => next.operationId === "adopt")
      )
        throw error;
      await adoptB();
      return call(leaseB);
    }
  };
  if ((await stateOf(B)) === "parked") await adoptB();
  // Revised at once, as the bounce says: the revise renews B's lease before the wait for A.
  const read = await agentB.change(B);
  const revised = await underLease((lease) =>
    agentB.revise(
      B,
      {
        goal: "Speed up permission checks with a per-session role cache that a revoke evicts",
        declaredEffects: [],
      },
      { lease, ifMatch: read.revision, idempotencyKey: key("b:revise") },
    ),
  );
  check(
    revised.result.change.revision === read.revision + 1 &&
      (revised.result.change.declaredEffects ?? []).length === 0,
    `B revises its intent to revision ${revised.result.change.revision}, the per-session effect withdrawn: "${revised.result.change.goal}"`,
  );
  await feed.until(
    () => of("ChangeLanded", A).length + of("ChangeBounced", A).length > 0,
    SETTLE_MS,
  );
  const landedA = of("ChangeLanded", A)[0];
  check(
    landedA !== undefined,
    `A, resumed, lands: ${landedA === undefined ? `it is ${await stateOf(A)}` : `ChangeLanded ${landedA.eventId}, trunk at ${String(field(landedA, "trunkSha")).slice(0, 12)}`}`,
  );
  if (landedA === undefined)
    throw new Error("A did not land, so trunk holds no A for B′ to build on");
  const rebased = await underLease((lease) =>
    unlessBusy(() => agentB.rebase(B, { lease, idempotencyKey: key("b:rebase") })),
  );
  console.log(`     B rebased: ${rebased.result.ref} at ${rebased.result.base.slice(0, 12)}`);
  if (workspaceB.token === undefined) throw new Error("B holds no workspace token");
  const tokenB = workspaceB.token;
  const dirB = cloneWorkspace(workspaceB.remote, tokenB);
  let revisedSha: string;
  try {
    git(dirB, ["fetch", "-q", "origin", "keel/trunk"], tokenB);
    check(
      git(dirB, ["rev-parse", "FETCH_HEAD"]) === rebased.result.base,
      "keel/trunk in B's workspace is trunk's head",
    );
    git(dirB, [
      "-c",
      "user.name=s2-b",
      "-c",
      "user.email=s2-b@agents.keel.invalid",
      "merge",
      "-q",
      "--no-edit",
      "FETCH_HEAD",
    ]);
    check(applies(dirB, B_REVISED), "b-revised.patch applies on B merged with trunk: base + A + B");
    applyPatch(B_REVISED)(dirB);
    revisedSha = commitAndPush(dirB, tokenB, "s2-b", `S-2 live ${run}: B revised`);
  } finally {
    rmSync(dirB, { recursive: true, force: true });
  }
  const bouncesB = of("ChangeBounced", B).length;
  await underLease((lease) =>
    agentB.submit(
      { changeId: B, commitSha: revisedSha },
      { lease, idempotencyKey: key("b2:submit") },
    ),
  );
  console.log(`     s2-b: B′ submitted at ${revisedSha.slice(0, 12)}`);
  await feed.until(
    () => of("ChangeLanded", B).length > 0 || of("ChangeBounced", B).length > bouncesB,
    SETTLE_MS,
  );
  for (const e of of("ChangeBounced", B).slice(bouncesB))
    console.log(`     B′ bounced: ${brief(field(e, "reasons"), 600)}`);
  const landedB = of("ChangeLanded", B)[0];
  check(
    landedB !== undefined,
    `B′ lands: ${landedB === undefined ? `B is ${await stateOf(B)}` : `ChangeLanded ${landedB.eventId} for B, trunk at ${String(field(landedB, "trunkSha")).slice(0, 12)}`}`,
  );
  if (landedB === undefined)
    throw new Error("B′ did not land, so trunk holds no fix for a careless change to undo");
  const fixed = await holdsTheFix(me, project.id, STEP_MS);
  check(fixed, "trunk holds A's revoke route and B′'s eviction");

  console.log(`\n[f] a careless change, "${CARELESS_GOAL}", on trunk (A + B′)`);
  const careless = await declareWhenPooled(
    carelessAgent,
    { goal: CARELESS_GOAL, footprint: footprintOf(CARELESS), premises: [] },
    key("careless"),
    SETTLE_MS,
  );
  const C = careless.result.change.id;
  open.push(C);
  await submitOnTrunk(carelessAgent, careless, "s2-careless", CARELESS, "careless");
  await feed.until(
    () => of("ChangeLanded", C).length + of("ChangeBounced", C).length > 0,
    SETTLE_MS,
  );
  const bounced = of("ChangeBounced", C)[0];
  const reasons = strings(bounced === undefined ? undefined : field(bounced, "reasons"));
  const actions = bounced === undefined ? undefined : field(bounced, "nextActions");
  const ways: unknown[] = Array.isArray(actions) ? actions : [];
  for (const reason of reasons) console.log(`     reason: ${reason}`);
  for (const action of ways)
    console.log(`     next: ${text(prop(action, "operationId"))} "${text(prop(action, "title"))}"`);
  check(
    bounced !== undefined && of("ChangeLanded", C).length === 0,
    `the careless change bounces and does not land: ${bounced === undefined ? `it is ${await stateOf(C)}` : `ChangeBounced ${bounced.eventId}`}`,
  );
  const verdictId = bounced === undefined ? undefined : field(bounced, "verdictId");
  check(
    typeof verdictId === "string",
    `its bounce names the verdict that failed it: ${String(verdictId)}`,
  );
  const cited = reasons.find(
    (reason) =>
      reason.startsWith(`guard failed: guard:${guardId}`) &&
      reason.includes(`it holds decision ${decisionId}`),
  );
  check(
    guardId.length > 0 && decisionId.length > 0 && cited !== undefined,
    `a reason names guard ${G1} failing, holding decision ${D1}: ${cited ?? "(none)"}`,
  );
  check(
    ways.some(
      (action) =>
        prop(action, "operationId") === "Memory_getDecision" &&
        prop(prop(action, "args"), "decisionId") === decisionId,
    ),
    `a next action reads the decision: Memory_getDecision with decisionId ${decisionId}`,
  );
  const remembered = await carelessAgent.decision(decisionId);
  console.log(
    `     ${decisionId}: ${remembered.option} "${remembered.summary}", ${remembered.state}, guards [${remembered.guards.join(", ")}], conflict ${remembered.conflictId ?? "(none)"}`,
  );
  check(
    remembered.option === "premise-holds" &&
      remembered.state === "active" &&
      remembered.guards.includes(guardId) &&
      remembered.conflictId === conflictId,
    `the careless agent reads ${D1}: premise-holds, active, held by ${G1}, about S-1's conflict`,
  );

  console.log(`\n[g] without Keel's memory: ${CONTROL}, a fork of the project's trunk`);
  const control = await me.createProject(
    { namespace: handle, name: CONTROL, source: { kind: "fork", project: project.id } },
    { idempotencyKey: key("control") },
  );
  await configure(control.id);
  console.log(
    `     project ${handle}/${CONTROL}: ${control.id} (${control.visibility}), forked from ${control.forkedFrom?.id ?? "(none named)"}`,
  );
  check(control.forkedFrom?.id === project.id, "the fork names the project it was forked from");
  check(
    await holdsTheFix(me, control.id, STEP_MS),
    "the fork's trunk holds A's revoke route and B′'s eviction",
  );
  const controlAgent = await enrol("s2-control", control.id);
  const { cursor: controlCursor } = await me.snapshot({ project: control.id });
  const controlFeed = feedOf(me, { project: control.id, cursor: controlCursor });
  const inControl = (tag: string, id: string) =>
    controlFeed.seen.filter(
      (e) => tagOf(e) === tag && (e.entity.id === id || field(e, "changeId") === id),
    );
  const twin = await declareWhenPooled(
    controlAgent,
    { goal: CARELESS_GOAL, footprint: footprintOf(CARELESS), premises: [] },
    key("control:careless"),
    SETTLE_MS,
  );
  const T = twin.result.change.id;
  open.push(T);
  await submitOnTrunk(controlAgent, twin, "s2-control", CARELESS, "control-careless");
  await controlFeed.until(
    () => inControl("ChangeLanded", T).length + inControl("ChangeBounced", T).length > 0,
    SETTLE_MS,
  );
  for (const e of inControl("ChangeBounced", T))
    console.log(`     bounced: ${brief(field(e, "reasons"), 600)}`);
  check(inControl("ChangeLanded", T).length === 1, "without Keel's memory the regression lands");
  const batches = new Set(inControl("ChangeBatched", T).map((e) => String(field(e, "batchId"))));
  const verdict = controlFeed.seen.findLast(
    (e) =>
      tagOf(e) === "VerdictIssued" &&
      (batches.has(text(field(e, "subject"))) || field(e, "subject") === T),
  );
  const evidence = strings(verdict === undefined ? undefined : field(verdict, "evidence"));
  for (const line of evidence) console.log(`     evidence: ${line}`);
  const suite = evidence.find((line) => /^\S+\.suite: pass\b/.test(line));
  check(
    verdict !== undefined &&
      field(verdict, "outcome") === "land" &&
      field(verdict, "verified") !== false &&
      suite !== undefined,
    `its verdict ${String(verdict === undefined ? "(none)" : field(verdict, "verdictId"))} shows the suite passing: ${suite ?? "(no suite line)"}`,
  );
  check(
    verdict !== undefined && !evidence.some((line) => line.startsWith("guard:")),
    "its verdict ran no guard: the fork holds no decision for one to hold",
  );

  console.log(
    "\n[feed] what the run's parties, conflict, escalation, decision and guard committed",
  );
  const ours = new Set([A, B, C, conflictId, escalationId, decisionId, guardId]);
  for (const e of feed.seen) {
    const named = ["changeId", "conflictId", "escalationId", "decisionId", "guardId"].map((k) =>
      field(e, k),
    );
    if (!ours.has(e.entity.id) && !named.some((id) => typeof id === "string" && ours.has(id)))
      continue;
    const who = e.actor === undefined ? "" : ` by ${e.actor}`;
    console.log(
      `     ${e.at} ${tagOf(e).padEnd(20)} ${e.entity.kind}:${e.entity.id}${who} ${brief(e.payload, 200)}`,
    );
  }
  console.log(`     (${feed.seen.length} events in the project's feed since cursor ${cursor})`);
  check(
    feed.faults.length === 0 && controlFeed.faults.length === 0,
    `no read of either feed failed (${feed.faults.length + controlFeed.faults.length} did)`,
  );

  if (!PUBLIC) return;
  console.log(
    "\n[h] the person makes both projects public, a visitor reads what memory did, and the person makes them private again",
  );
  const shown = [project.id, control.id];
  const showing = (visibility: "public" | "private") =>
    Promise.all(
      shown.map((id) =>
        me.putSettings(id, {
          protectedPaths: [],
          maxBatchSize: 1,
          verification: "required",
          visibility,
        }),
      ),
    );
  const visit = async (path: string) => {
    const response = await fetch(`${keelUrl}${path}`);
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  await showing("public");
  try {
    const decided = await visit(`/v1/decisions/${decisionId}`);
    check(
      decided.status === 200 &&
        prop(decided.body, "label") === "D-1" &&
        strings(prop(decided.body, "guards")).includes(guardId),
      `a visitor reads D-1, held by G-1: ${decided.status} ${String(prop(decided.body, "label"))}`,
    );
    for (const [name, id] of [
      [PROJECT, project.id],
      [`${PROJECT}-control`, control.id],
    ] as const) {
      const events = await visit(`/v1/events?project=${id}`);
      check(events.status === 200, `a visitor reads ${name}'s feed: ${events.status}`);
      console.log(`     ${name}: ${handle}/${name} (${id})`);
    }
  } finally {
    // However the reads went, a test project does not stay public.
    await showing("private");
  }
  const hidden = await visit(`/v1/decisions/${decisionId}`);
  check(hidden.status === 404, `private again, a visitor reads D-1 as absent: ${hidden.status}`);
  for (const id of shown) {
    const events = await visit(`/v1/events?project=${id}`);
    check(
      events.status === 404,
      `private again, a visitor reads ${id}'s feed as absent: ${events.status}`,
    );
  }
}

try {
  await walk();
} catch (error) {
  failures += 1;
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.status} ${error.message} (request ${error.requestId})`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else if (error instanceof AccountRefused) console.log(`FAIL stopped: ${error.message}`);
  // A failed git command names its remote: the host, which carries the account, is not printed.
  else
    console.log(
      `FAIL ${(error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "<remote>")}`,
    );
} finally {
  // A landed change is done, a parked one awaits a person's ruling, and one that is
  // integrating has left the queue for trunk and cannot be withdrawn: each is left as it is.
  // Anything else the run declared is withdrawn, by the person who owns both projects.
  const { person } = signedUp;
  for (const changeId of open) {
    if (person === undefined) break;
    try {
      const state = (await person.change(changeId)).state;
      if (state === "landed" || state === "withdrawn" || state === "superseded") continue;
      if (state === "parked") {
        console.log(`     left parked, for the person to rule on: ${changeId}`);
        continue;
      }
      if (state === "integrating") {
        console.log(`     left integrating, on its way to trunk: ${changeId}`);
        continue;
      }
      await person.abandon(
        changeId,
        { reason: `S-2 live check ${run} finished` },
        { idempotencyKey: key(`abandon:${changeId}`) },
      );
      console.log(`     abandoned ${changeId} (was ${state})`);
    } catch (error) {
      console.log(
        `FAIL abandon ${changeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failures += 1;
    }
  }
}
if (failures > 0) console.log(`\n${failures} check(s) failed`);
else if (unproven)
  console.log(
    "\nno conflict was proven, so no guard was admitted to hold a ruling: S-2 was not shown",
  );
else console.log("\nall S-2 live checks hold");
process.exit(failures > 0 ? 1 : unproven ? 3 : 0);
