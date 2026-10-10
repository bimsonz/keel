// Control for R3: a driving adapter imports a driven adapter directly,
// bypassing composition.
import { systemLive } from "../../driven/system.ts";

export const handlers = { systemLive };
