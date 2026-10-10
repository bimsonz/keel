// Control for R5: core imports a runtime and a framework.
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

export const bad = [DurableObject, z];
