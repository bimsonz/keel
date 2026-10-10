import { WorkspacePushed } from "@keeltown/core/domain/coordination";
import { CommitSha, isId } from "@keeltown/core/kernel";
import { Option, Schema } from "effect";

/**
 * Artifacts' `pushed` event (event schema version 1), as a namespace-wide
 * `triggers.events` rule delivers it. Third-party payloads are decoded with
 * Effect Schema at the doorway and translated into Keel events; anything
 * else is dropped. Forks are not observed here: the WorkspacePool DO emits
 * WorkspaceForked when its own fork call resolves (spike S2).
 */
export const ArtifactsRepoPushed = Schema.Struct({
  type: Schema.Literal("cf.artifacts.repo.pushed"),
  source: Schema.Struct({ type: Schema.String, namespace: Schema.String, repoName: Schema.String }),
  payload: Schema.Struct({ ref: Schema.String, before: Schema.String, after: Schema.String }),
});

/** Workspace repos are named `ws-<ULID>`; the workspace id is `wsp_<ULID>`. */
function workspaceIdOf(repoName: string) {
  const ulid = /^ws-([0-9A-HJKMNP-TV-Z]{26})$/.exec(repoName)?.[1];
  const id = ulid === undefined ? "" : `wsp_${ulid}`;
  return isId("wsp", id) ? id : null;
}

const DELETED = /^0+$/;

/** A push to a workspace branch as WorkspacePushed; null for tags, notes, deletions, other repos and anything unreadable. */
export function translateArtifactsPush(raw: unknown): typeof WorkspacePushed.Type | null {
  const decoded = Schema.decodeUnknownOption(ArtifactsRepoPushed)(raw);
  if (Option.isNone(decoded)) return null;
  const { source, payload } = decoded.value;
  if (!payload.ref.startsWith("refs/heads/") || DELETED.test(payload.after)) return null;
  const workspaceId = workspaceIdOf(source.repoName);
  const sha = Schema.decodeUnknownOption(CommitSha)(payload.after);
  if (workspaceId === null || Option.isNone(sha)) return null;
  return WorkspacePushed.make({ workspaceId, ref: payload.ref, sha: sha.value });
}
