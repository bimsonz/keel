// Control for R1: the domain reaches into the application, imports a
// framework, and takes a non-allowlisted name from effect.
import { Effect } from "effect";
import { Hono } from "hono";
import { clock } from "../../application/ports/clock.ts";

export const bad = [Effect, Hono, clock];
