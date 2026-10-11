// The swarm: hundreds of a load generator's agents changing one codebase at once, beside three REAL sessions.
//
// A small discrete-event simulation of Keel's own loop: an agent declares,
// works in a workspace, submits; Keel derives effects and compiles a plan; the
// change queues in its lane, is batched, verified and landed; the agent starts
// again. Now and then two changes disagree about a subject. Some of those
// disagreements are real (a probe proves them); some are false alarms (the
// probe gives the same answer in every world, and the alarm is dismissed).
//
// Times are seconds of simulated time from the epoch.

import type { EntityRef } from "../../../src/contract/envelope.ts";
import type { AnyEvent, ProbeWorld } from "../../../src/contract/events.ts";
import type { ManifestEntry } from "../../../src/contract/observations.ts";
import type { DerivedEffect, Predicate, Proposition } from "../../../src/contract/mfp.ts";
import type { FlowNode, StepKind } from "../../../src/contract/provisional.ts";
import { LANES, SUBJECTS } from "../subjects.ts";
import { type Rng, createRng, hash32 } from "../prng.ts";
import { sha256Hex } from "../sha256.ts";
import { type GeneratedLog, PLATFORM_PROJECT, ScriptBuilder } from "./builder.ts";
import { UNIT_USD } from "./funnel.ts";

export const SWARM_EPOCH = "2026-10-13T16:38:00.000Z";

export interface SwarmOptions {
  /** Hosted agents. Three REAL sessions are added on top. */
  agents?: number;
  /** How long agents keep starting new changes, in simulated seconds. */
  seconds?: number;
  /** Disagreements a probe will prove, and false alarms it will dismiss. */
  planted?: number;
  decoys?: number;
  /** Of the planted, how many are on a subject where the answer is a person's call. */
  rulings?: number;
  /** Disagreements Keel will not notice: real, landed, and never raised. */
  missed?: number;
}

/** What the runner arranges: a disagreement Keel settles by proof, one a person must rule on, a false alarm, or one Keel misses. */
type Arranged = "proven" | "ruling" | "decoy" | "unnoticed";

/** Each predicate's values, least first, so "at most" and "is" can be compared by position. */
// Each is one line through one of Keel's own lattices (fixtures/lattices.ts), least first, on which "at most"
// reads as it does in Keel: everything at or below the value. A change that steps past what another tolerates
// is a real disagreement on Keel's lattice, not on one made up here.
export const SCALES: [Predicate, string[]][] = [
  ["freshness", ["per-call", "per-request", "per-session", "static"]],
  ["freshness", ["per-call", "per-request", "ttl:300", "static"]],
  ["cardinality", ["exactly-once", "at-most-once", "any"]],
  ["cardinality", ["exactly-once", "at-least-once", "any"]],
];

/** Subjects where a proven disagreement is a person's call. */
const HUMAN_CLASS = new Set([
  "storage.gc.safety",
  "authz.token-revocation",
  "billing.invoice.rounding",
]);

const VERBS = [
  "Tighten",
  "Simplify",
  "Speed up",
  "Harden",
  "Extract",
  "Trim",
  "Instrument",
  "Split",
];

interface Task {
  t: number;
  order: number;
  run: (t: number) => void;
}

/** A binary min-heap on (t, order): what happens next. */
class Agenda {
  #heap: Task[] = [];
  #order = 0;

  add(t: number, run: (t: number) => void): void {
    const heap = this.#heap;
    heap.push({ t, order: this.#order, run });
    this.#order += 1;
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const [a, b] = [heap[i], heap[parent]];
      if (a === undefined || b === undefined || !before(a, b)) break;
      heap[i] = b;
      heap[parent] = a;
      i = parent;
    }
  }

  next(): Task | undefined {
    const heap = this.#heap;
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined) return undefined;
    if (heap.length === 0) return top;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const [left, right] = [2 * i + 1, 2 * i + 2];
      let least = i;
      for (const child of [left, right]) {
        const [a, b] = [heap[child], heap[least]];
        if (a !== undefined && b !== undefined && before(a, b)) least = child;
      }
      if (least === i) break;
      const [a, b] = [heap[i], heap[least]];
      if (a === undefined || b === undefined) break;
      heap[i] = b;
      heap[least] = a;
      i = least;
    }
    return top;
  }
}

function before(a: Task, b: Task): boolean {
  return a.t < b.t || (a.t === b.t && a.order < b.order);
}

interface Live {
  id: string;
  agentId: string;
  workspace: string;
  subject: SubjectInfo;
  /** How far up the subject's scale this change tolerates. */
  tolerates: number;
  revision: number;
  commit: string;
  inConflict: boolean;
}

interface SubjectInfo {
  id: string;
  key: string;
  namespace: string;
  laneId: string;
  predicate: Predicate;
  scale: string[];
  heat: number;
  /** Changes in flight on this subject. */
  live: Live[];
  /** How many premises stand at each place on the scale, in flight or landed. A landed change's premise stays. */
  standing: number[];
}

interface LaneState {
  id: string;
  number: number;
  queue: Live[];
  inFlight: number;
  ticking: boolean;
  batches: number;
}

const changeRef = (id: string): EntityRef => ({ kind: "change", id });
const step = (
  id: string,
  title: string,
  tier: 0 | 1 | 2,
  because: string,
  kind: StepKind = "deterministic",
): FlowNode => ({
  op: "step",
  step: {
    id,
    title,
    kind,
    tier,
    tierReason: ["Pure git", "Fits in an isolate", "Needs a full toolchain"][tier] ?? "",
    // A model's answer is an opinion, whatever it says.
    evidenceCeiling: kind === "decision-model" ? "opinion" : "proof",
    because: { text: because },
  },
});

/** What settling one disagreement costs: Clef picks the probe's template, the code model drafts it, and it runs this many cells. */
const disputeUsd = (cells: number): number =>
  Math.round((UNIT_USD.clefCall + UNIT_USD.probeDraft + cells * UNIT_USD.probeRun) * 1e6) / 1e6;

function hex(r: Rng, length: number): string {
  return Array.from({ length }, () => "0123456789abcdef"[r.int(0, 15)]).join("");
}

/** What a change relies on: its subject's predicate, at most this far up the scale. */
function premiseOf(live: Live): Proposition {
  return {
    subject: live.subject.key,
    predicate: live.subject.predicate,
    relation: "at-most",
    value: live.subject.scale[live.tolerates] ?? "",
  };
}

export function generateSwarm(seed: number, options: SwarmOptions = {}): GeneratedLog {
  const generated = options.agents ?? 800;
  const duration = options.seconds ?? 150;
  const root = createRng(seed).fork("swarm");
  const rng = root.fork("simulation");
  const b = new ScriptBuilder(SWARM_EPOCH, root);
  const agenda = new Agenda();

  // ── The project, its subjects and lanes ──
  const project = b.at(0).id("prj");
  b.project = project;
  // The Trunk DO is its own entity, named for its project, with its own seq.
  const trunkRef: EntityRef = { kind: "trunk", id: project };
  const operator = b.id("agt");
  b.emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: operator },
    payload: {
      agentId: operator,
      projectId: PLATFORM_PROJECT,
      name: "Operator",
      kind: "human",
      scopes: ["operator"],
    },
  });
  const subjects: SubjectInfo[] = [];
  for (const [namespace, seeds] of Object.entries(SUBJECTS)) {
    for (const subject of seeds) {
      const id = b.id("sub");
      const [predicate, scale] = SCALES[hash32(subject.key) % SCALES.length] ?? [
        "freshness",
        ["a", "b", "c"],
      ];
      subjects.push({
        id,
        key: subject.key,
        namespace,
        laneId: LANES.find((lane) => lane.namespaces.includes(namespace))?.id ?? "lane-1",
        predicate,
        scale,
        heat: subject.heat,
        live: [],
        standing: scale.map(() => 0),
      });
      b.emit({
        type: "SubjectMinted",
        entity: { kind: "subject", id },
        payload: {
          subjectId: id,
          key: subject.key,
          anchors: [
            {
              path: `src/${namespace}/${subject.key.split(".").slice(1).join("-")}.ts`,
              commit: "4b1d9e0",
            },
          ],
          gloss: subject.gloss,
          mintedBy: "scan",
        },
      });
    }
  }
  const heat = subjects.map((subject) => subject.heat);
  const lanes = new Map<string, LaneState>(
    LANES.map((lane, index) => [
      lane.id,
      { id: lane.id, number: index + 1, queue: [], inFlight: 0, ticking: false, batches: 0 },
    ]),
  );

  let head = `4b1d9e0${hex(rng, 33)}`;
  let height = 0;
  b.at(0).emit({
    type: "ProjectCreated",
    entity: { kind: "project", id: project },
    payload: { projectId: project, name: "demo", by: operator },
  });
  // Nothing is queued or promoted before trunk's first head is known.
  b.at(0).emit({
    type: "TrunkInitialized",
    entity: trunkRef,
    payload: { projectId: project, head, by: operator },
  });
  /** Trunk has one writer: a group is promoted only once the one before it has been read back. */
  let trunkFreeAt = 0;
  // The runner arranges its disagreements before the run and spreads them through it, in an order of its own.
  const rulings = Math.min(options.rulings ?? 2, options.planted ?? 12);
  const plan: Arranged[] = [
    ...Array.from({ length: (options.planted ?? 12) - rulings }, (): Arranged => "proven"),
    ...Array.from({ length: rulings }, (): Arranged => "ruling"),
    ...Array.from({ length: options.decoys ?? 8 }, (): Arranged => "decoy"),
    ...Array.from({ length: options.missed ?? 1 }, (): Arranged => "unnoticed"),
  ];
  const shuffle = root.fork("truth");
  for (let i = plan.length - 1; i > 0; i -= 1) {
    const j = shuffle.int(0, i);
    const [a, c] = [plan[i], plan[j]];
    if (a !== undefined && c !== undefined) [plan[i], plan[j]] = [c, a];
  }
  const firstAt = 24;
  const every = Math.max(1.5, (duration - 60) / plan.length);
  // What the runner arranged, kept apart from everything Keel is told. It is sealed before the run and published after it.
  const truth: ManifestEntry[] = [];
  const truthChanges: Record<string, { relies: string; alters: string }> = {};
  const names = new Map<string, string>();
  const arranged = (kind: ManifestEntry["kind"], relies: Live, alters: Live, to: number): void => {
    const id = `M-${String(truth.length + 1).padStart(2, "0")}`;
    truth.push({
      id,
      kind,
      subject: relies.subject.key,
      predicate: relies.subject.predicate,
      relies: {
        agent: names.get(relies.agentId) ?? "",
        atMost: relies.subject.scale[relies.tolerates] ?? "",
      },
      alters: { agent: names.get(alters.agentId) ?? "", to: relies.subject.scale[to] ?? "" },
    });
    truthChanges[id] = { relies: relies.id, alters: alters.id };
  };
  const counters = { conflict: 0, probe: 0, guard: 0, escalation: 0, decision: 0, declared: 0 };

  // ── One change, from declaration to its place in the lane's queue ──
  const start = (agentId: string, t: number, pace: number): void => {
    const subject = subjects[rng.weighted(heat)];
    if (subject === undefined) return;
    const workspace = b.at(Math.max(0, t - 1.2)).id("wsp");
    b.emit({
      type: "WorkspaceForked",
      entity: { kind: "workspace", id: workspace },
      payload: {
        workspaceId: workspace,
        repo: `ws-${workspace.slice(-8).toLowerCase()}`,
        sourceRepo: "mirror",
      },
    });
    const id = b.at(t).id("chg");
    const live: Live = {
      id,
      agentId,
      workspace,
      subject,
      tolerates: rng.int(0, subject.scale.length - 2),
      revision: 1,
      commit: hex(rng, 7),
      inConflict: false,
    };
    counters.declared += 1;
    const premise: Proposition = { ...premiseOf(live), strength: "must" };
    const noun = subject.key.split(".").slice(1).join(" ").replaceAll("-", " ");
    const declared = b.emit({
      type: "IntentDeclared",
      entity: changeRef(id),
      // Keel numbers a project's changes in the order they are declared.
      label: `#${counters.declared}`,
      payload: {
        changeId: id,
        agentId,
        origin: "agent",
        revision: 1,
        goal: `${rng.pick(VERBS)} ${noun}`,
        footprint: [
          { path: `src/${subject.namespace}/${noun.replaceAll(" ", "-")}.ts`, op: "edit" },
        ],
        premises: [premise],
        leaseId: b.id("lse"),
      },
    });
    b.at(t + 0.15).emit({
      type: "PreflightIssued",
      entity: changeRef(id),
      payload: {
        changeId: id,
        revision: 1,
        neighbours: subject.live.slice(-3).map((other) => ({
          changeId: other.id,
          goal: "",
          subjects: [subject.key],
          overlap: "subject" as const,
        })),
        contradictions: [],
        precedents: [],
        suggestedMove: "proceed",
      },
    });
    const granted = b.at(t + 0.3).emit({
      type: "WorkspaceGranted",
      entity: { kind: "workspace", id: workspace },
      payload: {
        workspaceId: workspace,
        holder: id,
        expiresAt: b.instant(b.now + 7_200_000),
        baseSha: head,
      },
      causation: declared,
    });
    b.at(t + 0.32).emit({
      type: "ChangeStarted",
      entity: changeRef(id),
      payload: { changeId: id, workspaceId: workspace, baseSha: head },
      causation: granted,
    });
    b.at(t + 0.35).emit({
      type: "PremiseRelied",
      entity: { kind: "subject", id: subject.id },
      payload: { subjectId: subject.id, changeId: id, premise: premiseOf(live) },
      causation: declared,
    });
    subject.live.push(live);
    subject.standing[live.tolerates] = (subject.standing[live.tolerates] ?? 0) + 1;
    const work = (14 + rng.next() * 30) * pace;
    b.at(t + work * 0.55).emit({
      type: "WorkspacePushed",
      entity: { kind: "workspace", id: workspace },
      payload: { workspaceId: workspace, ref: "refs/heads/work", sha: hex(rng, 7) },
    });
    agenda.add(t + work, (at) => submit(live, at));
  };

  /** Submit, precheck, derive. */
  const submit = (live: Live, t: number): void => {
    const submitted = b.at(t).emit({
      type: "ChangeSubmitted",
      entity: changeRef(live.id),
      payload: {
        changeId: live.id,
        revision: live.revision,
        commitSha: live.commit,
        workspaceId: live.workspace,
      },
    });
    b.at(t + 0.6).emit({
      type: "PrecheckStarted",
      entity: changeRef(live.id),
      payload: {
        changeId: live.id,
        revision: live.revision,
        instanceId: `precheck:${live.id}:${live.revision}`,
      },
      causation: submitted,
    });
    agenda.add(t + 1.2 + rng.next() * 1.2, (at) => derive(live, at));
  };

  const derive = (live: Live, t: number): void => {
    const { subject } = live;
    // A disagreement steps one place past the strictest premise standing on the subject, so it contradicts that
    // one premise and no other. It needs a change still in flight that holds it, to be the other party.
    const others = subject.live.filter((other) => other !== live);
    const strictest = subject.standing.findIndex((held) => held > 0);
    // The next arranged disagreement falls to the first change that derives after its moment, on a subject
    // of the right kind, with someone there to disagree with.
    const due = plan[truth.length];
    const target =
      live.revision === 1 &&
      due !== undefined &&
      t >= firstAt + truth.length * every &&
      (due === "ruling") === HUMAN_CLASS.has(subject.key)
        ? others.find((other) => other.tolerates === strictest && !other.inConflict)
        : undefined;
    const planted = target !== undefined && due !== "decoy";
    // One real disagreement goes unnoticed: no extractor applies, and Clef reads the diff as leaving the predicate
    // alone. From here Keel treats it as an ordinary change, and only the runner knows better.
    const unnoticed = target !== undefined && due === "unnoticed";
    // Where no extractor applies, Clef derives the effect, as an opinion. A false alarm is always one of those.
    const byClef =
      target === undefined
        ? rng.next() < 0.12
        : due === "decoy" || due === "unnoticed" || rng.next() < 0.4;
    if (unnoticed) arranged("planted", target, live, target.tolerates + 1);
    /** Who Keel will find this change disagreeing with. */
    const partner = unnoticed ? undefined : target;
    // An ordinary change leaves the predicate at its least value, which is inside every premise.
    const alters = partner === undefined ? 0 : partner.tolerates + 1;
    const found = {
      declared: live.revision > 1,
      proposition: {
        subject: subject.key,
        predicate: subject.predicate,
        relation: "is" as const,
        value: subject.scale[alters] ?? "",
      },
      anchors: [{ path: `src/${subject.namespace}/index.ts`, commit: live.commit }],
    };
    const effect: DerivedEffect = byClef
      ? {
          ...found,
          method: "clef",
          evidenceClass: "opinion",
          p: Math.round(((unnoticed ? 0.55 : 0.82) + rng.next() * 0.16) * 100) / 100,
        }
      : { ...found, method: "extractor", evidenceClass: "ruling" };
    const derived = b.at(t).emit({
      type: "EffectsDerived",
      entity: changeRef(live.id),
      payload: {
        changeId: live.id,
        revision: live.revision,
        effects: [effect],
        derivationRef: `mfp:derivation:${live.id}:${live.revision}`,
      },
    });
    if (partner !== undefined) {
      b.at(t + 0.1).emit({
        type: "DriftDetected",
        entity: changeRef(live.id),
        payload: {
          changeId: live.id,
          revision: live.revision,
          drift: [
            {
              class: "silent-retraction",
              severity: "high",
              detail: `Derived ${subject.predicate} is ${subject.scale[alters] ?? ""}, which another change does not tolerate.`,
            },
          ],
        },
      });
    }
    const tier2 = rng.next() < 0.08;
    b.at(t + 0.3).emit({
      type: "PlanCompiled",
      entity: changeRef(live.id),
      payload: {
        changeId: live.id,
        revision: live.revision,
        planHash: `plan:${hex(rng, 8)}`,
        steps: {
          op: "seq",
          of: [
            step(
              "diff",
              "Tree diff against trunk",
              0,
              "Every change is diffed against the head it will land on",
            ),
            byClef
              ? step(
                  "clef",
                  "Derive effects: Clef",
                  1,
                  "No extractor applies to this footprint",
                  "decision-model",
                )
              : step(
                  "extract",
                  "Derive effects: extractors",
                  1,
                  "Effects are derived from the diff, never taken from the agent",
                ),
            tier2
              ? step(
                  "build",
                  "Build and test in a container",
                  2,
                  `The footprint needs the ${subject.namespace} toolchain`,
                )
              : step(
                  "unit",
                  "Project tests, selected",
                  1,
                  `The footprint touches src/${subject.namespace}`,
                ),
          ],
        },
        costEstimate: tier2 ? 0.02 : 0.004,
      },
    });
    if (partner === undefined) {
      agenda.add(t + 2 + rng.next() * 3, (at) => queue(live, at));
      return;
    }
    // A decoy only looks as if it alters the predicate: what it really does is inside the premise.
    arranged(planted ? "planted" : "decoy", partner, live, planted ? alters : 0);
    live.inConflict = true;
    partner.inConflict = true;
    agenda.add(t + 0.4, (at) => dispute(live, partner, planted, at, derived));
  };

  /** Two changes disagree. A probe either proves it or shows the alarm was false. */
  /** Two changes disagree. `derived` is the derivation that showed it, and so the conflict's cause. */
  const dispute = (
    live: Live,
    partner: Live,
    real: boolean,
    t: number,
    derived: AnyEvent,
  ): void => {
    const { subject } = live;
    counters.conflict += 1;
    const label = `C-${counters.conflict}`;
    const conflict = b.at(t).id("cfl");
    const conflictRef: EntityRef = { kind: "conflict", id: conflict };
    const holds = subject.scale[partner.tolerates] ?? "";
    const makes = subject.scale[partner.tolerates + 1] ?? "";
    const suspected = b.emit({
      type: "ConflictSuspected",
      entity: conflictRef,
      payload: {
        conflictId: conflict,
        kind: "semantic",
        parties: [partner.id, live.id],
        subjectId: subject.id,
        predicate: subject.predicate,
        x: {
          summary: `One change relies on ${subject.predicate} at most ${holds}; the other makes it ${makes}`,
          silentRetraction: true,
        },
      },
      label,
      causation: derived,
    });
    counters.probe += 1;
    const probe = b.at(t + 5 + rng.next() * 3).id("prb");
    const probeRef: EntityRef = { kind: "probe", id: probe };
    b.emit({
      type: "ProbeDrafted",
      entity: probeRef,
      label: `P-${counters.probe}`,
      payload: {
        probeId: probe,
        conflictId: conflict,
        attempts: 1,
        bundleHash: `sha256:${hex(rng, 4)}…${hex(rng, 4)}`,
        x: { path: `probes/${subject.key}/${subject.predicate}.probe.ts` },
      },
      causation: suspected,
    });
    let at = b.now / 1000 + 2;
    // A real disagreement fails in the combined world. A false alarm passes there too. Either way the probe
    // fails in the control world, where what the holder relies on is removed: that is what makes it a probe.
    // Keel decides as soon as it can: three complete runs that all discriminate admit the probe, and the
    // first complete run that does not discards it. So a false alarm never gets its second run in A+B.
    const worlds: [ProbeWorld, "pass" | "fail" | "n/a", readonly (1 | 2 | 3)[]][] = [
      ["trunk", "pass", [1, 2, 3]],
      ["A-noop", "fail", [1, 2, 3]],
      ["A", "pass", [1, 2, 3]],
      ["B", "pass", [1, 2, 3]],
      ["AB", real ? "fail" : "pass", real ? [1, 2, 3] : [1]],
    ];
    const cost = disputeUsd(worlds.reduce((cells, [, , runs]) => cells + runs.length, 0));
    for (const [world, outcome, runs] of worlds) {
      for (const run of runs) {
        at += 0.9 + rng.next() * 0.5;
        b.at(at).emit({
          type: "ProbeRan",
          entity: probeRef,
          payload: {
            probeId: probe,
            conflictId: conflict,
            world,
            run,
            outcome,
            resultRef: `r2:probes/${probe}/${world}/${run}`,
            x: { cost: { ms: 1_100, usd: UNIT_USD.probeRun } },
          },
        });
      }
    }
    agenda.add(at + 0.4, (now) => {
      partner.inConflict = false;
      live.inConflict = false;
      if (!real) {
        b.at(now).emit({
          type: "ProbeDiscarded",
          entity: probeRef,
          payload: { probeId: probe, reason: "non-discriminating", conflictId: conflict },
        });
        b.at(now + 0.1).emit({
          type: "ConflictDismissed",
          entity: conflictRef,
          payload: {
            conflictId: conflict,
            evidence: `probe:${probe}:non-discriminating`,
            x: { cost: { ms: 12_000, usd: cost } },
          },
        });
        agenda.add(now + 1, (later) => queue(live, later));
        return;
      }
      counters.guard += 1;
      const guard = b.at(now).id("grd");
      // The probe's own event: from here the admitted probe is the guard.
      b.emit({
        type: "GuardAdmitted",
        entity: probeRef,
        label: `G-${counters.guard}`,
        payload: { guardId: guard, probeId: probe, conflictId: conflict, runs: 3 },
      });
      const proven = b.at(now + 0.1).emit({
        type: "ConflictProven",
        entity: conflictRef,
        payload: {
          conflictId: conflict,
          evidence: { _tag: "probe", probeId: probe },
          x: { cost: { ms: 14_000, usd: cost } },
        },
      });
      const bounce = (when: number, summary: string, decisionId?: string): void => {
        const verdict = b.at(when).id("vrd");
        b.emit({
          type: "VerdictIssued",
          entity: { kind: "verdict", id: verdict },
          payload: {
            verdictId: verdict,
            subject: live.id,
            outcome: "bounce",
            evidence: b.reasons(verdict, "bounce", [
              {
                class: "proof",
                summary: `Probe P-${counters.probe} fails in the combined world, three runs out of three`,
                by: "World matrix · Tier 1 isolate",
                ref: `prb:${probe}/AB`,
                at: b.iso(),
              },
            ]),
            x: { summary },
          },
        });
        b.at(when + 0.1).emit({
          type: "ChangeBounced",
          entity: changeRef(live.id),
          payload: {
            changeId: live.id,
            verdictId: verdict,
            reasons: [],
            nextActions: [
              {
                kind: "call",
                title: `Keep ${subject.predicate} at most ${holds}`,
                operationId: "revise",
              },
            ],
          },
        });
        if (decisionId === undefined) {
          b.at(when + 0.2).emit({
            type: "ConflictResolved",
            entity: conflictRef,
            payload: { conflictId: conflict, move: "refine" },
          });
        }
        // The agent revises to keep what the other change relies on, and comes back.
        live.revision = 2;
        live.commit = hex(rng, 7);
        const revised = when + 6 + rng.next() * 8;
        b.at(revised).emit({
          type: "IntentRevised",
          entity: changeRef(live.id),
          payload: { changeId: live.id, revision: 2, premisesAdded: [], premisesRetracted: [] },
        });
        agenda.add(revised + 6 + rng.next() * 8, (later) => submit(live, later));
      };
      if (!HUMAN_CLASS.has(subject.key)) {
        bounce(now + 0.3, `Conflict ${label} is proven: the change alters what another relies on`);
        return;
      }
      // Human-class: both the question and the wait are shown. The default while open is hold.
      counters.escalation += 1;
      const escalation = b.at(now + 0.3).id("esc");
      const escalationRef: EntityRef = { kind: "escalation", id: escalation };
      const choices = [
        {
          id: "keep",
          label: `Keep ${subject.predicate} at most ${holds}`,
          consequence: "The change that alters it bounces and must find another way.",
        },
        {
          id: "relax",
          label: `Allow ${subject.predicate} to be ${makes}`,
          consequence:
            "The change that relies on the old value must relax its premise, and the guard is retired.",
        },
      ];
      // What stands until someone answers: the question's default.
      const hold = {
        id: "hold",
        label: "The change waits",
        consequence: "Nothing lands on this subject from it.",
      };
      const raised = b.emit({
        type: "EscalationRaised",
        entity: escalationRef,
        label: `E-${counters.escalation}`,
        payload: {
          escalationId: escalation,
          question: `May ${subject.key.split(".").slice(1).join(" ").replaceAll("-", " ")} be ${makes}?`,
          options: [...choices, hold],
          about: conflictRef,
          category:
            subject.namespace === "authz"
              ? "permission-semantics"
              : subject.namespace === "storage"
                ? "destructive-migration"
                : "ambiguous-requirement",
          evidence: [
            {
              class: "proof",
              summary: `Probe P-${counters.probe} fails in the combined world, three runs out of three`,
              ref: `prb:${probe}/AB`,
            },
          ],
          precedents: [],
          default: hold.id,
        },
        causation: proven,
      });
      b.at(now + 0.4).emit({
        type: "ConflictEscalated",
        entity: conflictRef,
        payload: { conflictId: conflict, escalationId: escalation, reason: "human-class" },
      });
      b.at(now + 0.5).emit({
        type: "ChangeParked",
        entity: changeRef(live.id),
        payload: { changeId: live.id, reason: "awaiting-ruling", escalationId: escalation },
        causation: raised,
      });
      const ruledAt = now + 14 + rng.next() * 10;
      const given = b.at(ruledAt).emit({
        type: "RulingGiven",
        entity: escalationRef,
        payload: {
          escalationId: escalation,
          option: "keep",
          by: operator,
          rationale: choices[0]?.label ?? "",
        },
      });
      counters.decision += 1;
      const decisionId = b.at(ruledAt + 0.1).id("dec");
      b.emit({
        type: "ConflictResolved",
        entity: conflictRef,
        payload: { conflictId: conflict, move: "yield", decisionId },
        causation: given,
      });
      b.at(ruledAt + 0.2).emit({
        type: "DecisionRecorded",
        entity: { kind: "decision", id: decisionId },
        label: `D-${counters.decision}`,
        payload: {
          decisionId,
          escalationId: escalation,
          option: "keep",
          summary: choices[0]?.label ?? "",
          scope: subject.key,
          evidence: [],
          alternatives: [
            {
              option: choices[1]?.label ?? "",
              reasonRejected: "It would break a change already relying on the old value",
            },
          ],
        },
        causation: given,
      });
      bounce(
        ruledAt + 0.3,
        `Decision D-${counters.decision}: ${choices[0]?.label ?? ""}`,
        decisionId,
      );
    });
  };

  // ── Lanes: queue, batch, verify, land ──
  const queue = (live: Live, t: number): void => {
    const lane = lanes.get(live.subject.laneId);
    if (lane === undefined) return;
    b.at(t).emit({
      type: "ChangeQueued",
      entity: changeRef(live.id),
      payload: { changeId: live.id, laneId: lane.id },
    });
    lane.queue.push(live);
    if (!lane.ticking) {
      lane.ticking = true;
      agenda.add(t + 0.8 + rng.next(), (at) => tick(lane, at));
    }
  };

  const tick = (lane: LaneState, t: number): void => {
    lane.ticking = false;
    if (lane.queue.length === 0) return;
    // Speculation is bounded: a lane verifies at most three batches at once.
    if (lane.inFlight >= 3) {
      lane.ticking = true;
      agenda.add(t + 1.5, (at) => tick(lane, at));
      return;
    }
    const members = lane.queue.splice(0, Math.min(lane.queue.length, 3 + rng.int(0, 5)));
    lane.batches += 1;
    lane.inFlight += 1;
    const batch = b.at(t).id("bat");
    const batchRef: EntityRef = { kind: "batch", id: batch };
    const base = height;
    const formed = b.emit({
      type: "BatchFormed",
      entity: batchRef,
      payload: {
        batchId: batch,
        laneId: lane.id,
        members: members.map((m) => m.id),
        base: head,
        attempt: 1,
        chainEpoch: 1,
        x: { label: `L${lane.number}·${lane.batches}`, heldApart: [] },
      },
    });
    for (const member of members) {
      b.at(t + 0.05).emit({
        type: "ChangeBatched",
        entity: changeRef(member.id),
        payload: { changeId: member.id, batchId: batch },
        causation: formed,
      });
    }
    const tier = rng.next() < 0.08 ? 2 : rng.next() < 0.55 ? 0 : 1;
    const candidate = b.at(t + 0.3).id("cnd");
    const candidateRef: EntityRef = { kind: "candidate", id: candidate };
    const tree = hex(rng, 40);
    b.emit({
      type: "CandidateAssembled",
      entity: candidateRef,
      payload: {
        candidateId: candidate,
        batchId: batch,
        treeSha: tree,
        composer: tier === 2 ? "mergebox" : "gitcore",
        tier,
        tierReason:
          tier === 2
            ? "GitCore refused: two members touch one file"
            : "Paths are disjoint, so no merge engine is needed",
      },
    });
    const planHash = `plan:${hex(rng, 8)}`;
    b.at(t + 0.5).emit({
      type: "VerificationStarted",
      entity: candidateRef,
      payload: {
        candidateId: candidate,
        batchId: batch,
        instanceId: `keelverify:${batch}:1`,
        planHash,
      },
    });
    if (lane.queue.length > 0) {
      lane.ticking = true;
      agenda.add(t + 1.2 + rng.next() * 1.2, (at) => tick(lane, at));
    }
    agenda.add(t + 4 + rng.next() * 4 + (tier === 2 ? 6 : 0), (at) => {
      lane.inFlight -= 1;
      const verdict = b.at(at).id("vrd");
      b.emit({
        type: "VerdictIssued",
        entity: { kind: "verdict", id: verdict },
        payload: {
          verdictId: verdict,
          subject: batch,
          outcome: "land",
          evidence: [],
          planHash,
          x: { summary: "Verified: nothing it could have broken is broken" },
        },
      });
      const verified = b.at(at + 0.05).emit({
        type: "BatchVerified",
        entity: batchRef,
        payload: { batchId: batch, candidateId: candidate, verdictId: verdict },
      });
      const begins = Math.max(at + 0.08, trunkFreeAt);
      trunkFreeAt = begins + 0.09;
      agenda.add(begins, (now) => promote(now, verified));
    });

    /** The Trunk DO writes the group ahead, composes it once, pushes, and reads the head back. */
    const promote = (now: number, verified: AnyEvent): void => {
      height += 1;
      const from = head;
      head = tree;
      const groupId = `grp_${batch.slice(-10)}`;
      const proofId = `prf_${candidate.slice(-10)}`;
      // Trunk moved while this batch was verifying, and it landed without being rebuilt.
      const commuted = base < height - 1;
      const started = b.at(now).emit({
        type: "PromotionStarted",
        entity: trunkRef,
        payload: {
          projectId: project,
          groupId,
          old: from,
          members: members.map((m) => m.id),
          batches: [batch],
          proofIds: [proofId],
          committerTime: b.instant(),
        },
        causation: verified,
      });
      b.at(now + 0.03).emit({
        type: "PromotionComposed",
        entity: trunkRef,
        payload: {
          projectId: project,
          groupId,
          sha: head,
          commits: members.map((m) => ({ changeId: m.id, commitSha: m.commit })),
        },
      });
      const advanced = b.at(now + 0.07).emit({
        type: "TrunkAdvanced",
        entity: trunkRef,
        payload: {
          projectId: project,
          from,
          to: head,
          groupId,
          landings: members.map((m) => ({
            changeId: m.id,
            commitSha: m.commit,
            candidateId: candidate,
            proofId,
          })),
          height,
          x: {
            commuted: commuted
              ? members.map((m) => ({
                  changeId: m.id,
                  verifiedAtHeight: base,
                  conditions: ["C1", "C2", "C3", "C4", "C5", "C6"] as const,
                }))
              : [],
          },
        },
        causation: started,
      });
      b.at(now + 0.12).emit({
        type: "CandidatePromoted",
        entity: candidateRef,
        payload: { candidateId: candidate, batchId: batch, trunkSha: head },
        causation: advanced,
      });
      for (const member of members) {
        // In step with the log: a change is in flight until its landing is recorded.
        agenda.add(now + 0.17, () => {
          member.subject.live = member.subject.live.filter((other) => other !== member);
        });
        b.at(now + 0.17).emit({
          type: "ChangeLanded",
          entity: changeRef(member.id),
          payload: {
            changeId: member.id,
            commitSha: member.commit,
            trunkSha: head,
            candidateId: candidate,
            proofId,
          },
          causation: advanced,
        });
        b.at(now + 0.8).emit({
          type: "WorkspaceCollected",
          entity: { kind: "workspace", id: member.workspace },
          payload: { workspaceId: member.workspace, reason: "landed" },
        });
        // The agent takes a breath and starts its next change.
        if (now < duration - 20)
          agenda.add(now + 3 + rng.next() * 9, (later) => start(member.agentId, later, 1));
      }
      if (height % 12 === 0) {
        b.at(now + 6).emit({
          type: "AuditCompleted",
          entity: trunkRef,
          payload: {
            projectId: project,
            head,
            outcome: "green",
            suspects: [],
            runRef: `r2:audits/${head.slice(0, 7)}`,
          },
          causation: advanced,
        });
      }
    };
  };

  // ── Agents arrive over the first twenty seconds ──
  for (let i = 0; i < generated + 3; i += 1) {
    const real = i >= generated;
    const arrives = real ? 2 + (i - generated) * 3 : rng.next() * 22;
    const agentId = b.at(arrives).id("agt");
    names.set(
      agentId,
      real
        ? `Claude Code · ${"ABC"[i - generated] ?? ""}`
        : `synthetic-${String(i + 1).padStart(3, "0")}`,
    );
    b.emit({
      type: "AgentEnrolled",
      entity: { kind: "agent", id: agentId },
      // The load generator's agents are enrolled as what they are.
      payload: {
        agentId,
        projectId: project,
        name: names.get(agentId) ?? "",
        kind: real ? "interactive" : "synthetic",
        scopes: ["agent:work", "agent:read"],
      },
    });
    if (real) {
      // A person's own session says what it is running in.
      const session = b.id("ses");
      b.at(arrives + 0.2).emit({
        type: "SessionOpened",
        entity: { kind: "session", id: session },
        payload: { sessionId: session, agentId, harness: "Claude Code" },
      });
    }
    agenda.add(arrives + 0.5 + rng.next() * 3, (t) => start(agentId, t, real ? 1.8 : 1));
  }

  // ── Counters only the platform knows: synthetic intents and preflight latency ──
  const noise = root.fork("metrics");
  for (let second = 1; second <= duration + 30; second += 1) {
    b.at(second).observe({
      kind: "metrics",
      syntheticIntents: Math.min(100_000, Math.round(100_000 * (second / duration) ** 1.1)),
      preflightP50Ms: 9 + Math.round(noise.next() * 3),
      preflightP99Ms: 31 + Math.round(noise.next() * 12),
    });
  }

  // Run until everything in flight has landed, or half a minute past the last new change.
  for (
    let task = agenda.next();
    task !== undefined && task.t <= duration + 30;
    task = agenda.next()
  )
    task.run(task.t);

  // ── The runner's ground truth: a commitment before the run, the manifest after it ──
  const sealed = `${hex(root.fork("seal"), 32)}\n${JSON.stringify(truth)}`;
  b.at(0).observe({
    kind: "seal",
    runner: `pnpm swarm --seed ${seed} --planted ${truth.filter((entry) => entry.kind === "planted").length} --decoys ${truth.filter((entry) => entry.kind === "decoy").length}`,
    commitment: `sha256:${sha256Hex(sealed)}`,
    planted: truth.filter((entry) => entry.kind === "planted").length,
    decoys: truth.filter((entry) => entry.kind === "decoy").length,
  });
  b.at(duration + 30).observe({ kind: "unseal", sealed, changes: truthChanges });
  return b.build();
}
