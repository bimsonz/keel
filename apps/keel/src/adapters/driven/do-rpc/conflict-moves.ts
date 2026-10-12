import { subjectAddress } from "@keeltown/core/application/coordination";
import { ConflictMoves } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import { ResolveCommand, SubjectCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Subject DO method `ConflictMoves` calls (`subj:<project>:<key>`), answering an Exit envelope. */
export interface ConflictMovesStub {
  resolve(command: typeof ResolveCommand.Encoded): Promise<unknown>;
}

/** `ConflictMoves` over each subject's Subject DO, addressed by name. */
export function ConflictMovesRpc(
  subject: (address: string) => ConflictMovesStub,
): Layer.Layer<ConflictMoves> {
  return Layer.succeed(
    ConflictMoves,
    ConflictMoves.of({
      resolve: (at, command) =>
        callObject(SubjectCodecs.resolve, () =>
          subject(subjectAddress(at.projectId, at.key)).resolve(
            Schema.encodeSync(ResolveCommand)(command),
          ),
        ),
    }),
  );
}
