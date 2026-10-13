/**
 * The only way a Durable Object arms an alarm. Keel never polls: an alarm is a
 * **deadline** (a lease lapses, a delivery is retried) or a **debounce**
 * (coalesce a flush or a group commit), and it says which and why. Rule R11
 * holds every other caller to this helper.
 *
 * A Durable Object has one alarm, but may owe several deadlines at once (a
 * Change DO's lease and its outbox's redelivery). Each request is a row keyed
 * by its reason; the platform alarm is always armed for the earliest row.
 *
 * A due row stays until its handler returns. The platform runs an alarm at
 * least once and runs it again when the invocation dies, so a handler that
 * was killed, or threw, finds its request still there and is run again:
 * every handler resumes from what it last committed. Each row counts its
 * starts, so one that never finishes is given up on instead of looping.
 */
export interface AlarmRequest {
  readonly kind: "deadline" | "debounce";
  /** What the alarm is for, e.g. `lease lse_… lapses`. One row per reason: arming a reason again moves it. */
  readonly reason: string;
  /** When it fires, in epoch milliseconds. */
  readonly at: number;
}

/**
 * A due request as its handler is given it. `starts` counts this run and
 * every earlier run of the reason that never returned: 1 the first time,
 * more when an invocation died under it.
 */
export interface StartedAlarm extends AlarmRequest {
  readonly starts: number;
}

/** A started request, with what `finishAlarm` needs to tell it from one armed since. */
export interface RunningAlarm extends StartedAlarm {
  /** How often the reason had been armed when this run started. */
  readonly armed: number;
}

/** A reason started this many times in a row without its handler returning is given up on. */
export const ALARM_START_LIMIT = 5;

/**
 * How long after its first start a request is run again when its handler
 * has not returned, doubling with each start. A handler that returns removes
 * its request, so only an invocation that died is ever run again.
 */
export const ALARM_RETRY_MS = 5_000;

/**
 * Creates the alarm table, and gives one made before starts were counted its
 * columns. Called by the Durable Object's composition inside
 * `blockConcurrencyWhile`.
 *
 * `starts` is how often the reason was started with no handler returning
 * since, `retry` when a started request is run again, and `armed` how often
 * the reason was armed.
 */
export function migrateAlarms(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS keel_alarms (reason TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL, starts INTEGER NOT NULL DEFAULT 0, retry INTEGER, armed INTEGER NOT NULL DEFAULT 0)",
  );
  const columns = new Set(
    storage.sql
      .exec<{ name: string }>("PRAGMA table_info(keel_alarms)")
      .toArray()
      .map((column) => column.name),
  );
  if (!columns.has("starts"))
    storage.sql.exec("ALTER TABLE keel_alarms ADD COLUMN starts INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("retry")) storage.sql.exec("ALTER TABLE keel_alarms ADD COLUMN retry INTEGER");
  if (!columns.has("armed"))
    storage.sql.exec("ALTER TABLE keel_alarms ADD COLUMN armed INTEGER NOT NULL DEFAULT 0");
}

interface AlarmRow extends Record<string, SqlStorageValue> {
  reason: string;
  kind: string;
  at: number;
  starts: number;
  armed: number;
}

const toRequest = (row: { reason: string; kind: string; at: number }): AlarmRequest => ({
  kind: row.kind === "debounce" ? "debounce" : "deadline",
  reason: row.reason,
  at: row.at,
});

const toRunning = (row: AlarmRow): RunningAlarm => ({
  ...toRequest(row),
  starts: row.starts,
  armed: row.armed,
});

/**
 * Arms the platform alarm for the earliest request, or clears it when none
 * is left. A started request counts at the time it is run again.
 */
async function armEarliest(storage: DurableObjectStorage): Promise<void> {
  const earliest = storage.sql
    .exec<{ at: number | null }>("SELECT MIN(COALESCE(retry, at)) AS at FROM keel_alarms")
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
  // Arming a reason again moves it, and is told from the request a running handler was given by
  // `armed`. Its starts are kept: they count runs that never returned, whatever was armed between.
  storage.sql.exec(
    "INSERT INTO keel_alarms (reason, kind, at) VALUES (?, ?, ?) ON CONFLICT (reason) DO UPDATE SET kind = excluded.kind, at = excluded.at, retry = NULL, armed = armed + 1",
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

/** What an alarm finds due. */
export interface DueAlarms {
  /** The requests due by `now`, earliest first, each to be started with `startAlarm`. */
  readonly due: readonly RunningAlarm[];
  /** The requests given up on, removed: each was started `ALARM_START_LIMIT` times and never finished. */
  readonly abandoned: readonly StartedAlarm[];
}

/**
 * The requests due by `now`, earliest first: those whose time has come, and
 * those started before whose handler never returned and whose retry has come.
 * Nothing is removed but what was already started `ALARM_START_LIMIT` times,
 * answered as abandoned. With nothing due, the alarm is re-armed for whatever
 * remains.
 */
export async function dueAlarms(storage: DurableObjectStorage, now: number): Promise<DueAlarms> {
  const rows = storage.transactionSync(() => {
    const found = storage.sql
      .exec<AlarmRow>(
        "SELECT reason, kind, at, starts, armed FROM keel_alarms WHERE COALESCE(retry, at) <= ? ORDER BY at, reason",
        now,
      )
      .toArray();
    storage.sql.exec(
      "DELETE FROM keel_alarms WHERE COALESCE(retry, at) <= ? AND starts >= ?",
      now,
      ALARM_START_LIMIT,
    );
    return found;
  });
  const abandoned = rows.filter((row) => row.starts >= ALARM_START_LIMIT).map(toRunning);
  const due = rows.filter((row) => row.starts < ALARM_START_LIMIT).map(toRunning);
  if (due.length === 0) await armEarliest(storage);
  return { due, abandoned };
}

/**
 * Counts a due request as started, in one write before its handler runs, and
 * arms the alarm to run it again later in case this invocation dies. It stays
 * on the table until `finishAlarm`. Undefined when the request is no longer
 * as `dueAlarms` read it: an earlier handler of the same run armed its reason
 * again or withdrew it, and there is nothing of this one left to run.
 */
export async function startAlarm(
  storage: DurableObjectStorage,
  due: RunningAlarm,
  now: number,
): Promise<RunningAlarm | undefined> {
  const starts = due.starts + 1;
  const { rowsWritten } = storage.sql.exec(
    "UPDATE keel_alarms SET starts = ?, retry = ? WHERE reason = ? AND armed = ? AND starts = ?",
    starts,
    now + ALARM_RETRY_MS * 2 ** due.starts,
    due.reason,
    due.armed,
    due.starts,
  );
  await armEarliest(storage);
  return rowsWritten === 0 ? undefined : { ...due, starts };
}

/**
 * The handler of a started request returned: the request is done and its row
 * goes. If its reason was armed again meanwhile (the handler asked for
 * another deadline, or a delivery arrived while it ran), that request stays,
 * with no run counted against it. The alarm is armed for whatever remains.
 */
export async function finishAlarm(
  storage: DurableObjectStorage,
  running: RunningAlarm,
): Promise<void> {
  storage.transactionSync(() => {
    storage.sql.exec(
      "DELETE FROM keel_alarms WHERE reason = ? AND armed = ?",
      running.reason,
      running.armed,
    );
    storage.sql.exec("UPDATE keel_alarms SET starts = 0 WHERE reason = ?", running.reason);
  });
  await armEarliest(storage);
}

/** Every request still armed, earliest first. */
export function armedAlarms(storage: DurableObjectStorage): readonly AlarmRequest[] {
  return storage.sql
    .exec<AlarmRow>("SELECT reason, kind, at, starts, armed FROM keel_alarms ORDER BY at, reason")
    .toArray()
    .map(toRequest);
}
