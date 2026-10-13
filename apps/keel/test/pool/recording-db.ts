// A D1 database that remembers what its statements answered, for a test of
// what a query returned where the response alone cannot say: a list that
// hides a row the policy refused looks the same as one that never read it.

/** One read's statement and what D1 says it cost. */
export interface RecordedRead {
  readonly sql: string;
  readonly rowsRead: number;
}

/**
 * `db`, recording every row `all()` and `first()` answer, and each `all()`'s
 * `rows_read`. Writes and everything else pass through.
 */
export function recordingDb(db: D1Database) {
  const rows: unknown[] = [];
  const reads: RecordedRead[] = [];
  const real = new WeakMap<object, D1PreparedStatement>();
  const recorded = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => recorded(sql, target.bind(...values));
        if (key === "all")
          return async () => {
            const answer = await target.all();
            rows.push(...answer.results);
            reads.push({ sql, rowsRead: answer.meta.rows_read });
            return answer;
          };
        if (key === "first")
          return async (column?: string) => {
            const row = column === undefined ? await target.first() : await target.first(column);
            if (row !== null) rows.push(row);
            return row;
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, statement);
    return proxy;
  };
  const recording = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => recorded(sql, target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          target.batch(statements.map((statement) => real.get(statement) ?? statement));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: recording, rows, reads };
}
