// The live proof against a deployed Keel of a proven conflict put to a person
// by one of its parties, and the ruling that resumes them. When the Probe
// cannot prove the conflict and Keel puts it to the person itself, the run
// goes on as that person and rules: the ruling and the resume are the same
// path, and the run then says it met Keel's own escalation and exits 3.
//
//   KEEL_URL=<keel> KEEL_SESSION=<token> KEEL_NAMESPACE=<handle> KEEL_NAMESPACE_ID=<id> \
//     CLOUDFLARE_ACCOUNT_ID=<account> node e2e/src/t35.ts <run>
//
// KEEL_SESSION is a user's bearer session, read and never printed. That user
// creates the project in KEEL_NAMESPACE (its own is named by its handle) and
// sponsors its agents, so it is the person an escalation asks first. In a
// project of its own (t35-<run>, forked from the fixture repo), after putting
// the fixture's deps bundle under the namespace (KEEL_NAMESPACE_ID, with the
// operator's wrangler on CLOUDFLARE_ACCOUNT_ID): a deps bundle is one
// namespace's, and the Probe's runner is unavailable for a world with none, so
// without it the conflict is never proven and nothing below can happen:
//   (a) changes that each add one file hold the lane. A party that is
//       integrating or landed when its conflict is escalated is never parked,
//       and two changes alone land before the Probe is done; so the first of
//       these is timed from its submission to its landing, and at least
//       twenty-five more are queued ahead of the parties to outlast the proof.
//       A file each, because they cannot share one: a workspace is forked from
//       the pool at the trunk the project began with, so a later change never
//       holds an earlier one's file, and two changes that add one path do not
//       compose;
//   (b) scenario S1's two changes are declared and submitted behind them: A
//       relies on permission evaluation being fresh at most per-request, B
//       declares freshness = per-session. Keel suspects the conflict and the
//       Probe proves it (ConflictProven);
//   (c) B escalates it under its own lease (POST /v1/conflicts/{id}/resolution,
//       move `escalate`): EscalationRaised asks the agents' sponsor,
//       ConflictEscalated says human-class, and each party still queued parks
//       awaiting the ruling;
//   (d) the person finds the question among their open escalations and rules
//       (POST /v1/escalations/{id}/ruling) that the premise holds: RulingGiven,
//       DecisionRecorded, and ConflictResolved carrying that decision and
//       naming B, the change making the effect, as the party it goes against.
//       B is bounced by the decision, with the chosen option's consequence as
//       the reason, and does not land; A resumes.
// The arms that can fail: an escalate under another change's lease is refused;
// a ruling for an option the question does not offer is refused, and so is a
// second ruling; and a visitor reads nothing of the private project's feed.
// Every change the run leaves open is abandoned at the end, except a parked
// one: a party that awaits a ruling is the person's to answer, never the
// harness's to withdraw. No remote URL or credential is printed.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "@keeltown/sdk";
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

const run = process.argv[2];
if (run === undefined || !/^[a-z0-9-]+$/.test(run))
  throw new Error("usage: t35.ts <run>, the run a lower-case slug");
const needed = (name: string): string => {
  const value = process.env[name];
  if (value === undefined)
    throw new Error(
      `${name} is not set: t35 needs KEEL_URL, KEEL_SESSION (a user's session), KEEL_NAMESPACE (that user's own namespace, by handle), KEEL_NAMESPACE_ID (its id) and CLOUDFLARE_ACCOUNT_ID (for the deps bundle's upload)`,
    );
  return value;
};
const keelUrl = needed("KEEL_URL");
const session = needed("KEEL_SESSION");
const NAMESPACE = needed("KEEL_NAMESPACE");
const NAMESPACE_ID = needed("KEEL_NAMESPACE_ID");
needed("CLOUDFLARE_ACCOUNT_ID");
const ROOT = join(import.meta.dirname, "../..");
const PROJECT = `t35-${run}`;
const key = (what: string) => `t35:${run}:${what}`;
const SETTLE_MS = 10 * 60_000;
/** How long the changes ahead of the parties should keep the lane busy: longer than a proof has taken. */
const HOLD_MS = 7 * 60_000;
/** The fewest changes queued ahead of the parties: ten held them queued four minutes. */
const AHEAD = 25;
/** The Probe's budget from the parties' submissions to its verdict. */
const PROOF_MS = 10 * 60_000;
const STEP_MS = 2 * 60_000;

let failures = 0;
/** Whether Keel escalated the conflict itself, the Probe having proved nothing. */
let byKeel = false;
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

const seconds = (from: number) => Math.round((Date.now() - from) / 1000);
/** When an event was committed, by its own object's clock; NaN for one that is not there, which no comparison holds for. */
const when = (e: EventRecord | undefined) => (e === undefined ? Number.NaN : Date.parse(e.at));

const operator = new KeelClient({ baseUrl: keelUrl, session });
const open: string[] = [];
try {
  console.log(
    "[deps] the fixture's deps bundle goes under the namespace, where the Probe's runner looks",
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
      env: { ...process.env, KEEL_NAMESPACE_ID: NAMESPACE_ID },
    },
  );
  console.log(`     put: ${uploaded.trim().split("\n").at(-1)?.slice(0, 160) ?? ""}`);

  const project = await operator.createProject(
    { namespace: NAMESPACE, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  await operator.putSettings(project.id, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
  });
  console.log(`     project ${NAMESPACE}/${PROJECT}: ${project.id} (${project.visibility})`);
  const enrol = async (name: string) => {
    const enrolled = await operator.enrolAgent(
      { name, kind: "interactive", scopes: ["agent:read", "agent:work"], projectId: project.id },
      { idempotencyKey: key(`agent:${name}`) },
    );
    console.log(`     agent ${name}: ${enrolled.agent.id}`);
    return new KeelClient({
      baseUrl: keelUrl,
      clientId: enrolled.clientId,
      clientSecret: enrolled.clientSecret,
    });
  };
  const agentA = await enrol("t35-a");
  const agentB = await enrol("t35-b");
  const holder = await enrol("t35-hold");
  const me = await operator.me();
  const base = (await agentA.commits(project.id, { limit: 1 })).items[0]?.sha;
  if (base === undefined) throw new Error("the project's trunk has no commit");
  const { cursor } = await operator.snapshot({ project: project.id });
  console.log(`     trunk at ${base.slice(0, 12)}; feed cursor ${cursor}; asking as ${me.handle}`);
  // The person's own read of the project: a member's, so it holds the members-only events too.
  const feed = feedOf(operator, { project: project.id, cursor });
  const of = (tag: string, id: string) =>
    feed.seen.filter(
      (e) =>
        tagOf(e) === tag &&
        (e.entity.id === id ||
          ["changeId", "conflictId", "escalationId", "decisionId"].some((k) => field(e, k) === id)),
    );

  console.log("\n[a] changes ahead of the parties hold the lane");
  const hold = async (n: number): Promise<Declared> => {
    const path = `notes/hold-${run}-${n}.md`;
    const declared = await declareWhenPooled(
      holder,
      {
        goal: `Hold the lane (${n})`,
        footprint: [{ path, op: "create" }],
        premises: [],
      },
      key(`hold:${n}`),
      SETTLE_MS,
    );
    open.push(declared.result.change.id);
    await pushAndSubmit(
      holder,
      declared,
      {
        author: "t35-hold",
        message: `escalation ${run}: hold ${n}`,
        idempotencyKey: key(`hold:${n}:submit`),
      },
      (dir) => {
        mkdirSync(join(dir, "notes"), { recursive: true });
        writeFileSync(join(dir, path), `Holds the lane in escalation run ${run}.\n`);
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
  console.log(`     conflict ${conflictId}`);

  const submittedAt = Date.now();
  const patches = { a: scenarioPatch("a"), b: scenarioPatch("b") };
  await pushAndSubmit(
    agentA,
    a,
    { author: "t35-a", message: `escalation ${run}: A`, idempotencyKey: key("a:submit") },
    applyPatch(patches.a.file),
  );
  await pushAndSubmit(
    agentB,
    b,
    { author: "t35-b", message: `escalation ${run}: B`, idempotencyKey: key("b:submit") },
    applyPatch(patches.b.file),
  );
  // What ends the Probe's part: a proof, or the conflict escalated or dismissed without one.
  const ENDS = ["ConflictProven", "ConflictEscalated", "ConflictDismissed"];
  const VERDICTS = [...ENDS, "ProbeDiscarded"];
  await feed.until(() => VERDICTS.some((tag) => of(tag, conflictId).length > 0), PROOF_MS);
  // A discarded probe is not the end: Keel then escalates the conflict itself, a moment later.
  await feed.until(() => ENDS.some((tag) => of(tag, conflictId).length > 0), STEP_MS);
  const proven = of("ConflictProven", conflictId)[0];
  const stateOf = async (id: string) => (await operator.change(id)).state;
  console.log(
    `     ${held.filter((id) => of("ChangeLanded", id).length > 0).length} of ${held.length} ahead of the parties have landed at the Probe's end`,
  );
  if (proven === undefined) {
    for (const tag of VERDICTS)
      for (const e of of(tag, conflictId)) console.log(`     ${e.at} ${tag} ${brief(e.payload)}`);
    const own = of("ConflictEscalated", conflictId)[0];
    if (own === undefined || field(own, "reason") !== "unprovable")
      throw new Error("the conflict was neither proven nor escalated by Keel, so nobody is asked");
    byKeel = true;
    console.log(
      `\n[c] NOT PROVEN, ${seconds(submittedAt)} s after the parties' submissions: Keel put the conflict to the person itself (unprovable), so no party escalates and the run goes on as that person`,
    );
  } else {
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
  }
  const said = of("ConflictEscalated", conflictId)[0];
  const escalationId = String(said === undefined ? "" : field(said, "escalationId"));
  const reason = byKeel ? "unprovable" : "human-class";
  check(
    said !== undefined && field(said, "reason") === reason,
    `ConflictEscalated ${said?.eventId ?? "(none)"} says ${reason} and names ${escalationId}`,
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
    `EscalationRaised ${raised?.eventId ?? "(none)"} is in a member's feed`,
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

  console.log("\n[d] the person asked first rules");
  const asked = (await operator.escalations({ state: "open" })).items.find(
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
      operator.giveRuling(
        escalationId,
        { option: "neither" },
        { idempotencyKey: key("ruling:unknown") },
      ),
    )) === "400 escalation.option_unknown",
    "a ruling for an option the question does not offer is refused: 400 escalation.option_unknown",
  );
  const ruling = await operator.giveRuling(
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
  check(given !== undefined, `RulingGiven ${given?.eventId ?? "(none)"} is in a member's feed`);
  check(
    recorded !== undefined && resolved !== undefined,
    `DecisionRecorded ${recorded?.eventId ?? "(none)"}; ConflictResolved ${resolved?.eventId ?? "(none)"} carries ${decisionId}`,
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
        next.map((action) => Reflect.get(Object(action), "operationId")).join() ===
          "revise,abandon",
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
  // What the escalation follows: the proof, or the discarded probe when Keel escalated by itself.
  const cause = proven ?? of("ProbeDiscarded", conflictId)[0];
  check(
    when(cause) <= when(said) &&
      parks.every((at) => at >= when(said) && at < when(given)) &&
      when(given) <= when(resolved) &&
      resumes.every((at) => at >= when(resolved)),
    `by their commit times: ${byKeel ? "discarded" : "proven"}, escalated, parked, ruled, resolved, bounced or resumed`,
  );
  check(
    (await refusalOf(() =>
      operator.giveRuling(
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
    `a visitor reads nothing of the private project's feed: ${visitor.status} ${String(Reflect.get(Object(visitorBody), "code"))}`,
  );

  console.log("\n[feed] what the run's parties, conflict, escalation and decision committed");
  const ours = new Set([A, B, conflictId, escalationId, decisionId]);
  for (const e of feed.seen) {
    const named = ["changeId", "conflictId", "escalationId", "decisionId"].map((k) => field(e, k));
    if (!ours.has(e.entity.id) && !named.some((id) => typeof id === "string" && ours.has(id)))
      continue;
    const who = e.actor === undefined ? "" : ` by ${e.actor}`;
    console.log(
      `     ${e.at} ${tagOf(e).padEnd(20)} ${e.entity.kind}:${e.entity.id}${who} ${brief(e.payload, 200)}`,
    );
  }
  console.log(`     (${feed.seen.length} events in the project's feed since cursor ${cursor})`);
  check(feed.faults.length === 0, `no read of the feed failed (${feed.faults.length} did)`);
} catch (error) {
  failures += 1;
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.status} ${error.message}`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // A landed change is done, a parked one awaits a person's ruling, and one that is
  // integrating has left the queue for trunk and cannot be withdrawn: each is left as it is.
  // Anything else the run declared is withdrawn.
  for (const changeId of open) {
    try {
      const state = (await operator.change(changeId)).state;
      if (state === "landed" || state === "withdrawn" || state === "superseded") continue;
      if (state === "parked") {
        console.log(`     left parked, for the person to rule on: ${changeId}`);
        continue;
      }
      if (state === "integrating") {
        console.log(`     left integrating, on its way to trunk: ${changeId}`);
        continue;
      }
      await operator.abandon(
        changeId,
        { reason: `escalation check ${run} finished` },
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
else if (byKeel)
  console.log(
    "\nthe ruling, the bounce and the resume hold on Keel's own escalation; no conflict was proven, so no party's escalate ran",
  );
else console.log("\nall escalation checks hold");
process.exit(failures > 0 ? 1 : byKeel ? 3 : 0);
