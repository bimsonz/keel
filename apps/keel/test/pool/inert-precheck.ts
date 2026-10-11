import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";

/**
 * Makes every Precheck instance started while it is held inert: its `start`
 * step answers Stale, so the instance completes without touching the change.
 * The Change DO's outbox starts a real Precheck on every ChangeSubmitted; a
 * test that drives Precheck's steps by hand holds this so the two never race.
 * Dispose it when done: `await using`, or `dispose()`.
 */
export async function inertPrecheck() {
  const workflows = await introspectWorkflow(env.PRECHECK);
  await workflows.modifyAll(async (m) => {
    await m.mockStepResult({ name: "start" }, { _tag: "Stale", reason: "driven by hand" });
  });
  return workflows;
}
