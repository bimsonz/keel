import { type EntityRef, EventEnvelope, Instant, makeId } from "@keeltown/core/kernel";
import {
  type Backlog,
  type DueDeliveries,
  envelopesFor,
  type EventAbout,
  EVERY_TYPE,
  EventOutbox,
  type PriorCommit,
  scopeOf,
  spendingOnce,
} from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import { monotonicFactory } from "ulid";

/**
 * The outbox's tables, created by the Durable Object's composition inside
 * `blockConcurrencyWhile`:
 * - `keel_events`: each entity's events, numbered gap-free; the log replay reads.
 * - `keel_subscriptions`: who is owed which event types from now on.
 * - `keel_subscription_scopes`: the same, owed only events about one entity
 *   (its own, or one they affect), as `<kind>:<id>`.
 * - `keel_subscription_once`: subscribers owed only the first event that notifies
 *   them; the append that notifies one drops its subscriptions.
 * - `keel_deliveries`: one row per event and subscriber still owed it, in commit order.
 * - `keel_received`: dedupe keys of events this object has received and reacted to.
 */
export function migrateEventOutbox(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS keel_events (
    entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, seq INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE, dedupe_key TEXT NOT NULL UNIQUE,
    cause TEXT NOT NULL, fingerprint TEXT, envelope TEXT NOT NULL,
    PRIMARY KEY (entity_kind, entity_id, seq))`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS keel_events_by_cause ON keel_events (entity_kind, entity_id, cause)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS keel_subscriptions (subscriber TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (subscriber, type))",
  );
  sql.exec(`CREATE TABLE IF NOT EXISTS keel_deliveries (
    position INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, subscriber TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, UNIQUE (event_id, subscriber))`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS keel_deliveries_by_subscriber ON keel_deliveries (subscriber, position)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS keel_received (dedupe_key TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS keel_subscription_scopes (subscriber TEXT NOT NULL, type TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY (subscriber, type, scope))",
  );
  sql.exec("CREATE TABLE IF NOT EXISTS keel_subscription_once (subscriber TEXT PRIMARY KEY)");
}

const decodeEnvelope = (json: string): EventEnvelope =>
  Schema.decodeUnknownSync(EventEnvelope)(JSON.parse(json));
const encodeEnvelope = (envelope: EventEnvelope): string =>
  JSON.stringify(Schema.encodeSync(EventEnvelope)(envelope));

/**
 * EventOutbox on the Durable Object's own SQLite. Synchronous throughout, so
 * `append` joins the transaction that writes the state: the events, their
 * `seq` and the deliveries they owe commit with it or not at all.
 */
export function EventOutboxSql(storage: DurableObjectStorage) {
  const sql = storage.sql;
  const nextUlid = monotonicFactory();

  /** Drops every subscription `subscriber` holds, scoped, unscoped and one-shot. */
  const dropSubscriber = (subscriber: string): void => {
    for (const table of [
      "keel_subscriptions",
      "keel_subscription_scopes",
      "keel_subscription_once",
    ])
      sql.exec(`DELETE FROM ${table} WHERE subscriber = ?`, subscriber);
  };

  const subscribers = (type: string, about?: EventAbout): readonly string[] => {
    const unscoped = sql
      .exec<{ subscriber: string }>(
        "SELECT DISTINCT subscriber FROM keel_subscriptions WHERE type = ? OR type = ?",
        type,
        EVERY_TYPE,
      )
      .toArray();
    const scopes = about === undefined ? [] : [about.entity, ...about.affected].map(scopeOf);
    const scoped =
      scopes.length === 0
        ? []
        : sql
            .exec<{ subscriber: string }>(
              `SELECT DISTINCT subscriber FROM keel_subscription_scopes WHERE (type = ? OR type = ?) AND scope IN (${scopes.map(() => "?").join(", ")})`,
              type,
              EVERY_TYPE,
              ...scopes,
            )
            .toArray();
    return [...new Set([...unscoped, ...scoped].map((row) => row.subscriber))].toSorted();
  };

  /** The entity's last seq, or 0 before its first event. */
  const lastSeq = (entity: EntityRef) =>
    sql
      .exec<{ seq: number | null }>(
        "SELECT MAX(seq) AS seq FROM keel_events WHERE entity_kind = ? AND entity_id = ?",
        entity.kind,
        entity.id,
      )
      .one().seq ?? 0;

  return Layer.succeed(
    EventOutbox,
    EventOutbox.of({
      append: (spec, at, drafts) => {
        const once = new Set(
          sql
            .exec<{ subscriber: string }>("SELECT subscriber FROM keel_subscription_once")
            .toArray()
            .map((row) => row.subscriber),
        );
        const notifying = spendingOnce(subscribers, once);
        const envelopes = envelopesFor(
          spec,
          at,
          lastSeq,
          drafts,
          () => makeId("evt", nextUlid(at)),
          notifying.subscribers,
        );
        for (const envelope of envelopes) {
          sql.exec(
            "INSERT INTO keel_events (entity_kind, entity_id, seq, event_id, dedupe_key, cause, fingerprint, envelope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            envelope.entity.kind,
            envelope.entity.id,
            envelope.seq,
            envelope.eventId,
            envelope.dedupeKey,
            spec.cause,
            spec.fingerprint ?? null,
            encodeEnvelope(envelope),
          );
          for (const subscriber of envelope.notified) {
            sql.exec(
              "INSERT INTO keel_deliveries (event_id, subscriber, next_at) VALUES (?, ?, ?)",
              envelope.eventId,
              subscriber,
              at,
            );
          }
        }
        for (const subscriber of notifying.spent) dropSubscriber(subscriber);
        return envelopes;
      },
      committed: (entity, cause) => {
        const rows = sql
          .exec<{ envelope: string; fingerprint: string | null }>(
            "SELECT envelope, fingerprint FROM keel_events WHERE entity_kind = ? AND entity_id = ? AND cause = ? ORDER BY seq",
            entity.kind,
            entity.id,
            cause,
          )
          .toArray();
        const first = rows[0];
        if (first === undefined) return undefined;
        const prior: PriorCommit = { events: rows.map((row) => decodeEnvelope(row.envelope)) };
        return first.fingerprint === null ? prior : { ...prior, fingerprint: first.fingerprint };
      },
      log: (entity: EntityRef) =>
        sql
          .exec<{ envelope: string }>(
            "SELECT envelope FROM keel_events WHERE entity_kind = ? AND entity_id = ? ORDER BY seq",
            entity.kind,
            entity.id,
          )
          .toArray()
          .map((row) => decodeEnvelope(row.envelope)),
      subscribe: (subscriber, types, scope, options) => {
        if (options?.once === true)
          sql.exec(
            "INSERT INTO keel_subscription_once (subscriber) VALUES (?) ON CONFLICT DO NOTHING",
            subscriber,
          );
        for (const type of types === EVERY_TYPE ? [EVERY_TYPE] : types) {
          if (scope === undefined)
            sql.exec(
              "INSERT INTO keel_subscriptions (subscriber, type) VALUES (?, ?) ON CONFLICT DO NOTHING",
              subscriber,
              type,
            );
          else
            sql.exec(
              "INSERT INTO keel_subscription_scopes (subscriber, type, scope) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
              subscriber,
              type,
              scopeOf(scope),
            );
        }
      },
      unsubscribe: (subscriber, types, scope) => {
        if (scope !== undefined) {
          for (const type of types === undefined || types === EVERY_TYPE ? [undefined] : types)
            if (type === undefined)
              sql.exec(
                "DELETE FROM keel_subscription_scopes WHERE subscriber = ? AND scope = ?",
                subscriber,
                scopeOf(scope),
              );
            else
              sql.exec(
                "DELETE FROM keel_subscription_scopes WHERE subscriber = ? AND type = ? AND scope = ?",
                subscriber,
                type,
                scopeOf(scope),
              );
          return;
        }
        if (types === undefined || types === EVERY_TYPE) {
          dropSubscriber(subscriber);
          return;
        }
        for (const table of ["keel_subscriptions", "keel_subscription_scopes"]) {
          for (const type of types)
            sql.exec(`DELETE FROM ${table} WHERE subscriber = ? AND type = ?`, subscriber, type);
        }
      },
      subscribers,
      receive: (dedupeKey, at) =>
        sql.exec(
          "INSERT INTO keel_received (dedupe_key, at) VALUES (?, ?) ON CONFLICT DO NOTHING",
          dedupeKey,
          at,
        ).rowsWritten > 0,
      due: (now, limit) => {
        const heads = sql
          .exec<{ subscriber: string; attempts: number; next_at: number }>(
            `SELECT d.subscriber, d.attempts, d.next_at FROM keel_deliveries d
             WHERE d.position = (SELECT MIN(position) FROM keel_deliveries h WHERE h.subscriber = d.subscriber)
             ORDER BY d.position`,
          )
          .toArray();
        const due: DueDeliveries[] = [];
        for (const head of heads) {
          if (head.next_at > now) continue;
          const events = sql
            .exec<{ envelope: string }>(
              `SELECT e.envelope FROM keel_deliveries d JOIN keel_events e ON e.event_id = d.event_id
               WHERE d.subscriber = ? ORDER BY d.position LIMIT ?`,
              head.subscriber,
              limit,
            )
            .toArray()
            .map((row) => decodeEnvelope(row.envelope));
          due.push({ subscriber: head.subscriber, attempts: head.attempts, events });
        }
        return due;
      },
      acknowledge: (subscriber, eventIds) => {
        for (const eventId of eventIds)
          sql.exec(
            "DELETE FROM keel_deliveries WHERE subscriber = ? AND event_id = ?",
            subscriber,
            eventId,
          );
      },
      defer: (subscriber, eventIds, attempts, nextAttemptAt) => {
        for (const eventId of eventIds) {
          sql.exec(
            "UPDATE keel_deliveries SET attempts = ?, next_at = ? WHERE subscriber = ? AND event_id = ?",
            attempts,
            nextAttemptAt,
            subscriber,
            eventId,
          );
        }
      },
      backlog: () =>
        sql
          .exec<{ subscriber: string; attempts: number; next_at: number; pending: number }>(
            `SELECT d.subscriber, d.attempts, d.next_at,
               (SELECT COUNT(*) FROM keel_deliveries p WHERE p.subscriber = d.subscriber) AS pending
             FROM keel_deliveries d
             WHERE d.position = (SELECT MIN(position) FROM keel_deliveries h WHERE h.subscriber = d.subscriber)
             ORDER BY d.position`,
          )
          .toArray()
          .map((row): Backlog => ({
            subscriber: row.subscriber,
            pending: row.pending,
            attempts: row.attempts,
            nextAttemptAt: Instant(row.next_at),
          })),
    }),
  );
}
