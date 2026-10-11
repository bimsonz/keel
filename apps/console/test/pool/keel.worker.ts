// A stand-in for Keel, bound where production binds the `keel` Worker. It
// keeps what reached it, so a test can ask what the console's Worker sent.
// Served as one file with its types stripped, so it imports nothing.

interface Seen {
  method: string;
  path: string;
  host: string;
  authorization: string | null;
}

const OBSERVER_TOKEN = "tok_observer";
const seen: Seen[] = [];

const problem = (status: number, code: string): Response =>
  Response.json(
    { code, status },
    { status, headers: { "content-type": "application/problem+json" } },
  );

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The test's own questions are not Keel's routes, and are not kept.
    if (url.pathname === "/test/seen") return Response.json(seen);
    if (url.pathname === "/test/forget") {
      seen.length = 0;
      return new Response(null, { status: 204 });
    }
    seen.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      host: url.host,
      authorization: request.headers.get("authorization"),
    });
    if (url.pathname === "/v1/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (
        form.get("client_id") !== "observer-id" ||
        form.get("client_secret") !== "observer-secret"
      )
        return Response.json({ error: "invalid_client" }, { status: 401 });
      return Response.json({
        access_token: OBSERVER_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "observer",
      });
    }
    if (url.pathname === "/v1/events" && request.method === "GET") {
      // Keel's log is read by an observer or an agent, and by nobody else.
      if (request.headers.get("authorization") !== `Bearer ${OBSERVER_TOKEN}`)
        return problem(401, "auth.unauthenticated");
      return Response.json({ items: [], nextCursor: "0" });
    }
    // One public project's repository, read by anyone.
    if (url.pathname === "/v1/projects/prj_PUBLIC/repo/tree" && request.method === "GET")
      return Response.json({
        commit: "c".repeat(40),
        path: url.searchParams.get("path") ?? "",
        entries: [],
      });
    return problem(404, "resource.not_found");
  },
};
