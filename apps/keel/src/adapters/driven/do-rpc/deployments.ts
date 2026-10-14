import type { ProjectId } from "@keeltown/core/kernel";
import { Deployments } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import {
  DeliveryRefusedCommand,
  DeploymentOfCommand,
  DeploymentPromotedCommand,
  ProjectCodecs,
  RecordDeploymentCommand,
} from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Project DO methods that hold a project's deployments (`project:<id>`), each answering an Exit envelope. */
export interface DeploymentsStub {
  recordDeployment(command: typeof RecordDeploymentCommand.Encoded): Promise<unknown>;
  deploymentOf(command: typeof DeploymentOfCommand.Encoded): Promise<unknown>;
  deploymentPromoted(command: typeof DeploymentPromotedCommand.Encoded): Promise<unknown>;
  deliveryRefused(command: typeof DeliveryRefusedCommand.Encoded): Promise<unknown>;
}

const encodeRecord = Schema.encodeSync(RecordDeploymentCommand);
const encodeOf = Schema.encodeSync(DeploymentOfCommand);
const encodePromoted = Schema.encodeSync(DeploymentPromotedCommand);
const encodeRefused = Schema.encodeSync(DeliveryRefusedCommand);

/**
 * `Deployments` over Durable Object RPC: each project's deployments are its
 * own Project DO's, which keeps one per candidate and commits each promotion
 * and refusal on the project's stream. No call carries a credential: a
 * deployment names its target, and the target names its credential.
 */
export function DeploymentsRpc(
  project: (projectId: ProjectId) => DeploymentsStub,
): Layer.Layer<Deployments> {
  return Layer.succeed(
    Deployments,
    Deployments.of({
      record: (projectId, deployment) =>
        callObject(ProjectCodecs.recordDeployment, () =>
          project(projectId).recordDeployment(encodeRecord({ projectId, deployment })),
        ),
      of: (projectId, candidateId) =>
        callObject(ProjectCodecs.deploymentOf, () =>
          project(projectId).deploymentOf(encodeOf({ projectId, candidateId })),
        ),
      promoted: (projectId, { deploymentId, trunkSha }) =>
        callObject(ProjectCodecs.deploymentPromoted, () =>
          project(projectId).deploymentPromoted(
            encodePromoted({ projectId, deploymentId, trunkSha }),
          ),
        ),
      refused: (projectId, refusal) =>
        callObject(ProjectCodecs.deliveryRefused, () =>
          project(projectId).deliveryRefused(encodeRefused({ projectId, ...refusal })),
        ),
    }),
  );
}
