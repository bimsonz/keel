// Template types for the synthetic items. A family is one subject in one
// language with a sibling subject in the same file. render() draws the code
// for a given subject value and sibling value; an item is the diff between two
// renders. Labels never come from here: the generator records the effect
// value the template realises, and the build computes the label on the lattice.
import type { Predicate } from "../../src/lattice.ts";

export interface Block {
  sym?: [name: string, kind: string];
  code: string;
}
export interface FileSpec {
  path: string;
  blocks: Block[];
}
export interface RenderArgs {
  s: string; // subject value
  sib: string; // sibling value
  trap?: string; // near-miss variant of the subject at value s
}
export interface Trap {
  name: string;
  value: string; // the subject's value after the change
  premise: string; // the premise it is checked against (compatible)
  before: RenderArgs;
  after: RenderArgs;
  why: string;
}
export interface Family {
  id: string;
  predicate: Predicate;
  language: string;
  subject: string;
  scope: string;
  anchor: string; // the subject's main symbol
  values: string[]; // values the subject can take
  sibValues: string[]; // values the sibling can take ([] = no sibling decoys)
  baseline: string; // the sibling's usual value
  mech: Record<string, string>; // one line per subject value, for the reason
  sibMech?: Record<string, string>;
  traps?: Trap[];
  render(a: RenderArgs): FileSpec[];
}

export const b = (text: string, sym?: [string, string]): Block => (sym ? { sym, code: text } : { code: text });

/** Strips the common leading indentation of a template literal and the first/last blank line. */
export function code(strings: TemplateStringsArray, ...vals: unknown[]): string {
  let s = strings.reduce((acc, str, i) => acc + str + (i < vals.length ? String(vals[i]) : ""), "");
  s = s.replace(/^\n/, "").replace(/\n\s*$/, "");
  const lines = s.split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
}
