import { SubjectKey } from "./proposition.ts";

/**
 * Subject keys are hierarchical: `authz.permission-evaluation` sits under
 * `authz`, and a proposition about a subject holds for every subject beneath it.
 */

export const subjectSegments = (key: SubjectKey): readonly string[] => key.split(".");

export const parentSubject = (key: SubjectKey): SubjectKey | undefined => {
  const cut = key.lastIndexOf(".");
  return cut === -1 ? undefined : SubjectKey.make(key.slice(0, cut));
};

/** Proper ancestors, nearest first. */
export const subjectAncestors = (key: SubjectKey): readonly SubjectKey[] => {
  const parent = parentSubject(key);
  return parent === undefined ? [] : [parent, ...subjectAncestors(parent)];
};

export const isAncestorOrSelf = (ancestor: SubjectKey, key: SubjectKey): boolean =>
  ancestor === key || key.startsWith(`${ancestor}.`);

/** On one ancestor chain, in either direction: the two can speak about the same thing. */
export const subjectsRelated = (a: SubjectKey, b: SubjectKey): boolean =>
  isAncestorOrSelf(a, b) || isAncestorOrSelf(b, a);

/** Distinct children of one parent: proximity, never a comparison. */
export const subjectsSiblings = (a: SubjectKey, b: SubjectKey): boolean => {
  const parent = parentSubject(a);
  return a !== b && parent !== undefined && parent === parentSubject(b);
};
