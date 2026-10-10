/**
 * The only way a Durable Object arms an alarm. Keel never polls: an alarm is a
 * **deadline** (a lease lapses, a sketch expires) or a **debounce** (coalesce a
 * group commit), and it says which and why. Rule R11 holds every other caller
 * to this helper.
 */
export interface AlarmRequest {
  readonly kind: "deadline" | "debounce";
  /** What the alarm is for, e.g. `lease lse_… lapses`. Stored, so the handler knows why it woke. */
  readonly reason: string;
  /** When it fires, in epoch milliseconds. */
  readonly at: number;
}

const REASON_KEY = "keel:alarm";

export async function scheduleAlarm(storage: DurableObjectStorage, request: AlarmRequest): Promise<void> {
  await storage.put(REASON_KEY, { kind: request.kind, reason: request.reason, at: request.at });
  await storage.setAlarm(request.at);
}

/** Why the alarm that just fired was armed. An alarm with no recorded reason is a defect. */
export async function firedAlarm(storage: DurableObjectStorage): Promise<AlarmRequest> {
  const recorded = await storage.get<AlarmRequest>(REASON_KEY);
  if (recorded === undefined) throw new Error("an alarm fired with no recorded kind and reason");
  await storage.delete(REASON_KEY);
  return recorded;
}
