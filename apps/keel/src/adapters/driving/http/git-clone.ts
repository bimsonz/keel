import {
  type RepoRef,
  UPLOAD_PACK_REQUEST_TYPE,
  type UploadPackAnswer,
  type UploadPackRequest,
} from "@keeltown/core/ports";
import type { Hono } from "hono";
import type { AppEnv } from "../../../generated/http/runtime.gen.ts";

/** The largest negotiation a git client may send, counted after any gzip is undone. */
export const MAX_UPLOAD_PACK_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Whether the caller may fetch `org/project`, and which repo that is.
 * `unauthenticated` asks the git client for a credential; `not-found` is a
 * repo the caller cannot see, missing or not.
 */
export type CloneAccess =
  | { readonly kind: "granted"; readonly repo: RepoRef }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "not-found" };

/** What the git routes need of the application. */
export interface GitClone {
  readonly access: (request: Request, org: string, project: string) => Promise<CloneAccess>;
  /** RepoServer's `uploadPack`; null when the host has no such repo. */
  readonly uploadPack: (
    repo: RepoRef,
    request: UploadPackRequest,
  ) => Promise<UploadPackAnswer | null>;
}

const text = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(`${message}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

const readOnly = () =>
  text(
    403,
    "Keel serves git fetches only. To land a change, declare it, push to its workspace and submit it.",
  );
const notFound = () => text(404, "Repository not found.");
const tooLarge = () => text(413, "The request exceeds 8 MiB.");

/** The client's protocol version as git sends it, or null: nothing else of the header is passed on. */
const protocolOf = (request: Request): string | null => {
  const sent = request.headers.get("git-protocol");
  return sent !== null && /^version=[12]$/.test(sent) ? sent : null;
};

/** A negotiation's pkt-lines, gunzipped when the client compressed them, or the response that refuses them. */
async function negotiation(request: Request): Promise<Uint8Array | Response> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== UPLOAD_PACK_REQUEST_TYPE)
    return text(415, `A fetch is sent as ${UPLOAD_PACK_REQUEST_TYPE}.`);
  const encoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip")
    return text(415, "A fetch's body is sent as it is or gzipped.");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_UPLOAD_PACK_REQUEST_BYTES)
    return tooLarge();
  if (request.body === null) return new Uint8Array();
  const reader = (
    encoding === "gzip" ? request.body.pipeThrough(new DecompressionStream("gzip")) : request.body
  ).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_UPLOAD_PACK_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      parts.push(next.value);
    }
  } catch {
    return text(400, "The request's body could not be read.");
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body;
}

/** The host's chunks as a response body; a client that goes away stops the host's stream. */
function streamOf(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function serve(
  git: GitClone,
  request: Request,
  org: string,
  repo: string,
  service: UploadPackRequest["service"],
): Promise<Response> {
  const access = await git.access(request, org, repo.slice(0, -".git".length));
  if (access.kind === "unauthenticated")
    return text(401, "Authentication required.", { "WWW-Authenticate": 'Basic realm="Keel"' });
  if (access.kind === "not-found") return notFound();
  const body = service === "negotiate" ? await negotiation(request) : null;
  if (body instanceof Response) return body;
  const answer = await git.uploadPack(access.repo, {
    service,
    protocol: protocolOf(request),
    body,
  });
  if (answer === null) return notFound();
  if (answer.status !== 200 || answer.body === null)
    return text(502, "The repository host did not answer.");
  return new Response(streamOf(answer.body), {
    status: 200,
    headers: {
      "Content-Type": answer.contentType,
      "Cache-Control": "no-cache, max-age=0, must-revalidate",
    },
  });
}

/**
 * The clone URL, `/<org>/<project>.git`: git's smart-HTTP fetch and nothing
 * else. A push (either receive-pack request) is refused before anything is
 * looked up or read, and so is the dumb protocol. A fetch is decided by
 * `access`, then answered by the repo's host through `uploadPack`: the
 * response carries the host's bytes under the content type git fixes, and no
 * header of the host's. Register it ahead of the 1 MiB body limit: a
 * negotiation has its own cap.
 */
export function registerGitClone(app: Hono<AppEnv>, git: GitClone): void {
  const repo = "/:org/:repo{[^/]+\\.git}";
  app.get(`${repo}/info/refs`, async (c) => {
    const service = c.req.query("service");
    if (service === "git-receive-pack") return readOnly();
    if (service !== "git-upload-pack")
      return text(403, "Keel serves git's smart HTTP protocol only.");
    return await serve(git, c.req.raw, c.req.param("org"), c.req.param("repo"), "advertise");
  });
  app.post(`${repo}/git-upload-pack`, async (c) =>
    serve(git, c.req.raw, c.req.param("org"), c.req.param("repo"), "negotiate"),
  );
  app.all(`${repo}/git-receive-pack`, () => readOnly());
}
