import { setProvider } from "@flue/runtime";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import { createAgentRouter } from "@flue/runtime/routing";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import * as v from "valibot";
import { admitted } from "./admin.ts";
import { Coder } from "./agents/coder.ts";
import { gated } from "./run/gate.ts";

const director = () => env.DIRECTOR.get(env.DIRECTOR.idFromName("director"));

// Every model call takes one of the run's slots first. No AI Gateway: nothing
// is made on the account that its Terraform doesn't name.
setProvider(
  cloudflareBindingProvider({
    binding: gated(env.AI, {
      take: (id) => director().take(id),
      give: (id) => director().give(id),
    }),
    gateway: false,
  }),
);

const Shape = v.picklist(["one", "many"]);
const Enlist = v.object({
  shape: Shape,
  count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 1),
});
const Accept = v.object({ shape: Shape, project: v.string() });
const Start = v.object({
  shape: Shape,
  workers: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)),
  seed: v.pipe(v.number(), v.integer()),
  project: v.string(),
  rampMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(250))),
});

const app = new Hono();

app.get("/", (c) =>
  c.text(
    "keel-swarm: Keel's hosted coding agents. Every other route needs the swarm's admin bearer.\n",
  ),
);

app.use("*", async (c, next) => {
  if (c.req.path === "/") return next();
  const gate = await admitted(c.req.header("authorization"), env.SWARM_ADMIN_TOKEN);
  if (gate === "unset") return c.json({ error: "The swarm has no admin token set." }, 503);
  if (gate === "refused")
    return c.json({ error: "The swarm's admin bearer is required." }, 401, {
      "www-authenticate": "Bearer",
    });
  return next();
});

const body = async <T extends v.GenericSchema>(
  schema: T,
  request: Request,
): Promise<v.InferOutput<T>> => v.parse(schema, await request.json());

app.onError((error, c) => c.json({ error: error.message }, v.isValiError(error) ? 400 : 500));

app.get("/admin/agents", async (c) => c.json(await director().roster()));
app.post("/admin/agents", async (c) => {
  const { shape, count } = await body(Enlist, c.req.raw);
  return c.json(await director().enlist(shape, count));
});
app.delete("/admin/agents", async (c) => c.json(await director().forget()));
app.post("/admin/accept", async (c) => {
  const { shape, project } = await body(Accept, c.req.raw);
  return c.json({ accepted: await director().accept(shape, project) });
});
app.post("/admin/projects", async (c) => {
  const { name } = await body(
    v.object({ name: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)) }),
    c.req.raw,
  );
  return c.json(await director().ownProject(name), 201);
});
app.post("/admin/runs", async (c) => {
  const { rampMs, ...start } = await body(Start, c.req.raw);
  return c.json(
    await director().start({ ...start, ...(rampMs === undefined ? {} : { rampMs }) }),
    201,
  );
});
app.get("/admin/run", async (c) => c.json(await director().report()));
app.post("/admin/run/stop", async (c) => c.json(await director().stop()));

// The workers' conversations, behind the same bearer: an open prompt route would spend the account's model calls.
app.route("/agents/coder", createAgentRouter(Coder));

export default app;
