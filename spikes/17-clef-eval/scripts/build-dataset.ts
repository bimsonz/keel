// Builds docs/spikes/s17-dataset.json from dataset/items.ts and dataset/diffs.
// Hunk headers are recomputed from the hunk bodies, Go indentation becomes
// tabs, and every label is recomputed on the lattice and must match.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEMS } from "../dataset/items.ts";
import { LATTICES, compare, type Premise } from "../src/lattice.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "..", "..", "docs", "spikes", "s17-dataset.json");

const LANG: Record<string, string> = {
  ".ts": "typescript", ".js": "javascript", ".py": "python", ".go": "go", ".c": "c", ".h": "c", ".tf": "hcl", ".sql": "sql",
};

export interface Hunk { file: string; language: string; diff: string }

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

export function buildDataset() {
  const items = ITEMS.map((spec) => {
    const premise: Premise = {
      subject: spec.subject,
      predicate: spec.predicate,
      relation: LATTICES[spec.predicate].relation,
      value: spec.value,
      scope: spec.scope,
    };
    const computed = compare(premise, spec.effect);
    if (computed !== spec.label) throw new Error(`${spec.id}: lattice says ${computed}, written label is ${spec.label}`);
    const hunks = parseDiff(readFileSync(join(pkg, "dataset", "diffs", `${spec.id}.diff`), "utf8"));
    return {
      id: spec.id,
      kind: spec.kind,
      ...(spec.decoyType ? { decoyType: spec.decoyType } : {}),
      ...(spec.tags ? { tags: spec.tags } : {}),
      premise,
      change: {
        hunks,
        symbols: spec.symbols.map(([name, kind, file, status]) => ({ name, kind, file, status })),
      },
      groundTruthEffect: { subject: spec.subject, predicate: spec.predicate, value: spec.effect },
      label: computed,
      reason: spec.reason,
    };
  });
  const count = (f: (i: (typeof items)[number]) => boolean) => items.filter(f).length;
  const composition = {
    total: items.length,
    core: count((i) => i.kind === "core"),
    coreContradiction: count((i) => i.kind === "core" && i.label === "contradiction"),
    coreCompatible: count((i) => i.kind === "core" && i.label === "compatible"),
    decoys: count((i) => i.kind === "decoy"),
    decoySameSubjectCompatible: count((i) => i.decoyType === "same-subject-compatible"),
    decoyDifferentSubject: count((i) => i.decoyType === "different-subject"),
    byPredicate: Object.fromEntries(
      Object.keys(LATTICES).map((p) => [
        p,
        {
          contradiction: count((i) => i.premise.predicate === p && i.label === "contradiction"),
          compatible: count((i) => i.premise.predicate === p && i.kind === "core" && i.label === "compatible"),
          decoy: count((i) => i.premise.predicate === p && i.kind === "decoy"),
        },
      ]),
    ),
    byPrimaryLanguage: items.reduce<Record<string, number>>((acc, i) => {
      const lang = i.change.hunks.find((h) => h.language !== "sql")!.language;
      acc[lang] = (acc[lang] ?? 0) + 1;
      return acc;
    }, {}),
  };
  return {
    name: "Keel S17 premise/effect evaluation set",
    note: "Effects are hand-derived from each diff; labels are computed on the lattices below and never come from the models under test.",
    lattices: Object.fromEntries(
      Object.entries(LATTICES).map(([p, l]) => [p, { relation: l.relation, order: l.values }]),
    ),
    composition,
    items,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ds = buildDataset();
  writeFileSync(out, JSON.stringify(ds, null, 2) + "\n");
  console.log(JSON.stringify(ds.composition, null, 1));
}
