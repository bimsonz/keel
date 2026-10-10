// keel-spike-03-forker: forks a repo through the ARTIFACTS binding and reports
// the fork's metadata, read only through `handle.info()`. Also exposes the
// binding's `log()` so the server-side view of a shallow repo can be seen.
// Every call needs the `x-spike-key` header to match the SPIKE_KEY secret.
interface Env {
  ARTIFACTS: Artifacts;
  SPIKE_KEY?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json" } });

const errBody = (e: unknown) => {
  const x = e as { name?: string; code?: string; message?: string };
  return { error: x.name ?? "Error", code: x.code ?? null, message: x.message ?? String(e) };
};

async function getWhenReady(env: Env, name: string, deadlineMs = 60_000): Promise<{ handle: ArtifactsRepo; waitedMs: number; polls: number }> {
  const t0 = Date.now();
  let polls = 0;
  for (;;) {
    polls++;
    try {
      return { handle: await env.ARTIFACTS.get(name), waitedMs: Date.now() - t0, polls };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code === "FORK_IN_PROGRESS" || code === "CREATE_IN_PROGRESS") && Date.now() - t0 < deadlineMs) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      throw e;
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.SPIKE_KEY || req.headers.get("x-spike-key") !== env.SPIKE_KEY) return json({ error: "forbidden" }, 403);
    const url = new URL(req.url);
    const p = url.searchParams;
    try {
      switch (url.pathname) {
        case "/fork": {
          const src = p.get("src") ?? "";
          const name = p.get("name") ?? "";
          const t0 = Date.now();
          using source = await env.ARTIFACTS.get(src);
          await source.fork(name, { defaultBranchOnly: p.get("all") !== "1" });
          const forkMs = Date.now() - t0;
          const { handle, waitedMs, polls } = await getWhenReady(env, name);
          using fork = handle;
          const info = await fork.info();
          return json({ forkMs, readyAfterMs: waitedMs, polls, info });
        }
        case "/info": {
          using h = await env.ARTIFACTS.get(p.get("name") ?? "");
          return json(await h.info());
        }
        case "/log": {
          using h = await env.ARTIFACTS.get(p.get("name") ?? "");
          const log = await h.log({ ref: p.get("ref") ?? "main", limit: Number(p.get("limit") ?? 5) });
          return json(log.map((c) => ({ hash: c.hash, parents: c.parents, message: c.message })));
        }
        case "/commit": {
          using h = await env.ARTIFACTS.get(p.get("name") ?? "");
          return json(await h.readCommit(p.get("hash") ?? ""));
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json(errBody(e), 500);
    }
  },
} satisfies ExportedHandler<Env>;
