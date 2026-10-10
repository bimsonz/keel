import { NotImplemented } from "@keeltown/core/not-implemented";
import { Effect } from "effect";
import { type CreateProjectCommand, ProjectCodecs, type ProjectRpc } from "../../../rpc/index.ts";
import { KeelObject } from "./keel-object.ts";

/**
 * The Project DO (`project:<id>`): settings and the subject registry. Keel builds its RPC methods here, against the contract in
 * src/rpc. It extends KeelObject, which builds its runtime and the event backbone.
 */
export class ProjectDO extends KeelObject implements Pick<ProjectRpc, "createProject"> {
  async createProject(_command: typeof CreateProjectCommand.Encoded) {
    return this.answer(
      ProjectCodecs.createProject,
      Effect.die(new NotImplemented("coordination/createProject")),
    );
  }
}
