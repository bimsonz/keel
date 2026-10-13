import { Hono } from "hono";

/** What the Worker reads from its environment: one plain var, set in wrangler.jsonc. */
interface Env {
  readonly GREETING: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));
app.get("/", (c) => c.json({ greeting: c.env.GREETING }));

export default app;
