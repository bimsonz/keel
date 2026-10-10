import { EntityStore, type Stored } from "@keeltown/core/ports";
import { Layer } from "effect";

/** The table every Durable Object keeps its entities in. Created by `migrateEntityStore`, inside `blockConcurrencyWhile`. */
export function migrateEntityStore(storage: DurableObjectStorage): void {
  storage.sql.exec("CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id))");
}

/**
 * EntityStore on the Durable Object's own SQLite. Every call is synchronous, so
 * a decision path reads, decides and writes inside one `transactionSync` with
 * no `await` in between.
 */
export function EntityStoreSql(storage: DurableObjectStorage) {
  const sql = storage.sql;
  return Layer.succeed(
    EntityStore,
    EntityStore.of({
      get: (kind, id) => {
        const row = sql.exec<{ value: string }>("SELECT value FROM entities WHERE kind = ? AND id = ?", kind, id).toArray()[0];
        return row === undefined ? undefined : (JSON.parse(row.value) satisfies Stored);
      },
      put: (kind, id, value) => {
        sql.exec("INSERT INTO entities (kind, id, value) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value", kind, id, JSON.stringify(value));
      },
      remove: (kind, id) => {
        sql.exec("DELETE FROM entities WHERE kind = ? AND id = ?", kind, id);
      },
      list: (kind) =>
        sql.exec<{ id: string; value: string }>("SELECT id, value FROM entities WHERE kind = ? ORDER BY id", kind).toArray().map((row) => ({
          id: row.id,
          value: JSON.parse(row.value) satisfies Stored,
        })),
      transaction: (body) => storage.transactionSync(body),
    }),
  );
}
