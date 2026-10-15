// What a change is about, and what a subject says beside its key, read off the
// folded world for the pages that name a subject.

import type { ChangeEntry } from "./world.ts";

export type Tone = "plain" | "suspected" | "proven" | "person" | "pass";

/** Every subject a change touches, each once: those it relies on, then those it alters. */
export function subjectsOf(change: ChangeEntry): string[] {
  return [
    ...new Set([
      ...change.premises.map((premise) => premise.subject),
      ...change.effects.map((effect) => effect.proposition.subject),
    ]),
  ];
}

/** The subject a change is about: the one it relies on, or else the one its first effect is on. */
export function subjectOf(change: ChangeEntry): string | undefined {
  return subjectsOf(change)[0];
}

/** What a subject's gloss says beside its key: nothing where Keel glossed it with the key itself. */
export function glossOf(subject: { key: string; gloss: string }): string {
  return subject.gloss.trim() === subject.key ? "" : subject.gloss;
}
