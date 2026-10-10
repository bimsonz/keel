// Readiness of a fork: `get()` must stop throwing AND `readCommit(head)` must
// resolve to the expected commit. Either leg failing means "not ready".

export type Readiness = { ready: true } | { ready: false; reason: string };

export function errCode(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { code?: unknown; message?: unknown };
    if (typeof o.code === "string") return o.code;
    if (typeof o.message === "string") return `ERR(${o.message.slice(0, 80)})`;
  }
  return `ERR(${String(e).slice(0, 80)})`;
}

function dispose(x: unknown): void {
  const d = (x as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose];
  if (typeof d === "function") {
    try {
      d.call(x);
    } catch {
      // stub already released
    }
  }
}

export async function checkReady(ns: Artifacts, name: string, head: string): Promise<Readiness> {
  let repo: ArtifactsRepo;
  try {
    repo = await ns.get(name);
  } catch (e) {
    return { ready: false, reason: `get:${errCode(e)}` };
  }
  try {
    const c = await repo.readCommit(head);
    if (!c) return { ready: false, reason: "readCommit:null" };
    if (c.hash !== head) return { ready: false, reason: "readCommit:mismatch" };
    return { ready: true };
  } catch (e) {
    return { ready: false, reason: `readCommit:${errCode(e)}` };
  } finally {
    dispose(repo);
  }
}

export { dispose };
