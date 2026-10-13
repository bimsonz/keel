import {
  CodeHost,
  RepoServer,
  UPLOAD_PACK_ANSWER_TYPE,
  UPLOAD_PACK_REQUEST_TYPE,
  type UploadPackAnswer,
  type UploadPackRequest,
} from "@keeltown/core/ports";
import { concat, mainOnly } from "@keeltown/gitcore";
import { Effect, Layer } from "effect";

/** How long the read token minted for one upload-pack request lives. */
export const CLONE_TOKEN_TTL_SECONDS = 60;

/**
 * The most of a host's answer that is held to be rewritten: a list of refs,
 * never a pack. A repo Keel serves holds a handful of refs, so a megabyte of
 * them is not a list this adapter wrote the rules for.
 */
export const MAX_REF_LIST_BYTES = 1024 * 1024;

/** The host answered something other than a git response: nothing of it is passed on. */
const BAD_GATEWAY: UploadPackAnswer = { status: 502, contentType: "text/plain", body: null };

/** A response body as chunks; leaving the loop early cancels the host's stream. */
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The whole of a body no longer than `limit`, or null once it is longer; the host's stream is let go either way. */
async function whole(body: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of body) {
    size += part.length;
    if (size > limit) return null;
    parts.push(part);
  }
  return concat(parts);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * RepoServer over the code host's own smart-HTTP remote: each request is
 * forwarded with a read token minted for it and gone in a minute, so no
 * credential outlives the request and none can write. What lists the repo's
 * refs is rewritten to main alone (gitcore's `mainOnly`): the host's
 * advertisement and its answer to the one `ls-refs` it is asked are held, up
 * to `MAX_REF_LIST_BYTES`, and a pack is streamed and never held. Redirects are never
 * followed, and of the host's answer only the body is kept, and only when the
 * host answered 200 with the content type git fixes for that request: its
 * status line, cookies, challenges and locations stop here. Neither the token
 * nor the remote, which carries the account id, is put in an error or a log.
 */
export const RepoServerArtifacts = (fetcher: typeof fetch = (input, init) => fetch(input, init)) =>
  Layer.effect(
    RepoServer,
    Effect.gen(function* () {
      const host = yield* CodeHost;
      return RepoServer.of({
        uploadPack: (repo, asked: UploadPackRequest) =>
          Effect.gen(function* () {
            const { request, rewrite } = mainOnly(asked);
            const info = yield* host.info(repo);
            const token = yield* host.mintToken(repo, "read", CLONE_TOKEN_TTL_SECONDS);
            const expected = UPLOAD_PACK_ANSWER_TYPE[request.service];
            const headers = new Headers({
              Authorization: `Bearer ${token.token}`,
              Accept: expected,
            });
            if (request.protocol !== null) headers.set("Git-Protocol", request.protocol);
            if (request.service === "negotiate")
              headers.set("Content-Type", UPLOAD_PACK_REQUEST_TYPE);
            const answered = yield* Effect.tryPromise({
              try: () =>
                request.service === "advertise"
                  ? fetcher(`${info.remote}/info/refs?service=git-upload-pack`, {
                      headers,
                      redirect: "manual",
                    })
                  : fetcher(`${info.remote}/git-upload-pack`, {
                      method: "POST",
                      headers,
                      body: request.body ?? new Uint8Array(),
                      redirect: "manual",
                    }),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(null)));
            if (answered === null) return BAD_GATEWAY;
            const type = answered.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
            if (answered.status !== 200 || type !== expected || answered.body === null) {
              yield* Effect.promise(
                async () => await answered.body?.cancel().catch(() => undefined),
              );
              return BAD_GATEWAY;
            }
            const body = chunks(answered.body);
            if (rewrite === null)
              return { status: 200, contentType: expected, body } satisfies UploadPackAnswer;
            const held = yield* Effect.promise(() => whole(body, MAX_REF_LIST_BYTES));
            const shown = held === null ? null : rewrite(held);
            if (shown === null) return BAD_GATEWAY;
            return {
              status: 200,
              contentType: expected,
              body: once(shown),
            } satisfies UploadPackAnswer;
          }),
      });
    }),
  );
