// The anchor rule's live check against a deployed Keel: a change whose edit
// derives no effect still puts in doubt a premise anchored to the code it
// edits, and only that one.
//
//   KEEL_URL=<keel> node e2e/src/anchor.ts <run>
//
// It takes no Keel credential. A person, `an-<run>-p`, signs up by passkey,
// creates the project `anchor` in their own namespace from the fixture
// template with verification off, and enrols three agents:
//   - B relies on `loadRepo` being pure, anchored to that function;
//   - the decoy relies on `path`, in the same file, being pure;
//   - A declares an edit of `loadRepo` and submits one that changes no cache
//     (a local renamed), so Precheck derives no effect from it.
// After A's Precheck, B is told with PremiseSuspected, its cause A and the
// anchor on `loadRepo`; the decoy is told nothing, and no conflict opens.
// Every change the run declared is withdrawn at the end. No session, passkey,
// credential or remote URL is printed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeelClient, KeelProblem } from "@keeltown/sdk";
import { AccountRefused, signUp } from "../../scripts/lib/account.ts";
import {
  declareWhenPooled,
  type EventRecord,
  feedOf,
  field,
  FIXTURE,
  pushAndSubmit,
  tagOf,
} from "./lib/s1.ts";

const [run] = process.argv.slice(2);
if (run === undefined || !/^[a-z0-9]{1,12}$/.test(run))
  throw new Error("usage: anchor.ts <run>, the run up to twelve lower-case letters and digits");
const keelUrl = process.env.KEEL_URL ?? "";
if (keelUrl === "") throw new Error("KEEL_URL is not set: the Keel to check");

const PERSON = `an-${run}-p`;
const PROJECT = "anchor";
const FILE = "src/authz/require-permission.ts";
const RELIED = "authz.repo-load";
const DECOY = "authz.repo-path";
const key = (what: string) => `anchor:${run}:${what}`;
const SETTLE_MS = 10 * 60_000;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
};
const prop = (value: unknown, name: string): unknown => Reflect.get(Object(value), name);

const signedUp: { person?: KeelClient } = {};
const open: string[] = [];

async function walk(): Promise<void> {
  const account = await signUp(keelUrl, PERSON);
  const me = new KeelClient({ baseUrl: keelUrl, session: account.session.token });
  signedUp.person = me;
  const handle = account.session.namespace;
  console.log(`     ${PERSON} signed up by passkey: ${account.session.userId}`);
  const project = await me.createProject(
    { namespace: handle, name: PROJECT, source: { kind: "template", name: FIXTURE } },
    { idempotencyKey: key("project") },
  );
  await me.putSettings(project.id, { protectedPaths: [], maxBatchSize: 1, verification: "off" });
  console.log(`     project ${handle}/${PROJECT}: ${project.id}`);
  const enrol = async (name: string) => {
    const enrolled = await me.enrolAgent(
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
  const [agentB, decoy, agentA] = [
    await enrol("an-b"),
    await enrol("an-decoy"),
    await enrol("an-a"),
  ];
  const base = (await agentA.commits(project.id, { limit: 1 })).items[0]?.sha;
  if (base === undefined) throw new Error("the project's trunk has no commit");
  const { cursor } = await me.snapshot({ project: project.id });
  const feed = feedOf(me, { project: project.id, cursor });

  const pure = (subject: string, symbol: string) => ({
    subject,
    predicate: "purity" as const,
    relation: "is" as const,
    value: true,
    anchors: [{ path: FILE, symbol, commit: base }],
  });
  console.log("\n[1] B relies on loadRepo being pure; the decoy on path, in the same file");
  const b = await declareWhenPooled(
    agentB,
    { goal: "Cache loaded repositories", footprint: [], premises: [pure(RELIED, "loadRepo")] },
    key("b"),
    SETTLE_MS,
  );
  open.push(b.result.change.id);
  const d = await declareWhenPooled(
    decoy,
    { goal: "Memoise repository paths", footprint: [], premises: [pure(DECOY, "path")] },
    key("decoy"),
    SETTLE_MS,
  );
  open.push(d.result.change.id);
  console.log(`     B ${b.result.change.id}, decoy ${d.result.change.id}`);

  console.log("\n[2] A edits loadRepo's body in a way that derives nothing, and submits");
  const a = await declareWhenPooled(
    agentA,
    {
      goal: "Name loadRepo's owner lookup plainly",
      footprint: [{ path: FILE, symbol: "loadRepo", op: "edit" }],
      premises: [],
    },
    key("a"),
    SETTLE_MS,
  );
  const aId = a.result.change.id;
  open.push(aId);
  await pushAndSubmit(
    agentA,
    a,
    {
      author: "an-a",
      message: `anchor live ${run}: rename a local`,
      idempotencyKey: key("a:submit"),
    },
    (dir) => {
      const file = join(dir, FILE);
      const before = readFileSync(file, "utf8");
      const after = before
        .replace("const owner = store.findUserByUsername", "const found = store.findUserByUsername")
        .replace(
          "const repo = owner === undefined ? undefined : store.findRepo(owner.id,",
          "const repo = found === undefined ? undefined : store.findRepo(found.id,",
        );
      if (after === before) throw new Error("the fixture's loadRepo is not as this run expects");
      writeFileSync(file, after);
    },
  );

  const of = (tag: string) => feed.seen.filter((e) => tagOf(e) === tag);
  const suspectedFor = (holder: string) =>
    of("PremiseSuspected").filter((e) => field(e, "changeId") === holder);
  const derivedA = () => of("EffectsDerived").filter((e) => field(e, "changeId") === aId);
  await feed.until(
    () => derivedA().length > 0 && suspectedFor(b.result.change.id).length > 0,
    SETTLE_MS,
  );
  // A little longer, so a suspicion of the decoy, were it to come, is read too.
  await feed.until(() => false, 15_000);

  const [derived] = derivedA();
  check(
    derived !== undefined,
    `A's Precheck derived: ${derived === undefined ? "no EffectsDerived" : derived.at}`,
  );
  const effects = prop(derived?.payload, "effects");
  check(
    Array.isArray(effects) && effects.length === 0,
    `A's edit derived no effect: ${JSON.stringify(effects)}`,
  );
  const touched = prop(derived?.payload, "touched");
  check(
    Array.isArray(touched) &&
      touched.some(
        (t) => prop(t, "subject") === RELIED && prop(prop(t, "anchor"), "symbol") === "loadRepo",
      ) &&
      !touched.some((t) => prop(t, "subject") === DECOY),
    `A's derivation names B's anchor as touched, and not the decoy's: ${JSON.stringify(touched)}`,
  );
  const [told] = suspectedFor(b.result.change.id);
  const cause = prop(told?.payload, "cause");
  check(
    prop(cause, "changeId") === aId && prop(prop(cause, "anchor"), "symbol") === "loadRepo",
    `B got PremiseSuspected with A and the anchor as cause: ${JSON.stringify(cause)}`,
  );
  check(prop(cause, "effect") === undefined, "its cause names no effect: nothing was derived");
  check(
    suspectedFor(d.result.change.id).length === 0,
    `the decoy got no PremiseSuspected: ${suspectedFor(d.result.change.id).length}`,
  );
  const conflicts = of("ConflictSuspected").filter((e: EventRecord) => {
    const parties = prop(e.payload, "parties");
    return Array.isArray(parties) && parties.includes(aId);
  });
  check(conflicts.length === 0, `no conflict names A: ${conflicts.length}`);
  check(feed.faults.length === 0, `no feed read failed: ${feed.faults.join("; ") || "none"}`);
}

try {
  await walk();
} catch (error) {
  failures += 1;
  if (error instanceof KeelProblem) {
    console.log(`FAIL ${error.status} ${error.message} (request ${error.requestId})`);
    for (const next of error.nextActions) console.log(`       next: ${next.title}`);
  } else if (error instanceof AccountRefused) console.log(`FAIL stopped: ${error.message}`);
  else
    console.log(
      `FAIL ${(error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "<remote>")}`,
    );
} finally {
  const { person } = signedUp;
  for (const changeId of open) {
    if (person === undefined) break;
    try {
      const state = (await person.change(changeId)).state;
      if (["landed", "withdrawn", "superseded", "integrating", "parked"].includes(state)) continue;
      await person.abandon(
        changeId,
        { reason: `anchor live check ${run} finished` },
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
else console.log("\nall anchor live checks hold");
process.exit(failures > 0 ? 1 : 0);
