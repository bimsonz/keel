import { Decisions } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import {
  type DecisionRead,
  DecisionsRead,
  type GuardDecisionsRead,
  ProjectorCodecs,
  type SubjectDecisionsRead,
} from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Projector DO methods the decision reads call, each answering an Exit envelope. */
export interface DecisionIndexStub {
  decision(request: typeof DecisionRead.Encoded): Promise<unknown>;
  decisions(request: typeof DecisionsRead.Encoded): Promise<unknown>;
  guardDecisions(request: typeof GuardDecisionsRead.Encoded): Promise<unknown>;
  subjectDecisions(request: typeof SubjectDecisionsRead.Encoded): Promise<unknown>;
}

/** `Decisions` over the Projector's decision index. */
export function DecisionsRpc(projector: () => DecisionIndexStub): Layer.Layer<Decisions> {
  return Layer.succeed(
    Decisions,
    Decisions.of({
      get: (decisionId) =>
        callObject(ProjectorCodecs.decision, () => projector().decision({ decisionId })),
      list: (read) =>
        callObject(ProjectorCodecs.decisions, () =>
          projector().decisions(Schema.encodeSync(DecisionsRead)(read)),
        ),
      ofGuards: (project, guardIds) =>
        callObject(ProjectorCodecs.guardDecisions, () =>
          projector().guardDecisions({ project, guardIds: [...guardIds] }),
        ),
      onSubjects: (project, subjects) =>
        callObject(ProjectorCodecs.subjectDecisions, () =>
          projector().subjectDecisions({ project, subjects: [...subjects] }),
        ),
    }),
  );
}
