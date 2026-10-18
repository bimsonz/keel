import { IssueNumbers } from "@keeltown/core/ports";
import { Layer } from "effect";
import { type IssueNumberRead, ProjectorCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Projector DO method an issue's number is given by, answering an Exit envelope. */
export interface IssueNumberStub {
  issueNumber(request: typeof IssueNumberRead.Encoded): Promise<unknown>;
}

/** `IssueNumbers` over the Projector, which gives each of a project's changes and issues its `#n`. */
export function IssueNumbersRpc(projector: () => IssueNumberStub): Layer.Layer<IssueNumbers> {
  return Layer.succeed(
    IssueNumbers,
    IssueNumbers.of({
      give: (projectId, issueId) =>
        callObject(ProjectorCodecs.issueNumber, () =>
          projector().issueNumber({ projectId, issueId }),
        ),
    }),
  );
}
