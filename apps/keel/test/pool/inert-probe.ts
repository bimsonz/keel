import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";

/**
 * Makes every Probe instance started while it is held inert: its `conflict`
 * step answers a conflict no longer suspected, so the instance completes
 * moved-on without reading a party or reporting a fact. A Subject DO's fallout
 * starts a real Probe on every ConflictSuspected; a test that is not about the
 * Probe holds this so the two never race. Dispose it when done: `await using`,
 * or `dispose()`.
 */
export async function inertProbe() {
  const workflows = await introspectWorkflow(env.PROBE);
  await workflows.modifyAll(async (m) => {
    await m.mockStepResult(
      { name: "conflict" },
      JSON.stringify({ _tag: "Ok", value: { conflict: { state: "dismissed" } } }),
    );
  });
  return workflows;
}
