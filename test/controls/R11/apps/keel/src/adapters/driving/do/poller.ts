// Control for R11: a DO polls, arms an alarm directly, and arms one with no kind.
import { scheduleAlarm } from "./alarm.ts";

declare const storage: { setAlarm(at: number): Promise<void> };

setInterval(() => undefined, 1000);
await storage.setAlarm(Date.now() + 1000);
await scheduleAlarm(storage, { kind: "poll", reason: "check again", at: Date.now() + 1000 });
