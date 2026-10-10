import { appFor } from "./composition/isolate.ts";

export default {
  fetch(request, env, ctx): Response | Promise<Response> {
    return appFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
