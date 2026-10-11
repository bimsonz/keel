import { env } from "cloudflare:workers";
import { EventEnvelope } from "@keeltown/core/kernel";
import { PORTS } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { EventFeedRpc } from "../../src/adapters/driven/do-rpc/event-feed.ts";

/** The one Projector every object's outbox delivers to. */
const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));

// The real adapter passes the same contract as the in-memory one: an event arrives as an outbox delivers it.
PORTS.EventFeed.contract("Projector DO over RPC", () => ({
  layer: EventFeedRpc(projector),
  arrive: (event) =>
    Effect.promise(async () => {
      await projector().receive([Schema.encodeSync(EventEnvelope)(event)]);
    }),
}));
