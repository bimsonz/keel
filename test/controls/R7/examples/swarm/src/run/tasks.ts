// Control for R7: an example's plain module (not a doorway, the composition root, an agent or app.ts) reading the Worker's bindings.
import { env } from "cloudflare:workers";

export const host = env;
