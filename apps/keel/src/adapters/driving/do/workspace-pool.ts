import { KeelObject } from "./keel-object.ts";

/**
 * The WorkspacePool DO (`pool:<project>`): pre-forked workspaces and sketches. Keel builds its RPC methods here, against the contract in
 * src/rpc. It extends KeelObject, which builds its runtime and the event backbone.
 */
export class WorkspacePoolDO extends KeelObject {}
