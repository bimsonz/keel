import { DurableObject } from "cloudflare:workers";

/**
 * BoxGate: counts live containers per account and project, so boxes under the
 * `durable_object` scheduling policy (which refuses `max_instances`) stay
 * within the shared account's budget. Keel builds the counting.
 */
export class BoxGate extends DurableObject<Env> {}
