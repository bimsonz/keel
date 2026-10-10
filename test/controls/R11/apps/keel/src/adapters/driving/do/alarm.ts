// The alarm helper may call setAlarm: the canary, not a violation.
export async function scheduleAlarm(storage: { setAlarm(at: number): Promise<void> }, request: { kind: string; reason: string; at: number }) {
  await storage.setAlarm(request.at);
}
