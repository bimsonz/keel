import { EventFeed } from "@keeltown/core/ports";
import { Layer } from "effect";
import { type ProjectorRead, ProjectorCodecs } from "../../../rpc/index.ts";
import { callHeldRead } from "./answer.ts";

/** The Projector DO method the isolate calls, answering an Exit envelope. */
export interface ProjectorStub {
  read(request: typeof ProjectorRead.Encoded): Promise<unknown>;
}

/**
 * `EventFeed` over the one Projector DO (`projector`), whose waiter holds a
 * read until an event arrives or the deadline passes. The cursor is checked at
 * the doorway, so the DO's own decode never sees one that is not a position.
 *
 * A read the Projector restarts under is read again with no wait
 * (`callHeldRead`). From a position that loses nothing. From `end` it is the
 * feed's end at the second read, as if the read had been asked then: only the
 * object knew where its wait began.
 */
export function EventFeedRpc(projector: () => ProjectorStub): Layer.Layer<EventFeed> {
  return Layer.succeed(
    EventFeed,
    EventFeed.of({
      read: ({ cursor, limit, waitSeconds, project }) =>
        callHeldRead(ProjectorCodecs.read, "feed", waitSeconds * 1000, (waitMs) =>
          projector().read({
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
            waitMs,
            ...(project === undefined ? {} : { project }),
          }),
        ),
    }),
  );
}
