import type { ProjectId } from "@keeltown/core/kernel";
import { ProposalLedger } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import { ProjectCodecs, ReserveProposalCommand } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Project DO's method `ProposalLedger` calls (`project:<id>`), answering an Exit envelope. */
export interface ProjectProposalsStub {
  reserveProposal(command: typeof ReserveProposalCommand.Encoded): Promise<unknown>;
}

const encodeReserve = Schema.encodeSync(ReserveProposalCommand);

/** `ProposalLedger` over each project's own object, addressed by the project's id. */
export function ProposalLedgerRpc(
  project: (projectId: ProjectId) => ProjectProposalsStub,
): Layer.Layer<ProposalLedger> {
  return Layer.succeed(
    ProposalLedger,
    ProposalLedger.of({
      reserve: (projectId, reservation) =>
        callObject(ProjectCodecs.reserveProposal, () =>
          project(projectId).reserveProposal(encodeReserve(reservation)),
        ),
    }),
  );
}
