import { canonicalJson, type ChangeId, type NextAction, type ProjectId } from "../kernel/index.ts";
import type { Intent } from "./change.ts";
import { canonicalProposition } from "./claim.ts";
import { AlternativeDeclared, AlternativeLanded } from "./events.ts";
import type { LiveChange } from "./graph.ts";
import type { Proposition } from "./proposition.ts";

/**
 * The claim a proposition makes, as a key: its subject, predicate, relation,
 * value (a bound's unit with it) and scope, in canonical form, so an ordering
 * named from either end is one claim. Anchors, gloss, strength and citations
 * say where and how firmly, not what, and are left out.
 */
export const claimKey = (p: Proposition): string => {
  const c = canonicalProposition(p);
  return canonicalJson({
    subject: c.subject,
    predicate: c.predicate,
    relation: c.relation,
    value: c.value,
    unit: c.unit ?? null,
    scope: c.scope ?? null,
  });
};

const claimsOf = (intent: Intent): ReadonlySet<string> =>
  new Set((intent.declaredEffects ?? []).map(claimKey));

/**
 * The claims an intent's declared effects make, each once and sorted: equal
 * for two intents exactly when they make the same claims, so its alternatives
 * are found by it. Empty when the intent declares no effects.
 */
export const claimSetOf = (intent: Intent): readonly string[] => [...claimsOf(intent)].toSorted();

/**
 * Whether two intents attempt the same thing: their declared effects make the
 * same claims, as non-empty sets. Order and repeats do not matter. A partial
 * overlap is not an alternative (the two are neighbours, and may contradict),
 * and an intent that declares no effects is no one's alternative.
 */
export const areAlternatives = (a: Intent, b: Intent): boolean => {
  const mine = claimsOf(a);
  const theirs = claimsOf(b);
  return mine.size > 0 && mine.size === theirs.size && [...mine].every((c) => theirs.has(c));
};

/**
 * The live changes with the same intent as this one: never the change itself,
 * and in the order they were given. Keel knows about them and shows them to
 * each other; it never ranks them or picks one.
 */
export const alternativesOf = (
  self: ChangeId,
  intent: Intent,
  live: readonly LiveChange[],
): readonly ChangeId[] =>
  live.filter((l) => l.id !== self && areAlternatives(intent, l.intent)).map((l) => l.id);

/** What the agent of `changeId` can do about the other change: compare the two, rebase, or withdraw. */
const waysForward = (changeId: ChangeId, other: ChangeId): readonly NextAction[] => [
  {
    kind: "read",
    title: "Read the other change: its intent, its state and its evidence",
    operationId: "change",
    args: { changeId: other },
  },
  {
    kind: "read",
    title: "Read what is near your change, the other change included",
    operationId: "nearby",
    args: { changeId },
  },
  {
    kind: "call",
    title: "Rebase your change onto trunk as it is now",
    operationId: "rebase",
    args: { changeId },
  },
  {
    kind: "call",
    title: "Withdraw your change",
    operationId: "abandon",
    args: { changeId },
  },
];

/** The notice for `changeId`'s agent that `alternativeId` was declared with the same intent. */
export const alternativeDeclared = (
  projectId: ProjectId,
  changeId: ChangeId,
  alternativeId: ChangeId,
): typeof AlternativeDeclared.Type =>
  AlternativeDeclared.make({
    projectId,
    changeId,
    alternativeId,
    nextActions: waysForward(changeId, alternativeId),
  });

/** The notice for `changeId`'s agent that `landedChangeId`, a change with the same intent, landed. */
export const alternativeLanded = (
  projectId: ProjectId,
  changeId: ChangeId,
  landedChangeId: ChangeId,
): typeof AlternativeLanded.Type =>
  AlternativeLanded.make({
    projectId,
    changeId,
    landedChangeId,
    nextActions: waysForward(changeId, landedChangeId),
  });
