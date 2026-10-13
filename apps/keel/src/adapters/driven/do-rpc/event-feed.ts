import { EventFeed } from "@keeltown/core/ports";
import { Layer } from "effect";
import { type ProjectorRead, ProjectorCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Projector DO method the isolate calls, answering an Exit envelope. */
export interface ProjectorStub {
  read(request: typeof ProjectorRead.Encoded): Promise<unknown>;
}

/**
 * `EventFeed` over the one Projector DO (`projector`), whose waiter holds a
 * read until an event arrives or the deadline passes. The cursor is checked at
 * the doorway, so the DO's own decode never sees one that is not a position.
 */
export function EventFeedRpc(projector: () => ProjectorStub): Layer.Layer<EventFeed> {
  return Layer.succeed(
    EventFeed,
    EventFeed.of({
      read: ({ cursor, limit, waitSeconds, project }) =>
        callObject(ProjectorCodecs.read, () =>
          projector().read({
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
            waitMs: waitSeconds * 1000,
            ...(project === undefined ? {} : { project }),
          }),
        ),
    }),
  );
}
