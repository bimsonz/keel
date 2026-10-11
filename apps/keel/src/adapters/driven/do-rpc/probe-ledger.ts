import { subjectAddress } from "@keeltown/core/application/coordination";
import { ProbeLedger, type SubjectRef } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import {
  ProbeCellRanCommand,
  ProbeDraftedCommand,
  ProbeDraftFailedCommand,
  SubjectCodecs,
  WorldCheckRanCommand,
} from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Subject DO methods `ProbeLedger` calls (`subj:<project>:<key>`), answering Exit envelopes. */
export interface ProbeLedgerStub {
  conflict(conflictId: string): Promise<unknown>;
  probeDrafted(command: typeof ProbeDraftedCommand.Encoded): Promise<unknown>;
  probeDraftFailed(command: typeof ProbeDraftFailedCommand.Encoded): Promise<unknown>;
  probeCellRan(command: typeof ProbeCellRanCommand.Encoded): Promise<unknown>;
  worldCheckRan(command: typeof WorldCheckRanCommand.Encoded): Promise<unknown>;
}

/** `ProbeLedger` over each subject's Subject DO, addressed by name. */
export function ProbeLedgerRpc(
  subject: (address: string) => ProbeLedgerStub,
): Layer.Layer<ProbeLedger> {
  const at = (ref: SubjectRef) => subject(subjectAddress(ref.projectId, ref.key));
  return Layer.succeed(
    ProbeLedger,
    ProbeLedger.of({
      conflict: (ref, conflictId) =>
        callObject(SubjectCodecs.conflict, () => at(ref).conflict(conflictId)),
      probeDrafted: (ref, drafted) =>
        callObject(SubjectCodecs.probeDrafted, () =>
          at(ref).probeDrafted(Schema.encodeSync(ProbeDraftedCommand)(drafted)),
        ),
      probeDraftFailed: (ref, failed) =>
        callObject(SubjectCodecs.probeDraftFailed, () =>
          at(ref).probeDraftFailed(Schema.encodeSync(ProbeDraftFailedCommand)(failed)),
        ),
      probeCellRan: (ref, cell) =>
        callObject(SubjectCodecs.probeCellRan, () =>
          at(ref).probeCellRan(Schema.encodeSync(ProbeCellRanCommand)(cell)),
        ),
      worldCheckRan: (ref, cell) =>
        callObject(SubjectCodecs.worldCheckRan, () =>
          at(ref).worldCheckRan(Schema.encodeSync(WorldCheckRanCommand)(cell)),
        ),
    }),
  );
}
