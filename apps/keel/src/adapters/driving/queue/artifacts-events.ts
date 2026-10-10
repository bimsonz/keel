import { WorkspaceForked, WorkspacePushed } from "@keeltown/core/domain/coordination";
import { CommitSha, isId } from "@keeltown/core/kernel";
import { Option, Schema } from "effect";

/**
 * Artifacts' account and repository events, as Queues delivers them (event
 * schema version 1). Third-party payloads are decoded with Effect Schema at the
 * doorway and translated into Keel events; anything else is dropped.
 */
const Source = Schema.Struct({ type: Schema.String, namespace: Schema.String, repoName: Schema.String });

export const ArtifactsRepoForked = Schema.Struct({
  type: Schema.Literal("cf.artifacts.repo.forked"),
  source: Source,
  payload: Schema.Struct({ namespace: Schema.String, repoName: Schema.String, repoId: Schema.String }),
});

export const ArtifactsRepoPushed = Schema.Struct({
  type: Schema.Literal("cf.artifacts.repo.pushed"),
  source: Source,
  payload: Schema.Struct({ ref: Schema.String, before: Schema.String, after: Schema.String }),
});

const ArtifactsEvent = Schema.Union([ArtifactsRepoForked, ArtifactsRepoPushed]);

/** Workspace repos are named `ws-<ULID>`; the workspace id is `wsp_<ULID>`. */
function workspaceIdOf(repoName: string) {
  const ulid = /^ws-([0-9A-HJKMNP-TV-Z]{26})$/.exec(repoName)?.[1];
  const id = ulid === undefined ? "" : `wsp_${ulid}`;
  return isId("wsp", id) ? id : null;
}

/** An Artifacts event as the Keel event it means, or null when it means nothing to Keel. */
export function translateArtifactsEvent(raw: unknown): typeof WorkspaceForked.Type | typeof WorkspacePushed.Type | null {
  const decoded = Schema.decodeUnknownOption(ArtifactsEvent)(raw);
  if (Option.isNone(decoded)) return null;
  const event = decoded.value;
  if (event.type === "cf.artifacts.repo.forked") {
    const workspaceId = workspaceIdOf(event.payload.repoName);
    if (workspaceId === null) return null;
    return WorkspaceForked.make({
      workspaceId,
      repo: `${event.payload.namespace}/${event.payload.repoName}`,
      sourceRepo: `${event.source.namespace}/${event.source.repoName}`,
    });
  }
  const workspaceId = workspaceIdOf(event.source.repoName);
  const sha = Schema.decodeUnknownOption(CommitSha)(event.payload.after);
  if (workspaceId === null || Option.isNone(sha)) return null;
  return WorkspacePushed.make({ workspaceId, ref: event.payload.ref, sha: sha.value });
}
