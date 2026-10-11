// Reading one of Keel's lattices: a predicate's values, and the covers that
// order them. Keel compares propositions; the console only draws where two of
// them sit, and only when the lattice puts them on one line.

import type { Lattice } from "../contract/keel/index.ts";

/** The lattice value a proposition's value is: itself, or the family it is a member of (`ttl:300` is one of `ttl:<n>`). */
export function valueIdOf(lattice: Lattice, value: string): string | undefined {
  if (lattice.values.some((candidate) => candidate.id === value)) return value;
  return lattice.values.find(
    (candidate) => candidate.family !== undefined && value.startsWith(`${candidate.family.name}:`),
  )?.id;
}

/**
 * One line through a lattice that holds every value asked for, least first: a path up its covers from a
 * bottom to a top. Null when the values are not all on one line. That is when the lattice does not rank
 * them, and only a probe can say.
 */
export function chainThrough(lattice: Lattice, values: readonly string[]): string[] | null {
  const ids = values.map((value) => valueIdOf(lattice, value));
  if (lattice.covers.length === 0 || ids.includes(undefined)) return null;
  const above = new Map<string, string[]>();
  for (const cover of lattice.covers)
    above.set(cover.lower, [...(above.get(cover.lower) ?? []), cover.upper]);
  const covered = new Set(lattice.covers.map((cover) => cover.upper));
  const bottoms = lattice.values
    .map((value) => value.id)
    .filter((id) => above.has(id) && !covered.has(id));
  const climb = (path: string[]): string[] | null => {
    const next = above.get(path.at(-1) ?? "") ?? [];
    if (next.length === 0)
      return ids.every((id) => id !== undefined && path.includes(id)) ? path : null;
    for (const upper of next) {
      const found = climb([...path, upper]);
      if (found !== null) return found;
    }
    return null;
  };
  for (const bottom of bottoms) {
    const chain = climb([bottom]);
    // A family stands on the line as the member that was asked about.
    if (chain !== null) return chain.map((id) => values[ids.indexOf(id)] ?? id);
  }
  return null;
}
