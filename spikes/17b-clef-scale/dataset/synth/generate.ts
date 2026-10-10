// Generates the synthetic items from the families: subject x predicate x value
// x language x diff shape. Every choice is seeded, so the set is reproducible.
//
//   core      premise p, effect e: the subject's code changes from a "before"
//             value to e. For a contradiction the before value satisfied p.
//   decoy, different-subject: the subject stays at a value within p; its
//             sibling in the same file changes to a value that would violate p.
//   decoy, same-subject-compatible: a family's near-miss ("trap") variant,
//             with the surface of a violation and a value within p.
import { LATTICES, type Predicate } from "../../src/lattice.ts";
import { AUTHORITY } from "./authority.ts";
import { BOUND } from "./bound.ts";
import { CARDINALITY } from "./cardinality.ts";
import { CONSISTENCY } from "./consistency.ts";
import { unifiedDiff } from "./diff.ts";
import { FRESHNESS } from "./freshness.ts";
import { ORDERING } from "./ordering.ts";
import { PRESENCE } from "./presence.ts";
import { PURITY } from "./purity.ts";
import { SHAPE } from "./shape.ts";
import type { Family, FileSpec, RenderArgs } from "./types.ts";

export const FAMILIES: Family[] = [...FRESHNESS, ...CARDINALITY, ...ORDERING, ...CONSISTENCY, ...PRESENCE, ...AUTHORITY, ...PURITY, ...BOUND, ...SHAPE];

export type Sym = [name: string, kind: string, file: string, status: "added" | "modified" | "removed" | "unchanged"];

export interface SynthItem {
  id: string;
  kind: "core" | "decoy";
  decoyType?: "same-subject-compatible" | "different-subject";
  expectedLabel?: "compatible"; // decoys are compatible by construction; the build checks it
  family: string;
  template: { language: string; before: RenderArgs; after: RenderArgs; diffShape: string };
  subject: string;
  predicate: Predicate;
  value: string;
  scope: string;
  effect: string;
  reason: string;
  diff: string;
  symbols: Sym[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rank = (p: Predicate, v: string) => LATTICES[p].values.indexOf(v);
const violates = (p: Predicate, premise: string, v: string) =>
  LATTICES[p].relation === "eq" ? v !== premise : rank(p, v) > rank(p, premise);

function latticeSentence(p: Predicate, premise: string, e: string): string {
  if (LATTICES[p].relation === "eq") return e === premise ? `${e} equals the premise value.` : `${e} differs from the premise value ${premise}.`;
  if (e === premise) return `${e} equals the premise bound.`;
  return rank(p, e) > rank(p, premise) ? `${e} ranks above ${premise}, so the premise is violated.` : `${e} ranks below ${premise}, so the premise holds.`;
}

interface Rendered {
  text: Map<string, string>;
  syms: Map<string, { kind: string; file: string; code: string }>;
}

function rendered(files: FileSpec[]): Rendered {
  const text = new Map<string, string>();
  const syms = new Map<string, { kind: string; file: string; code: string }>();
  for (const f of files) {
    text.set(f.path, f.blocks.map((x) => x.code).join("\n\n") + "\n");
    for (const blk of f.blocks) if (blk.sym) syms.set(blk.sym[0], { kind: blk.sym[1], file: f.path, code: blk.code });
  }
  return { text, syms };
}

export function materialise(f: Family, before: RenderArgs, after: RenderArgs, context = 5): { diff: string; symbols: Sym[]; shape: string } {
  const a = rendered(f.render(before));
  const z = rendered(f.render(after));
  const paths = [...new Set([...a.text.keys(), ...z.text.keys()])];
  const diffs: string[] = [];
  let filesChanged = 0;
  for (const p of paths) {
    const x = a.text.get(p) ?? null;
    const y = z.text.get(p) ?? null;
    if (x === y) continue;
    filesChanged++;
    diffs.push(unifiedDiff(p, x, y, context));
  }
  if (diffs.length === 0) throw new Error(`${f.id}: render produced no change for ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const symbols: Sym[] = [];
  for (const [name, s] of z.syms) {
    const old = a.syms.get(name);
    const status = old === undefined ? "added" : old.code === s.code ? "unchanged" : "modified";
    if (status !== "unchanged" || name === f.anchor) symbols.push([name, s.kind, s.file, status]);
  }
  for (const [name, s] of a.syms) if (!z.syms.has(name)) symbols.push([name, s.kind, s.file, "removed"]);
  const hunks = (diffs.join("").match(/^@@/gm) ?? []).length;
  const shape = `${filesChanged > 1 ? "multi-file" : hunks > 1 ? "multi-hunk" : "single-hunk"}, context ${context}`;
  return { diff: diffs.join(""), symbols, shape };
}

// (premise, effect, copies) per predicate.
const all = (p: Predicate) => LATTICES[p].values;
function grid(p: Predicate, premises: string[], copies: number): [string, string, number][] {
  return premises.flatMap((pv) => all(p).map((e) => [pv, e, copies] as [string, string, number]));
}
const PLAN: Record<Predicate, [string, string, number][]> = {
  freshness: grid("freshness", ["per-call", "per-request", "per-session", "ttl"], 1),
  cardinality: grid("cardinality", ["exactly-one", "at-most-one"], 2),
  ordering: grid("ordering", ["fifo", "per-key-fifo"], 2),
  consistency: grid("consistency", ["strong", "read-your-writes"], 2),
  presence: grid("presence", ["required", "optional"], 2),
  authority: grid("authority", ["owner", "admin", "maintainer", "member", "authenticated"], 1),
  purity: grid("purity", ["pure", "idempotent"], 2),
  bound: [
    ["le-1", "le-1", 1], ["le-1", "le-10", 1],
    ["le-10", "le-1", 1], ["le-10", "le-10", 1], ["le-10", "le-100", 1],
    ["le-100", "le-10", 1], ["le-100", "le-100", 1], ["le-100", "le-1k", 1], ["le-100", "unbounded", 1],
    ["le-1k", "le-100", 1], ["le-1k", "le-1k", 1], ["le-1k", "le-10k", 1], ["le-1k", "unbounded", 1],
    ["le-10k", "le-1k", 1], ["le-10k", "le-100k", 1],
    ["le-100k", "le-10k", 1], ["le-100k", "le-1m", 1],
    ["le-1m", "le-1m", 1], ["le-1m", "unbounded", 1],
  ],
  shape: [
    ["integer", "string", 1], ["integer", "number", 1], ["integer", "integer", 1],
    ["string", "integer", 1], ["string", "array", 1], ["string", "string", 1],
    ["number", "string", 1], ["number", "integer", 1],
    ["boolean", "string", 1], ["boolean", "boolean", 1],
    ["array", "object", 1], ["array", "string", 1], ["array", "array", 1],
    ["object", "array", 1], ["object", "string", 1], ["object", "object", 1],
  ],
};

export function generate(): SynthItem[] {
  const rnd = mulberry32(0x17b);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const items: SynthItem[] = [];
  const used = new Set<string>();
  let n = 0;
  const nextId = () => `S${String(++n).padStart(3, "0")}`;

  for (const predicate of Object.keys(PLAN) as Predicate[]) {
    const fams = FAMILIES.filter((f) => f.predicate === predicate);
    let turn = 0;
    // core items
    for (const [premise, effect, copies] of PLAN[predicate]) {
      for (let c = 0; c < copies; c++) {
        let made = false;
        for (let k = 0; k < fams.length && !made; k++) {
          const f = fams[(turn + k) % fams.length];
          if (!f.values.includes(effect)) continue;
          const contra = violates(predicate, premise, effect);
          const befores = f.values.filter((v) => v !== effect && (!contra || !violates(predicate, premise, v)));
          const fresh = befores.filter((v) => !used.has(`${f.id}|${v}|${effect}`));
          if (fresh.length === 0) continue;
          const before = LATTICES[predicate].relation === "eq" && contra && fresh.includes(premise) ? premise : pick(fresh);
          used.add(`${f.id}|${before}|${effect}`);
          const m = materialise(f, { s: before, sib: f.baseline }, { s: effect, sib: f.baseline }, rnd() < 0.5 ? 3 : 5);
          items.push({
            id: nextId(), kind: "core", family: f.id,
            template: { language: f.language, before: { s: before, sib: f.baseline }, after: { s: effect, sib: f.baseline }, diffShape: m.shape },
            subject: f.subject, predicate, value: premise, scope: f.scope, effect,
            reason: `Before the change ${f.mech[before]}; after it ${f.mech[effect]}. ${latticeSentence(predicate, premise, effect)}`,
            diff: m.diff, symbols: m.symbols,
          });
          made = true;
          turn = (turn + k + 1) % fams.length;
        }
        if (!made) throw new Error(`no family can realise ${predicate} ${premise} -> ${effect} (copy ${c})`);
      }
    }
    // different-subject decoys: one per family with a sibling
    for (const f of fams) {
      if (f.sibValues.length === 0) continue;
      const options = f.values.flatMap((s) =>
        f.sibValues.filter((v) => v !== f.baseline && violates(predicate, s, v)).map((v) => [s, v] as [string, string]),
      );
      if (options.length === 0) continue;
      const [s, v] = pick(options);
      const m = materialise(f, { s, sib: f.baseline }, { s, sib: v }, rnd() < 0.5 ? 3 : 5);
      const sibForm = (f.sibMech?.[v] ?? f.mech[v]).replace(/^\S+/, "the sibling");
      items.push({
        id: nextId(), kind: "decoy", decoyType: "different-subject", expectedLabel: "compatible", family: f.id,
        template: { language: f.language, before: { s, sib: f.baseline }, after: { s, sib: v }, diffShape: m.shape },
        subject: f.subject, predicate, value: s, scope: f.scope, effect: s,
        reason: `Only the sibling symbol changes (it becomes the ${v} form: ${sibForm}). ${f.anchor} is untouched: ${f.mech[s]}. ${latticeSentence(predicate, s, s)}`,
        diff: m.diff, symbols: m.symbols,
      });
    }
    // near-miss decoys
    for (const f of fams) {
      for (const t of f.traps ?? []) {
        const m = materialise(f, t.before, t.after);
        items.push({
          id: nextId(), kind: "decoy", decoyType: "same-subject-compatible", expectedLabel: "compatible", family: f.id,
          template: { language: f.language, before: t.before, after: t.after, diffShape: m.shape },
          subject: f.subject, predicate, value: t.premise, scope: f.scope, effect: t.value,
          reason: `${t.why} ${latticeSentence(predicate, t.premise, t.value)}`,
          diff: m.diff, symbols: m.symbols,
        });
      }
    }
  }
  return items;
}
