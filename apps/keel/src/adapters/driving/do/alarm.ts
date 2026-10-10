/**
 * The only way a Durable Object arms an alarm. Keel never polls: an alarm is a
 * **deadline** (a lease lapses, a delivery is retried) or a **debounce**
 * (coalesce a flush or a group commit), and it says which and why. Rule R11
 * holds every other caller to this helper.
 *
 * A Durable Object has one alarm, but may owe several deadlines at once (a
 * Change DO's lease and its outbox's redelivery). Each request is a row keyed
 * by its reason; the platform alarm is always armed for the earliest row.
 */
export interface AlarmRequest {
  readonly kind: "deadline" | "debounce";
  /** What the alarm is for, e.g. `lease lse_… lapses`. One row per reason: arming a reason again moves it. */
  readonly reason: string;
  /** When it fires, in epoch milliseconds. */
  readonly at: number;
}

/** Creates the alarm table. Called by the Durable Object's composition inside `blockConcurrencyWhile`. */
export function migrateAlarms(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS keel_alarms (reason TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL)",
  );
}

const toRequest = (row: { reason: string; kind: string; at: number }): AlarmRequest => ({
  kind: row.kind === "debounce" ? "debounce" : "deadline",
  reason: row.reason,
  at: row.at,
});

/** Arms the platform alarm for the earliest request, or clears it when none is left. */
async function armEarliest(storage: DurableObjectStorage): Promise<void> {
  const earliest = storage.sql
    .exec<{ at: number | null }>("SELECT MIN(at) AS at FROM keel_alarms")
    .one().at;
  if (earliest === null) {
    await storage.deleteAlarm();
    return;
  }
  if ((await storage.getAlarm()) !== earliest) await storage.setAlarm(earliest);
}

export async function scheduleAlarm(
  storage: DurableObjectStorage,
  request: AlarmRequest,
): Promise<void> {
  storage.sql.exec(
    "INSERT INTO keel_alarms (reason, kind, at) VALUES (?, ?, ?) ON CONFLICT (reason) DO UPDATE SET kind = excluded.kind, at = excluded.at",
    request.reason,
    request.kind,
    request.at,
  );
  await armEarliest(storage);
}

/** Withdraws a request, e.g. a lease deadline once the change lands. */
export async function cancelAlarm(storage: DurableObjectStorage, reason: string): Promise<void> {
  storage.sql.exec("DELETE FROM keel_alarms WHERE reason = ?", reason);
  await armEarliest(storage);
}

/**
 * The requests due by `now`, removed so each is handled once, earliest first.
 * The alarm is re-armed for whatever remains. A handler that needs another
 * deadline arms it again itself, and only while there is still work.
 */
export async function dueAlarms(
  storage: DurableObjectStorage,
  now: number,
): Promise<readonly AlarmRequest[]> {
  const due = storage.transactionSync(() => {
    const rows = storage.sql
      .exec<{ reason: string; kind: string; at: number }>(
        "SELECT reason, kind, at FROM keel_alarms WHERE at <= ? ORDER BY at, reason",
        now,
      )
      .toArray();
    storage.sql.exec("DELETE FROM keel_alarms WHERE at <= ?", now);
    return rows.map(toRequest);
  });
  await armEarliest(storage);
  return due;
}

/** Every request still armed, earliest first. */
export function armedAlarms(storage: DurableObjectStorage): readonly AlarmRequest[] {
  return storage.sql
    .exec<{ reason: string; kind: string; at: number }>(
      "SELECT reason, kind, at FROM keel_alarms ORDER BY at, reason",
    )
    .toArray()
    .map(toRequest);
}
