import { literalPrefix } from "../kernel/index.ts";
import { claimSetOf } from "./alternatives.ts";
import type { Intent } from "./change.ts";
import { anchorPathsOf, intentPropositions, livePropositions } from "./exposure.ts";
import type { LiveChange } from "./graph.ts";
import type { SubjectKey } from "./proposition.ts";
import { parentSubject, subjectAncestors } from "./subject.ts";

/**
 * Where a footprint glob is found: its literal segments before its first
 * wildcard, and a path with none all of its segments. Two globs overlap
 * (`globsMayOverlap`) only where one's prefix is an ancestor-or-self of the
 * other's, so a glob is near every glob found at, above or beneath its own.
 * A glob that starts with a wildcard is found at the root, near every glob.
 */
export const footprintPrefix = (glob: string): readonly string[] => literalPrefix(glob);

/**
 * The keys a live change is found by, one kind for each of exposure's
 * reasons, so a preflight reads the changes near its intent instead of every
 * live one. Each finds at least every change its reason could name:
 * - `subjects`: each subject the change states, holding it, and each of their
 *   ancestors, not holding unless the change states that one too;
 * - `footprints`: each footprint glob's prefix (`footprintPrefix`);
 * - `anchors`: each path its propositions are anchored at;
 * - `claims`: the claims its declared effects make (`claimSetOf`), shared by
 *   its alternatives; empty when it declares none.
 */
export type NearKeys = {
  readonly subjects: ReadonlyMap<SubjectKey, boolean>;
  readonly footprints: readonly (readonly string[])[];
  readonly anchors: readonly string[];
  readonly claims: readonly string[];
};

/** The keys a live change is found by: of its premises, declared and derived effects, as exposure reads them. */
export const nearKeysOf = (live: LiveChange): NearKeys => {
  const stated = livePropositions(live);
  const subjects = new Map<SubjectKey, boolean>();
  for (const { subject } of stated) subjects.set(subject, true);
  for (const { subject } of stated)
    for (const ancestor of subjectAncestors(subject))
      if (!subjects.has(ancestor)) subjects.set(ancestor, false);
  return {
    subjects,
    footprints: live.intent.footprint.map((entry) => footprintPrefix(entry.path)),
    anchors: [...anchorPathsOf(stated)],
    claims: claimSetOf(live.intent),
  };
};

/**
 * What a preflight of an intent looks up, among the keys `nearKeysOf` finds
 * live changes by, to find every change exposure could name:
 * - `around`: subjects read whole, each of my subjects' parent (my subject,
 *   its descendants and its siblings all sit at it, since every change sits
 *   at each ancestor of what it states), or a top-level subject itself;
 * - `holding`: my subjects' other ancestors, read for the changes that state
 *   that ancestor itself;
 * - `footprints`: my footprint prefixes, each read at itself, at each of its
 *   ancestors and beneath it;
 * - `anchors`: the paths my propositions are anchored at;
 * - `claims`: my claim set, read when I declare effects, for my alternatives.
 */
export type NearLookups = {
  readonly around: readonly SubjectKey[];
  readonly holding: readonly SubjectKey[];
  readonly footprints: readonly (readonly string[])[];
  readonly anchors: readonly string[];
  readonly claims: readonly string[];
};

/** What a preflight of `intent` looks up: of its premises and declared effects, as exposure compares them. */
export const nearLookupsOf = (intent: Intent): NearLookups => {
  const mine = intentPropositions(intent);
  const around = new Set(mine.map(({ subject }) => parentSubject(subject) ?? subject));
  const holding = new Set(
    mine.flatMap(({ subject }) => subjectAncestors(subject)).filter((key) => !around.has(key)),
  );
  return {
    around: [...around],
    holding: [...holding],
    footprints: intent.footprint.map((entry) => footprintPrefix(entry.path)),
    anchors: [...anchorPathsOf(mine)],
    claims: claimSetOf(intent),
  };
};
