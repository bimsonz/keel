// A Workflow's warm pool as the fan-out reaches it: the claim it asks for an
// event, what a claim answers when no warm instance can take it, and the event
// that hands a warm instance its input.

/** What a claim answers when no warm instance can take it: the caller starts one cold. */
export const COLD = "cold";

/** The event a claim sends a warm instance, carrying the input it runs with. */
export const POOL_CLAIM_EVENT = "keel-pool-claim";

/** The pool's object (`pool:<Workflow>`): one event's claim, a warm instance's id or COLD. */
export interface WorkflowPoolRpc {
  claim(eventId: string): Promise<string>;
}
