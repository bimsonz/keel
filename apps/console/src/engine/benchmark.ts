// The benchmark: what a swarm's runner planted, held against what Keel did
// about it. The runner seals its ground truth before the run and publishes it
// afterwards; nothing here is Keel's own account of how well it did.
//
// Nothing the runner says is taken on trust. The published text must hash to
// the commitment, and the changes it names must be, by Keel's own log, the
// changes of the agents and the subject it sealed.

import type { ConflictState } from "../domain/state.ts";
import type { ConflictEntry, World } from "./world.ts";

export interface ScoreEntry {
  id: string;
  kind: "planted" | "decoy";
  subject: string;
  predicate: string;
  relies: { agent: string; atMost: string };
  alters: { agent: string; to: string };
}

export type ScoreOutcome =
  /** Planted, and Keel proved it. */
  | "caught"
  /** Planted, and it got through: nothing was raised, or what was raised was dismissed. */
  | "missed"
  /** A decoy Keel never raised. */
  | "left-alone"
  /** A decoy Keel raised, and its probe dismissed. */
  | "dismissed"
  /** A decoy Keel proved a conflict on. */
  | "false-positive"
  /** Not settled yet. */
  | "undecided";

export interface ScoreRow {
  entry: ScoreEntry;
  outcome: ScoreOutcome;
  /** False when Keel's log does not show these changes to be those agents' changes on that subject. */
  borneOut: boolean;
  relies?: { changeId: string; label: string };
  alters?: { changeId: string; label: string; landed: boolean };
  conflict?: {
    id: string;
    label: string;
    state: ConflictState;
    costUsd?: number;
    guard?: string;
    decision?: string;
  };
  /** What Keel derived for the altering change on this subject and predicate, as it last stood. */
  derived?: { method: string; value: string; p?: number };
}

export interface BenchmarkState {
  /** `none`: this source has no sealed run. `sealed`: committed to, not yet published. */
  phase: "none" | "sealed" | "unsealed";
  runner?: string;
  commitment?: string;
  /** The published text, to be checked against the commitment. */
  sealedText?: string;
  planted: number;
  decoys: number;
  rows: ScoreRow[];
  caught: number;
  missed: number;
  /** Decoys that cost nobody anything in the end: never raised, or raised and dismissed. */
  decoysCleared: number;
  /** Of those, how many were raised first. */
  decoysRaised: number;
  falsePositives: number;
  undecided: number;
  /** Conflicts Keel proved that the runner did not plant, by label. */
  unplanted: string[];
  /** What Keel has done so far, whatever the truth turns out to be. */
  keel: { proven: number; dismissed: number; open: number };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fields(value: unknown): Map<string, unknown> {
  return new Map<string, unknown>(
    typeof value === "object" && value !== null ? Object.entries(value) : [],
  );
}

/** The entries in a published manifest: a salt, a newline, then JSON. Anything malformed is left out. */
export function entriesOf(sealed: string): ScoreEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sealed.slice(sealed.indexOf("\n") + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value: unknown): ScoreEntry[] => {
    const entry = fields(value);
    const kind = entry.get("kind");
    if (kind !== "planted" && kind !== "decoy") return [];
    const [relies, alters] = [fields(entry.get("relies")), fields(entry.get("alters"))];
    return [
      {
        id: text(entry.get("id")),
        kind,
        subject: text(entry.get("subject")),
        predicate: text(entry.get("predicate")),
        relies: { agent: text(relies.get("agent")), atMost: text(relies.get("atMost")) },
        alters: { agent: text(alters.get("agent")), to: text(alters.get("to")) },
      },
    ];
  });
}

/** Whether the published text is the one that was committed to. Null where it cannot be checked: the platform's digest needs a secure origin. */
export async function sealHolds(sealed: string, commitment: string): Promise<boolean | null> {
  const subtle: SubtleCrypto | undefined = globalThis.crypto.subtle;
  if (subtle === undefined) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(sealed));
  return (
    commitment ===
    `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
  );
}

const proved = (conflict: ConflictEntry): boolean =>
  conflict.guardId !== undefined ||
  conflict.state === "proven" ||
  conflict.state === "escalated" ||
  conflict.state === "resolved";

const ORDER: ScoreOutcome[] = [
  "missed",
  "false-positive",
  "undecided",
  "caught",
  "dismissed",
  "left-alone",
];

export function benchmarkOf(world: World): BenchmarkState {
  const conflicts = [...world.conflicts.values()];
  const keel = {
    proven: conflicts.filter(proved).length,
    dismissed: conflicts.filter((conflict) => conflict.state === "dismissed").length,
    open: conflicts.filter((conflict) => !proved(conflict) && conflict.state !== "dismissed")
      .length,
  };
  const empty = {
    rows: [],
    caught: 0,
    missed: 0,
    decoysCleared: 0,
    decoysRaised: 0,
    falsePositives: 0,
    undecided: 0,
    unplanted: [],
    keel,
  };
  const { seal, unseal } = world;
  if (seal === undefined) return { phase: "none", planted: 0, decoys: 0, ...empty };
  const sealed = {
    runner: seal.runner,
    commitment: seal.commitment,
    planted: seal.planted,
    decoys: seal.decoys,
  };
  if (unseal === undefined) return { phase: "sealed", ...sealed, ...empty };

  const nameOf = (changeId: string): string =>
    world.agents.get(world.changes.get(changeId)?.agentId ?? "")?.name ?? "";
  const accounted = new Set<string>();
  const rows = entriesOf(unseal.sealed).map((entry): ScoreRow => {
    const pair = unseal.changes[entry.id];
    const relies = world.changes.get(pair?.relies ?? "");
    const alters = world.changes.get(pair?.alters ?? "");
    const conflict =
      relies === undefined || alters === undefined
        ? undefined
        : conflicts.find(
            (candidate) =>
              candidate.parties.includes(relies.id) && candidate.parties.includes(alters.id),
          );
    if (conflict !== undefined) accounted.add(conflict.id);
    const borneOut =
      relies !== undefined &&
      alters !== undefined &&
      nameOf(relies.id) === entry.relies.agent &&
      nameOf(alters.id) === entry.alters.agent &&
      relies.premises.some(
        (premise) =>
          premise.subject === entry.subject &&
          premise.predicate === entry.predicate &&
          premise.relation === "at-most" &&
          String(premise.value) === entry.relies.atMost,
      ) &&
      alters.premises.some((premise) => premise.subject === entry.subject);
    const landed = alters?.state === "landed";
    const dismissed = conflict?.state === "dismissed";
    const raised = conflict !== undefined && proved(conflict);
    let outcome: ScoreOutcome = "undecided";
    if (entry.kind === "planted") {
      if (raised) outcome = "caught";
      else if (dismissed || (conflict === undefined && landed)) outcome = "missed";
    } else if (raised) outcome = "false-positive";
    else if (dismissed) outcome = "dismissed";
    else if (conflict === undefined && landed) outcome = "left-alone";
    const effect = alters?.effects.find(
      (candidate) =>
        candidate.proposition.subject === entry.subject &&
        candidate.proposition.predicate === entry.predicate,
    );
    return {
      entry,
      outcome,
      borneOut,
      ...(relies === undefined ? {} : { relies: { changeId: relies.id, label: relies.label } }),
      ...(alters === undefined
        ? {}
        : { alters: { changeId: alters.id, label: alters.label, landed } }),
      ...(conflict === undefined
        ? {}
        : {
            conflict: {
              id: conflict.id,
              label: conflict.label,
              state: conflict.state,
              ...(conflict.costUsd === undefined ? {} : { costUsd: conflict.costUsd }),
              ...(conflict.guardId === undefined
                ? {}
                : { guard: world.guards.get(conflict.guardId)?.label ?? "" }),
              ...(conflict.decisionId === undefined
                ? {}
                : { decision: world.decisions.get(conflict.decisionId)?.label ?? "" }),
            },
          }),
      ...(effect === undefined
        ? {}
        : {
            derived: {
              method: effect.method,
              value: String(effect.proposition.value),
              ...(effect.method === "extractor" || effect.p === undefined ? {} : { p: effect.p }),
            },
          }),
    };
  });
  const count = (outcome: ScoreOutcome): number =>
    rows.filter((row) => row.outcome === outcome).length;
  return {
    phase: "unsealed",
    ...sealed,
    sealedText: unseal.sealed,
    rows: rows.toSorted((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome)),
    caught: count("caught"),
    missed: count("missed"),
    decoysCleared: count("dismissed") + count("left-alone"),
    decoysRaised: count("dismissed"),
    falsePositives: count("false-positive"),
    undecided: count("undecided"),
    unplanted: conflicts
      .filter((conflict) => proved(conflict) && !accounted.has(conflict.id))
      .map((conflict) => conflict.label),
    keel,
  };
}
