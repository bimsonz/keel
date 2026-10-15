// A question Keel put to a person about two changes, in words a person rules on at a glance: who relies on what,
// who changes it, and for each answer what it does to which change. Keel's own option ids are kept as captions.

import type { EscalationEntry, World } from "./world.ts";

interface Proposition {
  subject: string;
  predicate: string;
  relation?: string | undefined;
  value?: unknown;
  gloss?: string | undefined;
}

/** A change the question is about: its number, its goal and its id. */
export interface Party {
  changeId: string;
  label: string;
  goal: string;
}

export interface RulingWords {
  /** The question as a title. */
  title: string;
  /** The change that relies on the premise, and what it relies on. */
  relies?: Party & { on: string };
  /** The change whose effect contradicts it, and what it does. */
  changes?: Party & { does: string };
  /** Each answer Keel offers, in Keel's order: what it says, and Keel's id for it as a caption. */
  options: { id: string; label: string; consequence: string }[];
}

/** The last part of a subject's key, which is what its code calls it: `swarm.r1.allows` is `allows`. */
const shortOf = (subject: string): string => subject.split(".").at(-1) ?? subject;

const isPure = (p: Proposition): boolean => p.predicate === "purity" && p.value === true;

function premiseSaid(p: Proposition): string {
  const name = shortOf(p.subject);
  if (isPure(p)) return `${name} having no side effects`;
  return `${name}: ${p.predicate} ${p.relation ?? "is"} ${String(p.value)}`;
}

function effectSaid(p: Proposition): string {
  const name = shortOf(p.subject);
  if (p.gloss !== undefined && p.gloss !== "") return p.gloss;
  if (p.predicate === "purity" && p.value === false) return `adds a side effect to ${name}`;
  return `makes ${name}: ${p.predicate} ${p.relation ?? "is"} ${String(p.value)}`;
}

function partyOf(world: World, changeId: string): Party {
  const change = world.changes.get(changeId);
  return { changeId, label: change?.label ?? changeId.slice(-4), goal: change?.goal ?? "" };
}

export function rulingWords(world: World, escalation: EscalationEntry): RulingWords {
  const conflict =
    escalation.about.kind === "conflict" ? world.conflicts.get(escalation.about.id) : undefined;
  const premise = conflict?.premise;
  const effect = conflict?.effect;
  const [first, second] = conflict?.parties ?? [];
  const holder =
    premise?.holder.startsWith("chg_") === true
      ? premise.holder
      : (conflict?.parties.find((id) => id !== effect?.changeId) ?? first);
  const relies =
    premise === undefined || holder === undefined
      ? undefined
      : { ...partyOf(world, holder), on: premiseSaid(premise.proposition) };
  const changerId = effect?.changeId ?? second;
  const changes =
    effect === undefined || changerId === undefined
      ? undefined
      : { ...partyOf(world, changerId), does: effectSaid(effect.proposition) };
  const name = premise === undefined ? undefined : shortOf(premise.proposition.subject);
  const pure = premise !== undefined && isPure(premise.proposition);
  const title =
    premise === undefined || name === undefined
      ? escalation.question
      : pure
        ? `Can ${name} stay pure?`
        : `Does ${premiseSaid(premise.proposition)} hold?`;
  const options = escalation.options.map((option) => {
    if (option.id === "premise-holds" && changes !== undefined)
      return {
        id: option.id,
        label: `${pure ? `Keep ${name} pure` : "Keep the premise"} · ${changes.label} reworks`,
        consequence: option.consequence,
      };
    if (option.id === "effect-stands" && changes !== undefined && relies !== undefined)
      return {
        id: option.id,
        label: `Accept ${changes.label} · ${relies.label} adapts`,
        consequence: option.consequence,
      };
    return { id: option.id, label: option.label, consequence: option.consequence };
  });
  return {
    title,
    ...(relies === undefined ? {} : { relies }),
    ...(changes === undefined ? {} : { changes }),
    options,
  };
}
