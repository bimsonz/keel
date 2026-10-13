import { Option, Schema } from "effect";

/**
 * Workflows' report that an instance ended without completing (event schema
 * version 1), as a Queues event subscription on KeelVerify's Workflow
 * delivers it. Captured on 13 Oct 2026: `{ type, source: { workflowName,
 * type }, metadata, payload: { versionId, instanceId } }`, and no error in
 * it. Third-party payloads are decoded with Effect Schema at the doorway, and
 * only what Keel acts on is asked of them.
 */
export const WorkflowInstanceEnded = Schema.Struct({
  type: Schema.Literals([
    "cf.workflows.workflow.instance.errored",
    "cf.workflows.workflow.instance.terminated",
  ]),
  payload: Schema.Struct({ instanceId: Schema.NonEmptyString }),
});

/** The instance a report names. */
export interface InstanceEnded {
  readonly instanceId: string;
}

/**
 * The instance that ended without completing; null for every other event of
 * an instance (started, completed) and anything unreadable. A Worker consumer
 * is handed the body as an object and a pull consumer as a JSON string: both
 * are read.
 */
export function translateWorkflowEvent(raw: unknown): InstanceEnded | null {
  let body = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const decoded = Schema.decodeUnknownOption(WorkflowInstanceEnded)(body);
  return Option.isNone(decoded) ? null : { instanceId: decoded.value.payload.instanceId };
}
