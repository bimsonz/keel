import { Hono } from "hono";
import { makeStore, type ItemStore } from "./store";

export function createApp(store: ItemStore = makeStore()) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/items", (c) => c.json(store.list()));
  app.post("/items", async (c) => {
    const body = await c.req.json<{ name?: unknown; qty?: unknown }>();
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ error: "name required" }, 400);
    }
    const qty = typeof body.qty === "number" ? body.qty : 1;
    if (!Number.isInteger(qty) || qty < 0) return c.json({ error: "bad qty" }, 400);
    return c.json(store.add(body.name, qty), 201);
  });
  app.get("/items/:id", (c) => {
    const item = store.get(Number(c.req.param("id")));
    return item ? c.json(item) : c.json({ error: "not found" }, 404);
  });
  app.delete("/items/:id", (c) => {
    const ok = store.remove(Number(c.req.param("id")));
    return ok ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });
  return app;
}
