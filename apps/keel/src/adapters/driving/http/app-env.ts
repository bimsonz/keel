import type { AgentToken } from "./caller.ts";

/** What every route sees on the Hono context: the Worker's bindings and per-request variables. */
declare module "../../../generated/http/runtime.gen.ts" {
  interface AppEnv {
    Bindings: Env;
    Variables: {
      requestId: string;
      principal: AgentToken | undefined;
    };
  }
}
