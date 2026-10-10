import { KeelObject } from "./keel-object.ts";

/**
 * The Trunk DO (`trunk:<project>`): the one writer of trunk. Keel builds its RPC methods here, against the contract in
 * src/rpc. It extends KeelObject, which builds its runtime and the event backbone.
 */
export class TrunkDO extends KeelObject {}
