// Builds docs/spikes/s17c-dataset.json: S17b's 242 items (same sources, same
// diffs, same labels), plus what S17c sends Clef for each:
//   states.stripped  S17b's state with comments stripped            (fix 1)
//   states.scoped    the anchor view, comments stripped              (fixes 1 + 3)
//   rotation         which relabelled ask goes first in the call     (fix 2)
// The build fails if
//   - a label differs from the one computed on the lattice (S17's check),
//   - S17b's state is not reproduced byte-for-byte (synthetic diffs are
//     re-rendered by the anchor code, so this pins the anchor view's base),
//   - a sent state names its own answer (S17b's src/leak.ts, unchanged),
//   - a comment survives in a sent state,
//   - a hand-cut anchor view adds a line (sub-diff) or differs from the
//     fixture source (fixture),
//   - the rotation does not put each relabelling in each slot equally often (±1),
//   - two items would send the identical stripped request.
// Two items whose anchor views are identical are reported, not rejected:
// scoping collapses different-subject changes onto the same anchor code.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { HAND_ANCHORS } from "../dataset/anchors.ts";
import { FORGE_ITEMS } from "../dataset/forge-lite/items.ts";
import { ITEMS as S17_ITEMS, type ItemSpec } from "../dataset/s17/items.ts";
import { anchorView } from "../dataset/synth/anchor.ts";
import { FAMILIES, generate } from "../dataset/synth/generate.ts";
import { canonical } from "../src/estimator.ts";
import { LATTICES, compare, type Predicate, type Premise } from "../src/lattice.ts";
import { commentText, leaks } from "../src/leak.ts";
import { sectionCount, stripDiff } from "../src/strip.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const docs = join(pkg, "..", "..", "docs", "spikes");
const out = join(docs, "s17c-dataset.json");
const fixtureRoot = join(pkg, "..", "..", "fixtures", "forge-lite");

const LANG: Record<string, string> = {
  ".ts": "typescript", ".js": "javascript", ".py": "python", ".go": "go", ".c": "c", ".h": "c", ".tf": "hcl", ".sql": "sql",
};

export interface Hunk { file: string; language: string; diff: string }

/** S17's parser: recomputes @@ counts from the bodies and indents Go with tabs. */
export function parseDiff(text: string): Hunk[] {
  const lines = text.replace(/\n$/, "").split("\n");
  const files: { oldPath: string; newPath: string; hunks: { header: string; oldStart: number; newStart: number; body: string[] }[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      files.push({ oldPath: line.slice(4), newPath: lines[i + 1].slice(4), hunks: [] });
      i++;
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) {
      files.at(-1)!.hunks.push({ header: m[3], oldStart: Number(m[1]), newStart: Number(m[2]), body: [] });
      continue;
    }
    const hunk = files.at(-1)?.hunks.at(-1);
    if (!hunk) throw new Error(`line outside a hunk: ${line}`);
    hunk.body.push(line === "" ? " " : line);
  }
  return files.map((f) => {
    const path = (f.newPath === "/dev/null" ? f.oldPath : f.newPath).replace(/^[ab]\//, "");
    const language = LANG[extname(path)] ?? "text";
    const parts = [`--- ${f.oldPath}`, `+++ ${f.newPath}`];
    for (const h of f.hunks) {
      let body = h.body;
      if (language === "go") {
        body = body.map((l) => l[0] + l.slice(1).replace(/^( {4})+/, (s) => "\t".repeat(s.length / 4)));
      }
      for (const l of body) if (![" ", "+", "-"].includes(l[0])) throw new Error(`bad hunk line in ${path}: ${l}`);
      const oldCount = body.filter((l) => l[0] !== "+").length;
      const newCount = body.filter((l) => l[0] !== "-").length;
      const oldStart = f.oldPath === "/dev/null" ? 0 : h.oldStart;
      const newStart = f.newPath === "/dev/null" ? 0 : h.newStart;
      parts.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${h.header}`, ...body);
    }
    return { file: path, language, diff: parts.join("\n") + "\n" };
  });
}

type Source = "s17" | "forge-lite" | "synthetic";
interface Raw {
  source: Source;
  id: string;
  kind: "core" | "decoy";
  decoyType?: string;
  tags?: string[];
  family?: string;
  template?: unknown;
  subject: string;
  predicate: Premise["predicate"];
  value: string;
  scope: string;
  effect: string;
  writtenLabel?: string; // hand-written (s17, forge-lite) or by construction (synthetic decoys)
  reason: string;
  diff: string;
  symbols: [string, string, string, string][];
  view: { diff: string; anchors: string[] | null; kind: string; addSymbols?: [string, string, string, string][]; touched?: boolean };
}

function fromSpec(source: Source, dir: string, s: ItemSpec): Raw {
  return {
    source, id: s.id, kind: s.kind, decoyType: s.decoyType, tags: s.tags, subject: s.subject, predicate: s.predicate,
    value: s.value, scope: s.scope, effect: s.effect, writtenLabel: s.label, reason: s.reason,
    diff: readFileSync(join(pkg, "dataset", dir, "diffs", `${s.id}.diff`), "utf8"), symbols: s.symbols,
    view: handView(s.id, readFileSync(join(pkg, "dataset", dir, "diffs", `${s.id}.diff`), "utf8")),
  };
}

/** The anchor view of a hand-written item (dataset/anchors.ts). */
function handView(id: string, diff: string): Raw["view"] {
  const a = HAND_ANCHORS[id];
  if (!a) return { diff, anchors: null, kind: "identity" };
  if (a.view === "symbol-only") return { diff: "", anchors: a.anchors, kind: a.view, addSymbols: a.addSymbols, touched: false };
  return { diff: readFileSync(join(pkg, "dataset", "anchored", `${id}.diff`), "utf8"), anchors: a.anchors, kind: a.view, addSymbols: a.addSymbols, touched: a.view === "sub-diff" ? undefined : false };
}

const bodyLines = (h: Hunk) => h.diff.split("\n").filter((l) => l !== "" && !l.startsWith("--- ") && !l.startsWith("+++ ") && !l.startsWith("@@"));

/** Fails unless `cut` only removes lines from `orig`: per file, its body lines are a subsequence. */
export function checkSubDiff(id: string, orig: Hunk[], cut: Hunk[]): string[] {
  const errors: string[] = [];
  for (const h of cut) {
    const o = orig.find((x) => x.file === h.file);
    if (!o) { errors.push(`${id}: anchor view adds file ${h.file}`); continue; }
    const ob = bodyLines(o);
    let k = 0;
    for (const line of bodyLines(h)) {
      while (k < ob.length && ob[k] !== line) k++;
      if (k === ob.length) { errors.push(`${id}: anchor view line not in the original diff, in order: ${JSON.stringify(line)}`); break; }
      k++;
    }
  }
  return errors;
}

/** Fails unless every context line of the view is the fixture file's line at that number. */
function checkFixture(id: string, view: Hunk[], file: string): string[] {
  const src = readFileSync(join(fixtureRoot, file), "utf8").split("\n");
  const errors: string[] = [];
  for (const h of view) {
    let n = 0;
    for (const line of h.diff.split("\n")) {
      const m = /^@@ -(\d+)/.exec(line);
      if (m) { n = Number(m[1]); continue; }
      if (line === "" || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
      if (line[0] !== " ") errors.push(`${id}: fixture view has a change line`);
      else if (src[n - 1] !== line.slice(1)) errors.push(`${id}: fixture line ${n} differs: ${JSON.stringify(line)}`);
      n++;
    }
  }
  return errors;
}

type State = { hunks: Hunk[]; symbols: { name: string; kind: string; file: string; status: string }[] };

/** The "+" and "-" lines of a state's hunks. */
const changedLines = (st: State) => st.hunks.flatMap((h) => h.diff.split("\n").filter((l) => /^[+-](?!\+\+|--)/.test(l)));

/** Fix 1 on a state: comments stripped from every hunk; a hunk left with no section is dropped. */
function stripped(state: State): State {
  const hunks = state.hunks.map((h) => ({ ...h, diff: stripDiff(h.diff, h.language).diff })).filter((h) => sectionCount(h.diff) > 0);
  return { hunks, symbols: state.symbols };
}

export function buildDataset() {
  const families = new Map(FAMILIES.map((f) => [f.id, f]));
  const raws: Raw[] = [
    ...S17_ITEMS.map((s) => fromSpec("s17", "s17", s)),
    ...FORGE_ITEMS.map((s) => fromSpec("forge-lite", "forge-lite", s)),
    ...generate().map((g): Raw => {
      const f = families.get(g.family)!;
      const v = anchorView(f, g.template.before, g.template.after, Number(/context (\d+)/.exec(g.template.diffShape)![1]));
      if (v.full !== g.diff) throw new Error(`${g.id}: anchor code does not rebuild S17b's diff`);
      return {
        source: "synthetic", id: g.id, kind: g.kind, decoyType: g.decoyType, family: g.family, template: g.template,
        subject: g.subject, predicate: g.predicate, value: g.value, scope: g.scope, effect: g.effect,
        writtenLabel: g.expectedLabel, reason: g.reason, diff: g.diff, symbols: g.symbols,
        view: { diff: v.diff, anchors: [...v.subjectSyms], kind: "renderer", touched: v.anchorTouched },
      };
    }),
  ];
  const s17b = new Map((JSON.parse(readFileSync(join(docs, "s17b-dataset.json"), "utf8")) as { items: { id: string; change: unknown; premise: unknown; label: string }[] }).items.map((i) => [i.id, i]));
  const errors: string[] = [];
  const seen = new Map<string, string>();
  const seenScoped = new Map<string, string>();
  const scopedDuplicates: string[] = [];
  const hadComments = new Set<string>();
  // Fix 2: a Latin square over the items, predicate by predicate, so each
  // relabelling sits in each slot equally often overall and per predicate.
  const rotationOf = new Map<string, number>();
  let rot = 0;
  for (const p of Object.keys(LATTICES) as Predicate[]) for (const r of raws.filter((x) => x.predicate === p)) rotationOf.set(r.id, rot++ % 3);
  const items = raws.map((r) => {
    const premise: Premise = { subject: r.subject, predicate: r.predicate, relation: LATTICES[r.predicate].relation, value: r.value, scope: r.scope };
    const label = compare(premise, r.effect);
    if (r.writtenLabel !== undefined && label !== r.writtenLabel) errors.push(`${r.id}: lattice says ${label}, written label is ${r.writtenLabel}`);
    const hunks = parseDiff(r.diff);
    const symbols = r.symbols.map(([name, kind, file, status]) => ({ name, kind, file, status }));
    const change = { hunks, symbols };
    const base = s17b.get(r.id);
    if (!base || canonical(base.change) !== canonical(change) || canonical(base.premise) !== canonical(premise) || base.label !== label) errors.push(`${r.id}: does not reproduce S17b's item`);

    // Fix 3: the anchor view, then fix 1 on it.
    const viewHunks = r.view.diff ? parseDiff(r.view.diff) : [];
    if (r.view.kind === "sub-diff") errors.push(...checkSubDiff(r.id, hunks, viewHunks));
    if (r.view.kind === "fixture") errors.push(...checkFixture(r.id, viewHunks, HAND_ANCHORS[r.id].fixture!));
    const anchors = r.view.anchors ?? symbols.map((x) => x.name);
    const viewSymbols = [...symbols.filter((x) => anchors.includes(x.name)), ...(r.view.addSymbols ?? []).map(([name, kind, file, status]) => ({ name, kind, file, status }))];
    for (const a of r.view.kind === "renderer" ? [] : anchors) if (!viewSymbols.some((x) => x.name === a)) errors.push(`${r.id}: anchor ${a} has no symbol entry`);
    const touched = r.view.touched ?? viewHunks.some((h) => bodyLines(h).some((l) => l[0] === "+" || l[0] === "-"));
    const states = { stripped: stripped(change), scoped: stripped({ hunks: viewHunks, symbols: viewSymbols }) };
    if (canonical(states.stripped) !== canonical(change)) hadComments.add(r.id);

    for (const [name, st] of Object.entries(states)) {
      errors.push(...leaks({ id: r.id, predicate: r.predicate, effect: r.effect, subject: r.subject, scope: r.scope, hunks: st.hunks, symbols: st.symbols }).map((e) => `${e} [${name}]`));
      for (const h of st.hunks) if (commentText(h.diff, h.language).trim()) errors.push(`${r.id}: a comment survives in ${h.file} [${name}]`);
    }
    const request = canonical({ state: states.stripped, subject: r.subject, predicate: r.predicate, scope: r.scope });
    if (seen.has(request)) errors.push(`${r.id}: sends the same request as ${seen.get(request)}`);
    seen.set(request, r.id);
    const scopedRequest = canonical({ state: states.scoped, subject: r.subject, predicate: r.predicate, scope: r.scope, value: r.value });
    if (seenScoped.has(scopedRequest)) scopedDuplicates.push(`${r.id}=${seenScoped.get(scopedRequest)}`);
    seenScoped.set(scopedRequest, r.id);
    return {
      id: r.id,
      source: r.source,
      kind: r.kind,
      ...(r.decoyType ? { decoyType: r.decoyType } : {}),
      ...(r.tags ? { tags: r.tags } : {}),
      ...(r.family ? { family: r.family, template: r.template } : {}),
      language: hunks.find((h) => h.language !== "sql")!.language,
      premise,
      groundTruthEffect: { subject: r.subject, predicate: r.predicate, value: r.effect },
      label,
      reason: r.reason,
      rotation: rotationOf.get(r.id)!,
      anchors: { symbols: anchors, view: r.view.kind, touched },
      states,
    };
  });
  const rotations = [0, 1, 2].map((k) => items.filter((i) => i.rotation === k).length);
  if (Math.max(...rotations) - Math.min(...rotations) > 1) errors.push(`rotation unbalanced: ${rotations.join("/")}`);
  if (errors.length) throw new Error(`dataset check failed:\n  ${errors.join("\n  ")}`);

  const count = (f: (i: (typeof items)[number]) => boolean) => items.filter(f).length;
  const tally = (key: (i: (typeof items)[number]) => string, sub = items) =>
    sub.reduce<Record<string, number>>((acc, i) => ((acc[key(i)] = (acc[key(i)] ?? 0) + 1), acc), {});
  const composition = {
    total: items.length,
    bySource: tally((i) => i.source),
    core: count((i) => i.kind === "core"),
    coreContradiction: count((i) => i.kind === "core" && i.label === "contradiction"),
    coreCompatible: count((i) => i.kind === "core" && i.label === "compatible"),
    decoys: count((i) => i.kind === "decoy"),
    decoySameSubjectCompatible: count((i) => i.decoyType === "same-subject-compatible"),
    decoyDifferentSubject: count((i) => i.decoyType === "different-subject"),
    byLanguage: tally((i) => i.language),
    rotations,
    rotationByPredicate: Object.fromEntries(Object.keys(LATTICES).map((p) => [p, [0, 1, 2].map((k) => count((i) => i.premise.predicate === p && i.rotation === k))])),
    strip: {
      itemsWithComments: hadComments.size,
      ids: [...hadComments],
      byLanguage: tally((i) => i.language, items.filter((i) => hadComments.has(i.id))),
    },
    anchorView: {
      byKind: tally((i) => i.anchors.view),
      untouched: count((i) => !i.anchors.touched),
      untouchedByKind: tally((i) => (i.kind === "core" ? `core-${i.label}` : `decoy-${i.decoyType}`), items.filter((i) => !i.anchors.touched)),
      noHunks: items.filter((i) => i.states.scoped.hunks.length === 0).map((i) => i.id),
      // Touched items whose view drops a changed line of the stripped diff: a
      // line that mixes subject and sibling code is sibling-sensitive and goes.
      touchedLosingChangedLines: items.filter((i) => {
        const kept = new Set(changedLines(i.states.scoped));
        return i.anchors.touched && changedLines(i.states.stripped).some((l) => !kept.has(l));
      }).map((i) => i.id),
      scopedDuplicates,
    },
  };
  return {
    name: "Keel S17c premise/effect evaluation set",
    note: "S17b's 242 items unchanged (same diffs, effects and lattice-computed labels; labels never come from the model under test). The unstripped state is S17b's (s17b-dataset.json), which the build reproduces byte-for-byte. states.stripped is S17b's state with comments removed; states.scoped is the premise's anchor view with comments removed. The build rejects any sent state that contains its own answer or a comment.",
    lattices: Object.fromEntries(Object.entries(LATTICES).map(([p, l]) => [p, { relation: l.relation, order: l.values }])),
    composition,
    items,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ds = buildDataset();
  writeFileSync(out, JSON.stringify(ds, null, 2) + "\n");
  console.log(JSON.stringify(ds.composition));
}
