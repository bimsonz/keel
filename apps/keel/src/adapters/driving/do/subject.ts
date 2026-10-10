import { KeelObject } from "./keel-object.ts";

/**
 * The Subject DO (`subj:<project>:<key>`): premises, tenets, decisions, fallout and semantic conflicts. Keel builds its RPC methods here, against the contract in
 * src/rpc. It extends KeelObject, which builds its runtime and the event backbone.
 */
export class SubjectDO extends KeelObject {}
