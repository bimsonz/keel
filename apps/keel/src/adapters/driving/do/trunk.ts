import { initializeTrunk } from "@keeltown/core/application/integration";
import type { Trunk } from "@keeltown/core/domain/integration";
import { CommitSha, ProjectId } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import { TrunkCodecs, type TrunkRpc } from "../../../rpc/trunk.ts";
import { KeelObject } from "./keel-object.ts";

const decodeHead = Schema.decodeUnknownEffect(CommitSha);
const decodeProject = Schema.decodeUnknownSync(ProjectId);

/** What the RPC answers for a trunk. No Auditor runs before L4, so nothing is red yet. */
const statusOf = (trunk: Trunk) => ({ head: trunk.head, promotion: trunk.phase, redCount: 0 });

/**
 * The Trunk DO (`trunk:<projectId>`): the one writer of trunk (ADR 0003),
 * decided by the domain's Promotion machine. Its state is folded from its own
 * events and the `BatchVerified` it receives. Repo-touching: callers place it
 * with the deployment's `locationHint`.
 */
export class TrunkDO extends KeelObject implements Partial<TrunkRpc> {
  /** The project whose trunk this is, from the object's name. */
  private get projectId(): ProjectId {
    const name = this.ctx.id.name;
    if (name?.startsWith("trunk:") !== true)
      throw new Error("a Trunk DO is addressed as trunk:<projectId>");
    return decodeProject(name.slice("trunk:".length));
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
}
