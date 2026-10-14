import { EntityStore, type Stored } from "@keeltown/core/ports";
import { Layer } from "effect";

/** The table every Durable Object keeps its entities in. Created by `migrateEntityStore`, inside `blockConcurrencyWhile`. */
export function migrateEntityStore(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id))",
  );
}

/**
 * The least id above every id that starts with `prefix`, in SQLite's order
 * (code points): the prefix with its last character one code point higher,
 * skipping the surrogates. Undefined after the last code point or a lone
 * surrogate: the range is then open above, and the prefix test bounds it.
 */
function aboveEvery(prefix: string): string | undefined {
  const [, head = "", last = ""] = /^([\s\S]*)([\s\S])$/u.exec(prefix) ?? [];
  const point = last.codePointAt(0);
  if (point === undefined || point === 0x10ffff || (point >= 0xd800 && point < 0xe000))
    return undefined;
  return head + String.fromCodePoint(point === 0xd7ff ? 0xe000 : point + 1);
}

type Row = { id: string; value: string };

const rowOf = (row: Row) => ({ id: row.id, value: JSON.parse(row.value) satisfies Stored });

/**
 * EntityStore on the Durable Object's own SQLite. Every call is synchronous, so
 * a decision path reads, decides and writes inside one `transactionSync` with
 * no `await` in between. A list by prefix reads a range of the primary key.
 */
export function EntityStoreSql(storage: DurableObjectStorage) {
  const sql = storage.sql;
  const range = (kind: string, prefix: string) => {
    const above = aboveEvery(prefix);
    const rows =
      above === undefined
        ? sql.exec<Row>(
            "SELECT id, value FROM entities WHERE kind = ? AND id >= ? ORDER BY id",
            kind,
            prefix,
          )
        : sql.exec<Row>(
            "SELECT id, value FROM entities WHERE kind = ? AND id >= ? AND id < ? ORDER BY id",
            kind,
            prefix,
            above,
          );
    return rows
      .toArray()
      .filter((row) => row.id.startsWith(prefix))
      .map(rowOf);
  };
  return Layer.succeed(
    EntityStore,
    EntityStore.of({
      get: (kind, id) => {
        const row = sql
          .exec<{ value: string }>("SELECT value FROM entities WHERE kind = ? AND id = ?", kind, id)
          .toArray()[0];
        return row === undefined ? undefined : (JSON.parse(row.value) satisfies Stored);
      },
      put: (kind, id, value) => {
        sql.exec(
          "INSERT INTO entities (kind, id, value) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value",
          kind,
          id,
          JSON.stringify(value),
        );
      },
      remove: (kind, id) => {
        sql.exec("DELETE FROM entities WHERE kind = ? AND id = ?", kind, id);
      },
      list: (kind, idPrefix) =>
        idPrefix === undefined || idPrefix === ""
          ? sql
              .exec<Row>("SELECT id, value FROM entities WHERE kind = ? ORDER BY id", kind)
              .toArray()
              .map(rowOf)
          : range(kind, idPrefix),
      transaction: (body) => storage.transactionSync(body),
    }),
  );
}
