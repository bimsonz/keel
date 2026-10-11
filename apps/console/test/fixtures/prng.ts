// A small seeded PRNG with keyed streams. Everything the mock produces comes
// from here, so one seed always gives the same swarm, the same log, the same
// screenshot. Keyed forks mean editing one part of a script does not reshuffle
// the rest.

/** FNV-1a over a string, to 32 bits. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T;
  /** One index, with probability proportional to its weight. */
  weighted(weights: readonly number[]): number;
  /** An independent stream, named by `key`. */
  fork(key: string): Rng;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    },
    weighted: (weights) => {
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let roll = next() * total;
      for (let i = 0; i < weights.length; i += 1) {
        roll -= weights[i] ?? 0;
        if (roll < 0) return i;
      }
      return weights.length - 1;
    },
    fork: (key) => createRng((seed ^ hash32(key)) >>> 0),
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 26-character Crockford base32 string: the shape of a ULID, drawn from the stream. */
export function ulid(rng: Rng): string {
  let out = "01K";
  for (let i = 0; i < 23; i += 1) out += CROCKFORD[rng.int(0, 31)];
  return out;
}

/**
 * A real ULID for a given instant: 48 bits of milliseconds, then 80 bits from
 * the stream. Ids minted later sort later, as Keel's own do.
 */
export function ulidAt(epochMs: number, rng: Rng): string {
  let time = "";
  let rest = Math.floor(epochMs);
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  let random = "";
  for (let i = 0; i < 16; i += 1) random += CROCKFORD[rng.int(0, 31)];
  return time + random;
}
