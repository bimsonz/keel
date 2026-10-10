// Tells forge-lite worlds apart over HTTP.
//
// classify(): a stateless check that needs no setup and survives isolate
// churn. An anonymous DELETE on the revoke route answers Hono's default 404
// (404, text/plain, "404 Not Found") when the route does not exist (base),
// and problem+json when it does (world A: the route runs and reports the
// missing repository). Same rule as scenarios/run-probe.mjs uses for n/a.
//
// revokeFlow(): the real thing, end to end: sign up alice and bob, create a
// public repo, add bob as admin, revoke him. 204 only in a world with the
// route. State is in-memory per isolate, so every step must reach the same
// isolate; a step that loses state is reported, not hidden.

export type World = "base" | "A" | "unknown";

export async function classify(baseUrl: string, headers: Record<string, string> = {}): Promise<{ world: World; status: number; contentType: string; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/repos/keel/probe/collaborators/nobody`, { method: "DELETE", headers });
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const ms = Math.round(performance.now() - t0);
  let world: World = "unknown";
  if (res.status === 404 && contentType.startsWith("text/plain") && body === "404 Not Found") world = "base";
  else if (contentType.startsWith("application/problem+json")) world = "A";
  return { world, status: res.status, contentType, ms };
}

export async function revokeFlow(baseUrl: string): Promise<Array<{ step: string; status: number; detail?: string }>> {
  const tag = Math.random().toString(36).slice(2, 8);
  const alice = `alice${tag}`;
  const bob = `bob${tag}`;
  const steps: Array<{ step: string; status: number; detail?: string }> = [];
  const call = async (step: string, method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let detail: string | undefined;
    try {
      detail = (JSON.parse(text) as { detail?: string }).detail;
    } catch {
      detail = text.slice(0, 60) || undefined;
    }
    steps.push({ step, status: res.status, ...(detail && res.status >= 400 ? { detail } : {}) });
    return text;
  };
  const password = "correct horse battery staple";
  await call("sign up alice", "POST", "/users", { username: alice, password });
  await call("sign up bob", "POST", "/users", { username: bob, password });
  const session = await call("alice logs in", "POST", "/sessions", { username: alice, password });
  let token: string | undefined;
  try {
    token = (JSON.parse(session) as { token?: string }).token;
  } catch {
    token = undefined;
  }
  await call("alice creates forge", "POST", "/repos", { name: "forge", visibility: "public" }, token);
  await call("alice adds bob as admin", "PUT", `/repos/${alice}/forge/collaborators/${bob}`, { role: "admin" }, token);
  await call("alice revokes bob", "DELETE", `/repos/${alice}/forge/collaborators/${bob}`, undefined, token);
  return steps;
}
