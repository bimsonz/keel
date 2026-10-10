// Control for R2: a use-case imports the generated wire types and a framework.
import { Hono } from "hono";
import { registerRoutes } from "../../../../../apps/keel/src/generated/http/app.gen.ts";

export const bad = [Hono, registerRoutes];
