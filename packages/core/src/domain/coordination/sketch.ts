import { Schema } from "effect";
import { AgentId, ChangeId, InstantSchema, SketchId, WorkspaceId } from "../kernel/index.ts";

export const SketchState = Schema.Literals(["open", "promoted", "expired", "discarded"]);
export type SketchState = typeof SketchState.Type;

/** A throwaway workspace for an idea: no intent, no preflight, no integration until it is declared. */
export const Sketch = Schema.Struct({
  id: SketchId,
  agentId: AgentId,
  workspaceId: WorkspaceId,
  /** Its TTL deadline. A sketch past it is expired, whether or not the alarm has fired. */
  expiresAt: InstantSchema,
  state: SketchState,
  /** The change it became, once promoted. */
  changeId: Schema.optional(ChangeId),
});
export type Sketch = typeof Sketch.Type;
