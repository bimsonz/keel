import { toHex } from "./crypto.ts";

export type IdKind = "usr" | "ses" | "repo";

export interface IdGenerator {
  /** A fresh identifier for a stored entity, such as `usr_…`. */
  id(kind: IdKind): string;
  /** A fresh unguessable secret, used for session tokens and password salts. */
  secret(): string;
}

/** Random identifiers and secrets for real use. Nothing is generated until asked. */
export function randomIds(): IdGenerator {
  return {
    id: (kind) => `${kind}_${crypto.randomUUID().replaceAll("-", "")}`,
    secret: () => toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
}

/**
 * Predictable identifiers (`usr_1`, `usr_2`, `repo_1`, ...) for tests. Every
 * generator starts from 1, so two apps built in the same test run hand out the
 * same identifiers; anything keyed by identifier must be scoped to its app.
 */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  const next = (kind: string): string => {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return `${kind}_${n}`;
  };
  return {
    id: (kind) => next(kind),
    secret: () => next("secret"),
  };
}
