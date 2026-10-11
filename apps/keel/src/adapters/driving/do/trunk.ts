import { initializeTrunk, syncTrunk } from "@keeltown/core/application/integration";
import type { Trunk } from "@keeltown/core/domain/integration";
import { CommitSha, ProjectId } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import { TrunkCodecs, type TrunkRpc } from "../../../rpc/trunk.ts";
import { type TrunkServices, trunkServices } from "../../../composition/do.ts";
import { KeelObjectWith } from "./keel-object.ts";

const decodeHead = Schema.decodeUnknownEffect(CommitSha);
const decodeProject = Schema.decodeUnknownSync(ProjectId);

/** A Trunk DO is addressed as `trunk:<projectId>`. */
const projectOfName = (name: string | undefined): ProjectId => {
  if (name?.startsWith("trunk:") !== true)
    throw new Error("a Trunk DO is addressed as trunk:<projectId>");
  return decodeProject(name.slice("trunk:".length));
};

/** What the RPC answers for a trunk. No Auditor runs before L4, so nothing is red yet. */
const statusOf = (trunk: Trunk) => ({ head: trunk.head, promotion: trunk.phase, redCount: 0 });

/**
 * The Trunk DO (`trunk:<projectId>`): the one writer of trunk (ADR 0003),
 * decided by the domain's Promotion machine. Its state is folded from its own
 * events and the `BatchVerified` it receives. Repo-touching: callers place it
 * with the deployment's `locationHint`.
 */
export class TrunkDO extends KeelObjectWith<TrunkServices> implements Partial<TrunkRpc> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(
      ctx,
      env,
      trunkServices(env, () => projectOfName(ctx.id.name)),
    );
  }

  /** The project whose trunk this is, from the object's name. */
  private get projectId(): ProjectId {
    return projectOfName(this.ctx.id.name);
  }

  async initialize(head: string, by: string) {
    const projectId = this.projectId;
    const program = decodeHead(head).pipe(
      Effect.orDie,
      Effect.flatMap((sha) => initializeTrunk(projectId, sha, by)),
      Effect.map(statusOf),
    );
    return this.answer(TrunkCodecs.initialize, program);
  }

  async sync() {
    return this.answer(TrunkCodecs.sync, syncTrunk(this.projectId));
  }
}
