import { QuestionRaisers } from "@keeltown/core/ports";
import { Layer } from "effect";
import { SubjectCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Subject DO method `QuestionRaisers` calls (`subj:<project>:<key>`), answering an Exit envelope. */
export interface QuestionRaisersStub {
  recheckQuestion(conflictId: string): Promise<unknown>;
}

/** `QuestionRaisers` over the Subject DOs, each addressed by the name it raised its questions under. */
export function QuestionRaisersRpc(
  subject: (address: string) => QuestionRaisersStub,
): Layer.Layer<QuestionRaisers> {
  return Layer.succeed(
    QuestionRaisers,
    QuestionRaisers.of({
      recheck: (raisedBy, conflictId) =>
        callObject(SubjectCodecs.recheckQuestion, () =>
          subject(raisedBy).recheckQuestion(conflictId),
        ),
    }),
  );
}
