import { projectRepos } from "@keeltown/core/application/integration";
import type { Namespaces, ProjectNamespaces, Projects } from "@keeltown/core/ports";
import { type Effect, Result } from "effect";
import { decideEach, projectByName } from "./authorize-handlers.ts";
import type { CloneAccess, GitClone } from "./git-clone.ts";
import type { BoundGate } from "./route-deps.ts";

/**
 * The token a git client's Basic credential carries: its password, whatever
 * the username. Null when the header is not a readable `user:password`.
 */
function basicPassword(header: string): string | null {
  const encoded = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header)?.[1];
  if (encoded === undefined) return null;
  try {
    const pair = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
    const colon = pair.indexOf(":");
    return colon < 0 ? null : pair.slice(colon + 1);
  } catch {
    return null;
  }
}

/**
 * The request the gate is asked about: this one's credential and nothing
 * else of it. Stock git answers a Basic challenge, so a Basic password is
 * presented as the bearer it is; a Bearer or DPoP header goes as it came.
 * A cookie is never passed on: a clone is not a page, and what the browser
 * would send by itself signs nobody in here.
 */
function credentialOf(request: Request): Request {
  const headers = new Headers();
  const sent = request.headers.get("authorization");
  if (sent !== null) {
    const basic = /^Basic\b/i.test(sent);
    // A Basic header that carries no password is still a credential presented: the gate refuses it.
    headers.set("authorization", basic ? `Bearer ${basicPassword(sent) ?? ""}` : sent);
    const proof = request.headers.get("dpop");
    if (!basic && proof !== null) headers.set("dpop", proof);
  }
  return new Request(request.url, { method: "GET", headers });
}

/**
 * Who may fetch `<namespace>/<project>.git`, decided as the API decides a
 * read of that project and by nothing else: the credential passes the API's
 * own gate, the project is found as `/v1/namespaces/{handle}/projects/{name}`
 * finds it, and the policy's read rule answers. What is granted is the
 * project's trunk, never its staging or a workspace.
 *
 * With no credential a project that cannot be read, or is not there, asks
 * for one (git sends none until it is asked); with a credential the two read
 * the same, as not found. A credential the gate refuses is asked for again,
 * never read as nobody's; one it could not check says to try again.
 */
export function cloneAccess(
  gate: BoundGate,
  run: <A>(
    effect: Effect.Effect<A, never, ProjectNamespaces | Namespaces | Projects>,
  ) => Promise<A>,
): GitClone["access"] {
  return async (request, namespace, project): Promise<CloneAccess> => {
    // The gate's own refusal is never shown to a git client, so the id it is given names nothing.
    const gated = await gate(credentialOf(request), crypto.randomUUID());
    if (gated instanceof Response)
      return { kind: gated.status === 503 ? "unavailable" : "unauthenticated" };
    const { principal } = gated.admitted;
    const resource = await run(projectByName(namespace, project));
    if (resource._tag === "Project" && Result.isSuccess(decideEach(principal, resource)))
      return { kind: "granted", repo: projectRepos(resource.projectId).trunk };
    return { kind: principal._tag === "Anonymous" ? "unauthenticated" : "not-found" };
  };
}
