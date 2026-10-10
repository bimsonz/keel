import { readFile } from "node:fs/promises";

export interface Change {
  id: string;
  paths: string[];
}

export function overlaps(a: Change, b: Change): boolean {
  return a.paths.some((p) => b.paths.includes(p));
}

export async function load(path: string): Promise<Change[]> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Change[];
}

const byId = (xs: Change[]) => new Map(xs.map((x) => [x.id, x]));

export class Queue<T> {
  private items: T[] = [];
  push(item: T): void {
    this.items.push(item);
  }
  pop(): T | undefined {
    return this.items.shift();
  }
  get size(): number {
    return this.items.length;
  }
}

export const conflicts = function (xs: Change[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (overlaps(xs[i], xs[j])) out.push([xs[i].id, xs[j].id]);
    }
  }
  return out;
};

function* ids(xs: Change[]): Generator<string> {
  for (const x of xs) yield x.id;
}

export { byId, ids };
