// The Worker's entry. Everything it does is in handler.ts, which needs nothing
// of the Workers runtime but fetch, so it is tested as it is.

import { createConsole } from "./handler.ts";

const mission = createConsole();

export default {
  fetch: (request, env) => mission.fetch(request, env),
} satisfies ExportedHandler<Env>;
