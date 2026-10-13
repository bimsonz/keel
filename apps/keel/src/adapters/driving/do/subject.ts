import {
  conflictView,
  hearDecision,
  hearSubject,
  probeCellRanAt,
  probeDrafted,
  probeDraftFailedAt,
  probeRunFailedAt,
  resolveConflict,
  worldCheckRan,
} from "@keeltown/core/application/coordination";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import { ConflictId, type EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import type { Transaction } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { type SubjectServices, subjectServices } from "../../../composition/do.ts";
import {
  ProbeCellRanCommand,
  ProbeDraftedCommand,
  ProbeDraftFailedCommand,
  ResolveCommand,
  SubjectCodecs,
  type SubjectRpc,
  WorldCheckRanCommand,
} from "../../../rpc/index.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

const decoded = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.orDie(Schema.decodeUnknownEffect(schema)(input));

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
 * mints itself once and records each premise relied at its key. It hosts the
 * subject's conflicts and their probes, and takes the Probe Workflow's facts
 * and a party's moves through the domain's machines. A conflict that needs a
 * person (a party escalated it, or its probe could not decide it) is put to
 * one through the project's namespace object; the subject hears the decision
 * that ruling records and resolves the conflict with it. It extends
 * KeelObjectWith, which builds its runtime and the event backbone.
 */
export class SubjectDO extends KeelObjectWith<SubjectServices> implements SubjectRpc {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, subjectServices(env));
  }

  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    const { projectId, key } = subjectOf(this.ctx.id.name);
    const { problems, ...reaction } =
      event.type === "DecisionRecorded"
        ? hearDecision(tx, projectId, event)
        : hearSubject(tx, projectId, key, event);
    for (const problem of problems ?? []) console.error(`${this.ctx.id.name}: ${problem}`);
    return reaction;
  }

  async conflict(conflictId: string) {
    return this.answer(
      SubjectCodecs.conflict,
      decoded(ConflictId, conflictId).pipe(Effect.flatMap(conflictView)),
    );
  }

  async probeDrafted(command: typeof ProbeDraftedCommand.Encoded) {
    const { projectId } = subjectOf(this.ctx.id.name);
    return this.answer(
      SubjectCodecs.probeDrafted,
      decoded(ProbeDraftedCommand, command).pipe(
        Effect.flatMap((drafted) => probeDrafted(projectId, drafted)),
      ),
    );
  }

  async resolve(command: typeof ResolveCommand.Encoded) {
    const at = subjectOf(this.ctx.id.name);
    return this.answer(
      SubjectCodecs.resolve,
      decoded(ResolveCommand, command).pipe(Effect.flatMap((move) => resolveConflict(at, move))),
    );
  }

  async probeDraftFailed(command: typeof ProbeDraftFailedCommand.Encoded) {
    const at = subjectOf(this.ctx.id.name);
    return this.answer(
      SubjectCodecs.probeDraftFailed,
      decoded(ProbeDraftFailedCommand, command).pipe(
        Effect.flatMap((failed) => probeDraftFailedAt(at, failed)),
      ),
    );
  }

  async probeRunFailed(conflictId: string) {
    const at = subjectOf(this.ctx.id.name);
    return this.answer(
      SubjectCodecs.probeRunFailed,
      decoded(ConflictId, conflictId).pipe(Effect.flatMap((id) => probeRunFailedAt(at, id))),
    );
  }

  async probeCellRan(command: typeof ProbeCellRanCommand.Encoded) {
    const at = subjectOf(this.ctx.id.name);
    return this.answer(
      SubjectCodecs.probeCellRan,
      decoded(ProbeCellRanCommand, command).pipe(
        Effect.flatMap((cell) => probeCellRanAt(at, cell)),
      ),
    );
  }

  async worldCheckRan(command: typeof WorldCheckRanCommand.Encoded) {
    const { projectId } = subjectOf(this.ctx.id.name);
    return this.answer(
      SubjectCodecs.worldCheckRan,
      decoded(WorldCheckRanCommand, command).pipe(
        Effect.flatMap((cell) => worldCheckRan(projectId, cell)),
      ),
    );
  }
}
