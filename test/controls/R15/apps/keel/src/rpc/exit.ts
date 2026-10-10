// Control for R15: an rpc contract imports a driven adapter and the ports.
import { Clock } from "@keeltown/core/ports";
import { systemLive } from "../adapters/driven/system.ts";

export const bad = [Clock, systemLive];
