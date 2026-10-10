import { type EntityRef, EventEnvelope, Instant, makeId } from "@keeltown/core/kernel";
import { type Backlog, type DueDeliveries, envelopesFor, EVERY_TYPE, EventOutbox, type PriorCommit } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import { monotonicFactory } from "ulid";

/**
 * The outbox's tables, created by the Durable Object's composition inside
 * `blockConcurrencyWhile`:
 * - `keel_events`: each entity's events, numbered gap-free; the log replay reads.
 * - `keel_subscriptions`: who is owed which event types from now on.
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
  sql.exec("CREATE INDEX IF NOT EXISTS keel_events_by_cause ON keel_events (entity_kind, entity_id, cause)");
  sql.exec("CREATE TABLE IF NOT EXISTS keel_subscriptions (subscriber TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (subscriber, type))");
  sql.exec(`CREATE TABLE IF NOT EXISTS keel_deliveries (
    position INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, subscriber TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, UNIQUE (event_id, subscriber))`);
  sql.exec("CREATE INDEX IF NOT EXISTS keel_deliveries_by_subscriber ON keel_deliveries (subscriber, position)");
  sql.exec("CREATE TABLE IF NOT EXISTS keel_received (dedupe_key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
}

const decodeEnvelope = (json: string): EventEnvelope => Schema.decodeUnknownSync(EventEnvelope)(JSON.parse(json));
const encodeEnvelope = (envelope: EventEnvelope): string => JSON.stringify(Schema.encodeSync(EventEnvelope)(envelope));

/**
 * EventOutbox on the Durable Object's own SQLite. Synchronous throughout, so
 * `append` joins the transaction that writes the state: the events, their
 * `seq` and the deliveries they owe commit with it or not at all.
 */
export function EventOutboxSql(storage: DurableObjectStorage) {
  const sql = storage.sql;
  const nextUlid = monotonicFactory();

  const subscribers = (type: string): readonly string[] =>
    sql
      .exec<{ subscriber: string }>("SELECT DISTINCT subscriber FROM keel_subscriptions WHERE type = ? OR type = ? ORDER BY subscriber", type, EVERY_TYPE)
      .toArray()
      .map((row) => row.subscriber);

  return Layer.succeed(
    EventOutbox,
    EventOutbox.of({
      append: (spec, at, drafts) => {
        const head = sql
          .exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM keel_events WHERE entity_kind = ? AND entity_id = ?", spec.entity.kind, spec.entity.id)
          .one().seq ?? 0;
        const envelopes = envelopesFor(spec, at, head, drafts, () => makeId("evt", nextUlid(at)), subscribers);
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
            sql.exec("INSERT INTO keel_deliveries (event_id, subscriber, next_at) VALUES (?, ?, ?)", envelope.eventId, subscriber, at);
          }
        }
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
          .exec<{ envelope: string }>("SELECT envelope FROM keel_events WHERE entity_kind = ? AND entity_id = ? ORDER BY seq", entity.kind, entity.id)
          .toArray()
          .map((row) => decodeEnvelope(row.envelope)),
      subscribe: (subscriber, types) => {
        for (const type of types === EVERY_TYPE ? [EVERY_TYPE] : types) {
          sql.exec("INSERT INTO keel_subscriptions (subscriber, type) VALUES (?, ?) ON CONFLICT DO NOTHING", subscriber, type);
        }
      },
      unsubscribe: (subscriber, types) => {
        if (types === undefined || types === EVERY_TYPE) {
          sql.exec("DELETE FROM keel_subscriptions WHERE subscriber = ?", subscriber);
          return;
        }
        for (const type of types) sql.exec("DELETE FROM keel_subscriptions WHERE subscriber = ? AND type = ?", subscriber, type);
      },
      subscribers,
      receive: (dedupeKey, at) =>
        sql.exec("INSERT INTO keel_received (dedupe_key, at) VALUES (?, ?) ON CONFLICT DO NOTHING", dedupeKey, at).rowsWritten > 0,
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
        for (const eventId of eventIds) sql.exec("DELETE FROM keel_deliveries WHERE subscriber = ? AND event_id = ?", subscriber, eventId);
      },
      defer: (subscriber, eventIds, attempts, nextAttemptAt) => {
        for (const eventId of eventIds) {
          sql.exec("UPDATE keel_deliveries SET attempts = ?, next_at = ? WHERE subscriber = ? AND event_id = ?", attempts, nextAttemptAt, subscriber, eventId);
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
          .map((row): Backlog => ({ subscriber: row.subscriber, pending: row.pending, attempts: row.attempts, nextAttemptAt: Instant(row.next_at) })),
    }),
  );
}
