import { ownerOfRepo } from "@keeltown/core/application/coordination";
import { CommitSha, type ProjectId } from "@keeltown/core/kernel";
import type { ObservedPush } from "@keeltown/core/ports";
import { Option, Schema } from "effect";

/**
 * Artifacts' `pushed` event (event schema version 1), as a namespace-wide
 * `triggers.events` rule delivers it. Third-party payloads are decoded with
 * Effect Schema at the doorway and translated into Keel's terms; anything
 * else is dropped. Forks are not observed here: the WorkspacePool DO emits
 * WorkspaceForked when its own fork call resolves (spike S2).
 */
export const ArtifactsRepoPushed = Schema.Struct({
  type: Schema.Literal("cf.artifacts.repo.pushed"),
  // Delivered on staging (11 Oct): `source` is `{ namespace, repoName }`, with no `type`.
  source: Schema.Struct({ namespace: Schema.String, repoName: Schema.String }),
  payload: Schema.Struct({ ref: Schema.String, before: Schema.String, after: Schema.String }),
});

/** A push to a workspace's branch, and the project whose pool holds the workspace. */
export interface WorkspacePush {
  readonly projectId: ProjectId;
  readonly push: ObservedPush;
}

const DELETED = /^0+$/;
/** Refs Keel itself writes into a workspace (`keel/trunk`, a rebase's trunk head): never an agent's push. */
const KEELS = "refs/heads/keel/";

/**
 * A push to a workspace's branch, its project read from the repo's name
 * (`<prj>-ws-<ulid>`); null for tags, notes, deletions, Keel's own
 * `refs/heads/keel/*` (no self-loops), a sketch's or any
 * other repo (the mirror, a name Keel never gave) and anything unreadable.
 * Whether the workspace is granted, so the push is an agent's, is the pool's
 * to decide.
 */
export function translateArtifactsPush(raw: unknown): WorkspacePush | null {
  const decoded = Schema.decodeUnknownOption(ArtifactsRepoPushed)(raw);
  if (Option.isNone(decoded)) return null;
  const { source, payload } = decoded.value;
  if (!payload.ref.startsWith("refs/heads/") || payload.ref.startsWith(KEELS)) return null;
  if (DELETED.test(payload.after)) return null;
  const owner = ownerOfRepo(source.repoName);
  const sha = Schema.decodeUnknownOption(CommitSha)(payload.after);
  if (owner?.kind !== "workspace" || Option.isNone(sha)) return null;
  return {
    projectId: owner.projectId,
    push: { workspaceId: owner.id, ref: payload.ref, sha: sha.value },
  };
}
