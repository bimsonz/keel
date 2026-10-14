// What Keel writes by its ids, called as the console calls it. Keel names a lane by an address of its own and
// names things by their ids in the sentences it writes; a code host shows the one by its name and links the other.

import type { World } from "./world.ts";

/**
 * A lane's name: Keel addresses a lane `lane:<projectId>:<name>`, and a project's one lane is `main`. An id of
 * any other form is shown as Keel wrote it.
 */
export function laneName(laneId: string): string {
  const parts = /^lane:[^:]+:(.+)$/.exec(laneId);
  return parts?.[1] ?? laneId;
}

/** The things a sentence of Keel's can name that the console has a name for. */
export type Referred = "change" | "conflict" | "escalation" | "decision" | "guard";

const KINDS: Readonly<Record<string, Referred>> = {
  chg: "change",
  cfl: "conflict",
  esc: "escalation",
  dec: "decision",
  grd: "guard",
};

/** Keel's id: the kind's three letters, an underscore and a ULID. */
const ID = /\b(chg|cfl|esc|dec|grd)_[0-9A-HJKMNP-TV-Z]{26}\b/g;

/** A thing a sentence names, by Keel's id, with the label Keel gave it in this project's log. */
export interface Reference {
  kind: Referred;
  id: string;
  label: string;
}

/** The labels of everything in a project's log a sentence of Keel's can name, by id. */
export function referencesIn(world: World): ReadonlyMap<string, Reference> {
  const known = new Map<string, Reference>();
  const add = (
    kind: Referred,
    entries: ReadonlyMap<string, { id: string; label: string }>,
  ): void => {
    for (const entry of entries.values())
      if (entry.label !== "") known.set(entry.id, { kind, id: entry.id, label: entry.label });
  };
  add("change", world.changes);
  add("conflict", world.conflicts);
  add("escalation", world.escalations);
  add("decision", world.decisions);
  add("guard", world.guards);
  return known;
}

/** An id a sentence names, and where in the sentence it is. */
export interface Named extends Reference {
  at: number;
}

/**
 * A sentence of Keel's in pieces: its own words, and each id it names that the log has a label for. An id the
 * log does not hold, or holds as another kind than its prefix says, stays in the words as Keel wrote it.
 */
export function piecesOf(text: string, known: ReadonlyMap<string, Reference>): (string | Named)[] {
  const pieces: (string | Named)[] = [];
  let from = 0;
  for (const match of text.matchAll(ID)) {
    const reference = known.get(match[0]);
    if (reference === undefined || reference.kind !== KINDS[match[1] ?? ""]) continue;
    if (match.index > from) pieces.push(text.slice(from, match.index));
    pieces.push({ ...reference, at: match.index });
    from = match.index + match[0].length;
  }
  if (from < text.length) pieces.push(text.slice(from));
  return pieces;
}
