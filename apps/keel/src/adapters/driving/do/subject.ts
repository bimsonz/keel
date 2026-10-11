import { hearSubject } from "@keeltown/core/application/coordination";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import { type EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import type { Transaction } from "@keeltown/core/ports";
import { Schema } from "effect";
import { KeelObject, type Reaction } from "./keel-object.ts";

const NAME = /^subj:(?<project>[^:]+):(?<key>[^:]+)$/;

/** The project and key a Subject DO's name (`subj:<project>:<key>`) gives. */
export function subjectOf(name: string | undefined): {
  readonly projectId: ProjectId;
  readonly key: SubjectKey;
} {
  const groups = NAME.exec(name ?? "")?.groups;
  return {
    projectId: Schema.decodeUnknownSync(ProjectId)(groups?.["project"]),
    key: Schema.decodeUnknownSync(SubjectKey)(groups?.["key"]),
  };
}

/**
 * The Subject DO (`subj:<project>:<key>`): premises, tenets, decisions,
 * fallout and semantic conflicts. A change's declare, revise and rely
 * subscribe the subject of each premise and effect, and its ancestors, scoped
 * to the change; the subject keeps what each change holds at or under its key,
 * mints itself once and records each premise relied at its key. It extends
 * KeelObject, which builds its runtime and the event backbone.
 */
export class SubjectDO extends KeelObject {
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    const { projectId, key } = subjectOf(this.ctx.id.name);
    return hearSubject(tx.store, projectId, key, event);
  }
}
