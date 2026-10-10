// Builds docs/spikes/s17b-dataset.json from three sources:
//   s17        S17's 40 items (dataset/s17), held out as a subset
//   forge-lite the S-1 pair and its variants (dataset/forge-lite)
//   synthetic  items generated from templates (dataset/synth)
// The build fails if
//   - a label differs from the one computed on the lattice (S17's check),
//   - an item's state or question names its own answer (src/leak.ts),
//   - two items would send Clef the identical request.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { FORGE_ITEMS } from "../dataset/forge-lite/items.ts";
import { ITEMS as S17_ITEMS, type ItemSpec } from "../dataset/s17/items.ts";
import { generate } from "../dataset/synth/generate.ts";
import { canonical } from "../src/estimator.ts";
import { LATTICES, compare, type Premise } from "../src/lattice.ts";
import { leaks } from "../src/leak.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "..", "..", "docs", "spikes", "s17b-dataset.json");

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
}

function fromSpec(source: Source, dir: string, s: ItemSpec): Raw {
  return {
    source, id: s.id, kind: s.kind, decoyType: s.decoyType, tags: s.tags, subject: s.subject, predicate: s.predicate,
    value: s.value, scope: s.scope, effect: s.effect, writtenLabel: s.label, reason: s.reason,
    diff: readFileSync(join(pkg, "dataset", dir, "diffs", `${s.id}.diff`), "utf8"), symbols: s.symbols,
  };
}

export function buildDataset() {
  const raws: Raw[] = [
    ...S17_ITEMS.map((s) => fromSpec("s17", "s17", s)),
    ...FORGE_ITEMS.map((s) => fromSpec("forge-lite", "forge-lite", s)),
    ...generate().map((g): Raw => ({
      source: "synthetic", id: g.id, kind: g.kind, decoyType: g.decoyType, family: g.family, template: g.template,
      subject: g.subject, predicate: g.predicate, value: g.value, scope: g.scope, effect: g.effect,
      writtenLabel: g.expectedLabel, reason: g.reason, diff: g.diff, symbols: g.symbols,
    })),
  ];
  const errors: string[] = [];
  const seen = new Map<string, string>();
  const items = raws.map((r) => {
    const premise: Premise = { subject: r.subject, predicate: r.predicate, relation: LATTICES[r.predicate].relation, value: r.value, scope: r.scope };
    const label = compare(premise, r.effect);
    if (r.writtenLabel !== undefined && label !== r.writtenLabel) errors.push(`${r.id}: lattice says ${label}, written label is ${r.writtenLabel}`);
    const hunks = parseDiff(r.diff);
    const symbols = r.symbols.map(([name, kind, file, status]) => ({ name, kind, file, status }));
    errors.push(...leaks({ id: r.id, predicate: r.predicate, effect: r.effect, subject: r.subject, scope: r.scope, hunks, symbols }));
    const request = canonical({ state: { hunks, symbols }, subject: r.subject, predicate: r.predicate, scope: r.scope });
    if (seen.has(request)) errors.push(`${r.id}: sends the same request as ${seen.get(request)}`);
    seen.set(request, r.id);
    return {
      id: r.id,
      source: r.source,
      kind: r.kind,
      ...(r.decoyType ? { decoyType: r.decoyType } : {}),
      ...(r.tags ? { tags: r.tags } : {}),
      ...(r.family ? { family: r.family, template: r.template } : {}),
      language: hunks.find((h) => h.language !== "sql")!.language,
      premise,
      change: { hunks, symbols },
      groundTruthEffect: { subject: r.subject, predicate: r.predicate, value: r.effect },
      label,
      reason: r.reason,
    };
  });
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
    decoyShare: +(count((i) => i.kind === "decoy") / items.length).toFixed(3),
    decoySameSubjectCompatible: count((i) => i.decoyType === "same-subject-compatible"),
    decoyDifferentSubject: count((i) => i.decoyType === "different-subject"),
    byPredicate: Object.fromEntries(
      Object.keys(LATTICES).map((p) => [
        p,
        {
          contradiction: count((i) => i.premise.predicate === p && i.label === "contradiction"),
          compatible: count((i) => i.premise.predicate === p && i.kind === "core" && i.label === "compatible"),
          decoy: count((i) => i.premise.predicate === p && i.kind === "decoy"),
          effectValues: tally((i) => i.groundTruthEffect.value, items.filter((i) => i.premise.predicate === p)),
        },
      ]),
    ),
    byLanguage: tally((i) => i.language),
    byDiffShape: tally((i) => {
      const files = i.change.hunks.length;
      const hunks = i.change.hunks.reduce((s, h) => s + (h.diff.match(/^@@/gm) ?? []).length, 0);
      return files > 1 ? "multi-file" : hunks > 1 ? "multi-hunk" : "single-hunk";
    }),
    premiseEffectPairs: Object.fromEntries(
      Object.keys(LATTICES).map((p) => [p, tally((i) => `${i.premise.value}->${i.groundTruthEffect.value}`, items.filter((i) => i.premise.predicate === p))]),
    ),
  };
  return {
    name: "Keel S17b premise/effect evaluation set",
    note: "Effects are derived from each diff (by hand for s17 and forge-lite, by the template that drew the code for synthetic items); labels are computed on the lattices below and never come from the model under test. The build rejects any item whose state or question contains its own answer.",
    lattices: Object.fromEntries(Object.entries(LATTICES).map(([p, l]) => [p, { relation: l.relation, order: l.values }])),
    composition,
    items,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ds = buildDataset();
  writeFileSync(out, JSON.stringify(ds, null, 2) + "\n");
  const { premiseEffectPairs: _pairs, byPredicate, ...rest } = ds.composition;
  console.log(JSON.stringify(rest, null, 1));
  for (const [p, v] of Object.entries(byPredicate)) console.log(`${p.padEnd(12)} contra ${v.contradiction}  compat ${v.compatible}  decoy ${v.decoy}  effects ${JSON.stringify(v.effectValues)}`);
}
