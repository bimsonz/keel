import { purgeExpired } from "../adapters/driven/better-auth/retention.ts";

/**
 * The cron's composition root: the retention deadlines keel.town's privacy
 * notice states, enforced on the Worker's D1 as of the cron's own time.
 */
export async function enforceRetention(env: Env, scheduledTime: number): Promise<void> {
  const purged = await purgeExpired(env.DB, new Date(scheduledTime));
  console.log("retention purged", JSON.stringify(purged));
}
