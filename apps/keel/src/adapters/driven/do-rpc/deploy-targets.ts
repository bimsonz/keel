import type { ProjectId } from "@keeltown/core/kernel";
import { DeployTargets } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import {
  ClearDeployTargetCommand,
  HoldConnectCommand,
  ProjectCodecs,
  SetDeployTargetCommand,
  TakeConnectCommand,
} from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Project DO methods that hold a project's deploy targets (`project:<id>`), each answering an Exit envelope. */
export interface DeployTargetsStub {
  deployTargets(): Promise<unknown>;
  setDeployTarget(command: typeof SetDeployTargetCommand.Encoded): Promise<unknown>;
  clearDeployTarget(command: typeof ClearDeployTargetCommand.Encoded): Promise<unknown>;
  holdConnect(command: typeof HoldConnectCommand.Encoded): Promise<unknown>;
  takeConnect(command: typeof TakeConnectCommand.Encoded): Promise<unknown>;
}

const encodeSet = Schema.encodeSync(SetDeployTargetCommand);
const encodeClear = Schema.encodeSync(ClearDeployTargetCommand);
const encodeHold = Schema.encodeSync(HoldConnectCommand);
const encodeTake = Schema.encodeSync(TakeConnectCommand);

/**
 * `DeployTargets` over Durable Object RPC: each project's targets are its own
 * Project DO's, which decides every set and clear over the targets it holds.
 * Its refusals cross as the domain's own errors.
 */
export function DeployTargetsRpc(
  project: (projectId: ProjectId) => DeployTargetsStub,
): Layer.Layer<DeployTargets> {
  return Layer.succeed(
    DeployTargets,
    DeployTargets.of({
      list: (projectId) =>
        callObject(ProjectCodecs.deployTargets, () => project(projectId).deployTargets()),
      set: (command) =>
        callObject(ProjectCodecs.setDeployTarget, () =>
          project(command.projectId).setDeployTarget(
            encodeSet({
              projectId: command.projectId,
              target: command.target,
              by: command.by,
              credentialInOrg: command.credentialInOrg,
              ...(command.workersDev === undefined ? {} : { workersDev: command.workersDev }),
              requestId: command.requestId,
            }),
          ),
        ),
      clear: (command) =>
        callObject(ProjectCodecs.clearDeployTarget, () =>
          project(command.projectId).clearDeployTarget(encodeClear(command)),
        ),
      holdConnect: (command) =>
        callObject(ProjectCodecs.holdConnect, () =>
          project(command.projectId).holdConnect(encodeHold(command)),
        ),
      takeConnect: (command) =>
        callObject(ProjectCodecs.takeConnect, () =>
          project(command.projectId).takeConnect(encodeTake(command)),
        ),
    }),
  );
}
