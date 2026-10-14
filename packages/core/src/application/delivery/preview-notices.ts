import { Effect, Result, Schema } from "effect";
import { PreviewDeployed } from "../../domain/delivery/index.ts";
import type { ChangeId, EntityRef } from "../../domain/kernel/index.ts";
import { CHANGE, CHANGE_WORKSPACE, HeldWorkspace } from "../coordination/index.ts";
import {
  type Clock,
  commit,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  type PreviewNotice,
} from "../ports/index.ts";

/**
 * The world a preview serves. A preview is a world (ADR 0008), and the deploy
 * steps run outside every `worlds` node of the plan, on the candidate itself:
 * trunk with the candidate's changes on it, the tree its verdict is about.
 * None of the probe matrix's worlds is that tree, so the preview names its own.
 */
export const PREVIEW_WORLD = "candidate";

const decodeHeld = Schema.decodeUnknownSync(HeldWorkspace);
const encodePreviewed = Schema.encodeSync(PreviewDeployed);
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

const changeRef = (changeId: ChangeId): EntityRef => ({ kind: "change", id: changeId });

/**
 * Tells a change where its candidate's preview answers, in its Change DO:
 * commits PreviewDeployed on the change's stream, which its agent hears (it
 * subscribes to every event of its change at declare) and reads in its inbox.
 * The event carries the change's project, as its other events do. The cause
 * is `preview:<deploymentId>`, so a retried notice commits it once. A change
 * its object never made is told nothing: no event, and no error, since the
 * preview step tells every member of its candidate and fails none.
 */
export const tellPreview: (
  changeId: ChangeId,
  notice: PreviewNotice,
) => Effect.Effect<void, never, Clock | EntityStore | EventOutbox> = Effect.fn(
  "delivery/tellPreview",
)(function* (changeId: ChangeId, notice: PreviewNotice) {
  const held = (yield* EntityStore).get(CHANGE_WORKSPACE, changeId);
  const project = held === undefined ? undefined : decodeHeld(held).projectId;
  yield* commit(
    {
      entity: changeRef(changeId),
      cause: `preview:${notice.deploymentId}`,
      ...(project === undefined ? {} : { project }),
    },
    (tx): Result.Result<{ readonly value: void; readonly drafts: readonly EventDraft[] }> => {
      if (tx.store.get(CHANGE, changeId) === undefined)
        return Result.succeed({ value: undefined, drafts: [] });
      const previewed = PreviewDeployed.make({
        deploymentId: notice.deploymentId,
        changeId,
        candidateId: notice.candidateId,
        world: PREVIEW_WORLD,
        target: notice.target,
        provider: "cloudflare",
        url: notice.url,
        ...(notice.aliasUrl === undefined ? {} : { aliasUrl: notice.aliasUrl }),
      });
      return Result.succeed({
        value: undefined,
        drafts: [{ payload: payloadOf(encodePreviewed(previewed)) }],
      });
    },
  );
});
