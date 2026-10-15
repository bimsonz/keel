// The Worker's entry. Everything it does is in handler.ts, which needs nothing
// of the Workers runtime but fetch, so it is tested as it is; a project's card
// is the one thing it needs of the runtime besides, given here: the Cache API
// and HTMLRewriter.

import type { Card } from "./cards.ts";
import { tagsOf } from "./cards.ts";
import { createConsole } from "./handler.ts";

/** The served page with its card's tags, and its title, rewritten as it streams. */
function retag(page: Response, card: Card, url: string, image: string): Response {
  let rewriter = new HTMLRewriter().on("title", {
    element: (element) => {
      element.setInnerContent(card.title);
    },
  });
  for (const { selector, content } of tagsOf(card, url, image))
    rewriter = rewriter.on(selector, {
      element: (element) => {
        element.setAttribute("content", content);
      },
    });
  return rewriter.transform(page);
}

const mission = createConsole({ cache: caches.default, retag });

export default {
  fetch: (request, env, context) => mission.fetch(request, env, context),
} satisfies ExportedHandler<Env>;
