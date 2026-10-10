// Every child is a module Worker whose fetch() runs one tool on the request body.
// Wasm is instantiated lazily on the first request (not at module scope), so the
// first request's CPU time includes instantiation and startup limits stay out of it.

export type Child = { fetch(req: Request): Promise<Response> };

export function memoryOf(instance: WebAssembly.Instance | undefined): number | null {
  if (!instance) return null;
  for (const v of Object.values(instance.exports)) {
    if (v instanceof WebAssembly.Memory) return v.buffer.byteLength;
  }
  return null;
}

export function serve(
  tool: string,
  run: (input: string, url: URL) => unknown | Promise<unknown>,
  memory: () => number | null = () => null,
): Child {
  return {
    async fetch(req: Request): Promise<Response> {
      const input = req.method === "POST" ? await req.text() : "";
      try {
        const result = await run(input, new URL(req.url));
        return Response.json({ ok: true, tool, result, wasmMemoryBytes: memory() });
      } catch (e) {
        const err = e as Error;
        return Response.json(
          { ok: false, tool, error: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`, wasmMemoryBytes: memory() },
          { status: 500 },
        );
      }
    },
  };
}
