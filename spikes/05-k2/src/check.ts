// Per-entity ordering and duplicate checker for consumed ops-log records.
//
// Every record carries a unique id and a per-entity sequence number assigned by the
// producer. Within one subscription read by one worker_id, the projector expects each
// entity's seq to arrive as exactly last + 1. The checker reports:
//   dup     - an id that was already seen (at-least-once redelivery, producer retry)
//   regress - seq <= last seen seq for the entity, with a new id (out of order)
//   gap     - seq > last + 1 (a record skipped or arriving early)
// `baselineFromFirst` accepts any seq as the first one per entity (a subscription
// created at `latest` starts mid-stream); otherwise the first seq must be 1.

export type Obs = { id: string; entity: string; seq: number };
export type Finding = { kind: "dup" | "regress" | "gap"; id: string; entity: string; seq: number; expected: number };

export type CheckState = {
  last: Map<string, number>;
  seen: Set<string>;
  baselineFromFirst: boolean;
};

export const newState = (baselineFromFirst: boolean): CheckState => ({
  last: new Map(),
  seen: new Set(),
  baselineFromFirst,
});

export function check(batch: readonly Obs[], st: CheckState): Finding[] {
  const out: Finding[] = [];
  for (const r of batch) {
    if (st.seen.has(r.id)) {
      out.push({ kind: "dup", id: r.id, entity: r.entity, seq: r.seq, expected: (st.last.get(r.entity) ?? 0) + 1 });
      continue;
    }
    st.seen.add(r.id);
    const prev = st.last.get(r.entity);
    if (prev === undefined && st.baselineFromFirst) {
      st.last.set(r.entity, r.seq);
      continue;
    }
    const last = prev ?? 0;
    if (r.seq <= last) out.push({ kind: "regress", id: r.id, entity: r.entity, seq: r.seq, expected: last + 1 });
    else if (r.seq !== last + 1) out.push({ kind: "gap", id: r.id, entity: r.entity, seq: r.seq, expected: last + 1 });
    st.last.set(r.entity, Math.max(last, r.seq));
  }
  return out;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] as number;
}

export function summarise(values: readonly number[]) {
  const s = values.toSorted((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? Number.NaN,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.at(-1) ?? Number.NaN,
    mean: s.length ? Math.round((sum / s.length) * 100) / 100 : Number.NaN,
  };
}
