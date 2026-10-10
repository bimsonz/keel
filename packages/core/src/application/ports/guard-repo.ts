import { Context, type Effect } from "effect";
import type { CommitSha, GuardId, ProjectId } from "../../domain/kernel/index.ts";

export interface GuardFile {
  readonly guardId: GuardId;
  readonly path: string;
}

/** The guard repo: admitted guards, which agents can never write to. */
export class GuardRepo extends Context.Service<GuardRepo, {
  readonly list: (projectId: ProjectId, at: CommitSha) => Effect.Effect<readonly GuardFile[]>;
  readonly admit: (projectId: ProjectId, guardId: GuardId, files: ReadonlyMap<string, Uint8Array>) => Effect.Effect<CommitSha>;
}>()("keel/GuardRepo") {}
