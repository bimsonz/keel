import { KeelObject } from "./keel-object.ts";

/**
 * The Change DO (`change:<ULID>`): intent revisions, premises, effects and verdicts. Keel builds its RPC methods here, against the contract in
 * src/rpc. It extends KeelObject, which builds its runtime and the event backbone.
 */
export class ChangeDO extends KeelObject {}
