import { DurableObject } from "cloudflare:workers";

/**
 * MergeBox (Tier 2): composes the candidates GitCore refuses, with real git
 * (>= 2.38 for merge-tree). This turns into a container on the GA API
 * under the `durable_object` scheduling policy, registered with BoxGate, with
 * internet off and its repo token injected per request by outbound
 * interception, never in its environment.
 */
export class MergeBox extends DurableObject<Env> {}
