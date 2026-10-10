import { Context, type Effect } from "effect";
import type { CommitSha, Instant } from "../../domain/kernel/index.ts";

export interface RepoRef {
  readonly namespace: string;
  readonly name: string;
}

export interface RepoToken {
  readonly token: string;
  readonly access: "read" | "write";
  readonly expiresAt: Instant;
}

export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly type: "blob" | "tree";
}

/** Repositories on the code host: create, fork, mint scoped tokens, read. **Never writes**: every write is a git push. */
export class CodeHost extends Context.Service<CodeHost, {
  readonly create: (repo: RepoRef) => Effect.Effect<RepoRef>;
  readonly fork: (source: RepoRef, target: RepoRef) => Effect.Effect<RepoRef>;
  readonly mintToken: (repo: RepoRef, access: "read" | "write", ttlSeconds: number) => Effect.Effect<RepoToken>;
  readonly head: (repo: RepoRef, ref: string) => Effect.Effect<CommitSha>;
  readonly readTree: (repo: RepoRef, commit: CommitSha) => Effect.Effect<readonly TreeEntry[]>;
  readonly readBlob: (repo: RepoRef, oid: string) => Effect.Effect<Uint8Array>;
}>()("keel/CodeHost") {}
