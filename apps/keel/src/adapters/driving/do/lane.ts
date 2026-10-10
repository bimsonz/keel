import { KeelObject } from "./keel-object.ts";

/**
 * The Lane DO (`lane:<project>:<id>`): the queue, batching, bisection, textual and interaction conflicts. Keel builds its RPC methods here, against the contract in
 * src/rpc. It extends KeelObject, which builds its runtime and the event backbone.
 */
export class LaneDO extends KeelObject {}
