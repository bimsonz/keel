import { Context, type Effect } from "effect";
import type { RepoNotFound, RepoRef } from "./code-host.ts";

/** What a git client sends as `Content-Type` with a negotiation. */
export const UPLOAD_PACK_REQUEST_TYPE = "application/x-git-upload-pack-request";

/** The content type of each upload-pack answer, as gitprotocol-http fixes them. */
export const UPLOAD_PACK_ANSWER_TYPE = {
  advertise: "application/x-git-upload-pack-advertisement",
  negotiate: "application/x-git-upload-pack-result",
} as const;

/**
 * One request of a smart-HTTP fetch (gitprotocol-http): the ref advertisement
 * (`GET …/info/refs?service=git-upload-pack`) or a negotiation
 * (`POST …/git-upload-pack`). `protocol` is the client's `Git-Protocol`
 * header (`version=2`), or null for protocol v0. `body` is the negotiation's
 * pkt-lines, uncompressed, and null for the advertisement.
 */
export interface UploadPackRequest {
  readonly service: "advertise" | "negotiate";
  readonly protocol: string | null;
  readonly body: Uint8Array | null;
}

/**
 * The host's answer, with nothing of the host in it but the bytes: `status`
 * is 200 with `body` (the advertisement, or the negotiation's result with its
 * pack, as the host streams it) under `contentType`, or 502 with no body when
 * the host answered anything but a git response.
 */
export interface UploadPackAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: AsyncIterable<Uint8Array> | null;
}

/**
 * Serves a repo to a git client, for fetches only: there is no receive-pack
 * here, so nothing behind this port can write a repo. An adapter reads with a
 * credential of its own, minted for the one request, and never lets it, the
 * host's address or any header of the host's reach the answer.
 */
export class RepoServer extends Context.Service<
  RepoServer,
  {
    /** Answers one upload-pack request for `repo`. RepoNotFound: the host has no such repo. */
    readonly uploadPack: (
      repo: RepoRef,
      request: UploadPackRequest,
    ) => Effect.Effect<UploadPackAnswer, RepoNotFound>;
  }
>()("keel/RepoServer") {}
