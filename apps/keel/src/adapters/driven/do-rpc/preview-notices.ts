import type { ChangeId } from "@keeltown/core/kernel";
import { PreviewNotices } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import { ChangeCodecs, TellPreviewCommand } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Change DO method that tells a change where its preview answers (`change:<id>`), answering an Exit envelope. */
export interface PreviewNoticesStub {
  tellPreview(command: typeof TellPreviewCommand.Encoded): Promise<unknown>;
}

const encodeTell = Schema.encodeSync(TellPreviewCommand);

/**
 * `PreviewNotices` over Durable Object RPC: each change is told by its own
 * Change DO, which commits PreviewDeployed on the change's stream for its
 * agent's inbox, and tells a change it never made nothing.
 */
export function PreviewNoticesRpc(
  change: (changeId: ChangeId) => PreviewNoticesStub,
): Layer.Layer<PreviewNotices> {
  return Layer.succeed(
    PreviewNotices,
    PreviewNotices.of({
      tell: (changeId, notice) =>
        callObject(ChangeCodecs.tellPreview, () =>
          change(changeId).tellPreview(
            encodeTell({
              changeId,
              deploymentId: notice.deploymentId,
              candidateId: notice.candidateId,
              target: notice.target,
              url: notice.url,
              ...(notice.aliasUrl === undefined ? {} : { aliasUrl: notice.aliasUrl }),
            }),
          ),
        ),
    }),
  );
}
