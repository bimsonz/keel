import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { POOL_CLAIM_EVENT, POOL_WAIT } from "../do/workflow-pool-rules.ts";
import { timedOut } from "./steps.ts";

/** What a pooled Workflow runs with: the input an event started it with, or nothing, its wait for a claim having run out. */
export type ClaimedInput =
  | { readonly _tag: "Input"; readonly payload: unknown }
  | { readonly _tag: "Retired" };

const isPooled = (payload: unknown): boolean =>
  typeof payload === "object" && payload !== null && Reflect.get(payload, "pooled") === true;

/**
 * An instance's input: its own params when it was started cold; when its
 * pool started it warm, the payload of its claim's event, which carries the
 * params the event would have started a cold one with. Retired when no claim
 * came before the wait ran out: the instance then ends, having done nothing.
 */
export async function claimedInput(
  event: WorkflowEvent<unknown>,
  step: WorkflowStep,
): Promise<ClaimedInput> {
  if (!isPooled(event.payload)) return { _tag: "Input", payload: event.payload };
  try {
    const claimed = await step.waitForEvent<Record<string, string | number | boolean | null>>(
      "claim",
      {
        type: POOL_CLAIM_EVENT,
        timeout: POOL_WAIT,
      },
    );
    return { _tag: "Input", payload: claimed.payload };
  } catch (error) {
    if (timedOut(error)) return { _tag: "Retired" };
    throw error;
  }
}
