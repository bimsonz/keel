import {
  type AuthInfo,
  createMcpHandler,
  InMemoryServerEventBus,
  type McpHttpHandler,
  type McpRequestContext,
  type McpServer,
  type ServerEventBus,
} from "@modelcontextprotocol/server";
import type { Admitted } from "@keeltown/core/application/identity";
import type { AgentClaims } from "@keeltown/core/domain/identity";
import type { AgentId, ProjectId, RunId } from "@keeltown/core/kernel";

/** The inbox of the token's agent, as the token's run reads it. */
export const INBOX_URI = "keel://inbox";

/** A project's feed, as a resource template: `feedUri` is one project's address. */
export const FEED_TEMPLATE = "keel://projects/{projectId}/events";

export const feedUri = (projectId: string): string => `keel://projects/${projectId}/events`;

/** How long one held read of a watch waits: at its deadline the caller's standing is read again. */
export const HOLD_SECONDS = 30;

/** How long a listen stays open. It may outlive its five-minute token, since it carries addresses and never content. */
export const LISTEN_MS = 60 * 60 * 1000;

/**
 * The most reads one listen makes, each followed by a re-admission, so a
 * listen ends cleanly well inside the Worker's budget of calls a request.
 * A quiet hour of both watches is 240 reads; a busy one ends sooner, and
 * its client listens again.
 */
export const MAX_LISTEN_READS = 300;

/** One held read of a watch: the cursor to read on from, and whether anything arrived. */
export interface Watched {
  readonly cursor: string;
  readonly arrived: boolean;
}

/** The reads a listen holds, each from `cursor` for up to `seconds`. */
export interface Watches {
  /** The agent's inbox as `run` reads it, counting nothing as read: a listen shows no notice. */
  readonly inbox: (
    agentId: AgentId,
    cursor: string,
    seconds: number,
    run: RunId | undefined,
    signal: AbortSignal,
  ) => Promise<Watched>;
  /** The project's feed, every event of it: a caller with standing in the project reads it as a member. */
  readonly feed: (
    projectId: ProjectId,
    cursor: string,
    seconds: number,
    signal: AbortSignal,
  ) => Promise<Watched>;
  /** The caller admitted again from its token's claims alone, or null when that is refused. */
  readonly admit: (claims: AgentClaims) => Promise<Admitted | null>;
}

/**
 * Whether a caller may watch anything: an agent presenting its own token,
 * the one its key asked for (an enrolled agent's exchanged token says nothing
 * of a key, and a person watches nothing here), with standing in its token's
 * project.
 */
export function stands(admitted: Admitted): boolean {
  const { principal, token } = admitted;
  return (
    principal._tag === "Agent" && token?.bound !== undefined && principal.standing._tag !== "None"
  );
}

/**
 * What a caller may watch: its own inbox, and the feed of the one project its
 * token names. A paused agent watches its inbox alone, so it hears when it is
 * unpaused. The same rule admits a listen and keeps each watch open.
 */
export function watchable(admitted: Admitted): readonly string[] {
  if (!stands(admitted)) return [];
  const project = admitted.token?.projectId;
  return project === undefined || (admitted.principal._tag === "Agent" && admitted.principal.paused)
    ? [INBOX_URI]
    : [INBOX_URI, feedUri(project)];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A listen's body with the resources it asks to watch narrowed to `may`,
 * and the addresses left. The SDK honours any address it is given, so who
 * watches what is decided here, before it sees the request. A body that is
 * not a listen naming resources is handed on as it came, for the SDK to
 * answer.
 */
export function narrowListen(
  body: unknown,
  may: readonly string[],
): { readonly body: unknown; readonly watched: readonly string[] } {
  if (!isRecord(body) || !isRecord(body["params"])) return { body, watched: [] };
  const { params } = body;
  const notifications = params["notifications"];
  if (!isRecord(notifications)) return { body, watched: [] };
  const asked = notifications["resourceSubscriptions"];
  if (!Array.isArray(asked)) return { body, watched: [] };
  const watched = [
    ...new Set(asked.filter((uri): uri is string => typeof uri === "string" && may.includes(uri))),
  ];
  return {
    body: {
      ...body,
      params: { ...params, notifications: { ...notifications, resourceSubscriptions: watched } },
    },
    watched,
  };
}

/**
 * One `subscriptions/listen`, served by a handler made for it with its own
 * bus: a bus an isolate shared would carry one caller's notices to another.
 * The SDK subscribes to the bus once it has acknowledged what it honours,
 * and that is when the watches start: a held read on each watched object,
 * from its head (`end`), then from each answered cursor. The commit wakes a
 * read; its deadline is `HOLD_SECONDS`. A read that brings something
 * publishes `resources/updated` for its address. After every read the
 * caller is admitted again from its token's claims, and the stream ends at
 * once when that is refused or what it read is no longer `watchable` (a
 * paused agent's project feed, say). It ends too after
 * `LISTEN_MS`, or when `MAX_LISTEN_READS` are made. When the client goes,
 * the SDK unsubscribes, and the watches stop with it.
 */
export function serveListen(
  factory: (context: McpRequestContext) => McpServer,
  watches: Watches,
  request: Request,
  authInfo: AuthInfo,
  admitted: Admitted,
  asked: unknown,
): Promise<Response> {
  const { body, watched } = narrowListen(asked, watchable(admitted));
  const stopped = new AbortController();
  const bus = new InMemoryServerEventBus();
  let handler: McpHttpHandler | undefined;
  const end = () => {
    stopped.abort();
    // The SDK's own close: a last result frame, then the stream ends and it unsubscribes.
    void handler?.close();
  };
  const listening: ServerEventBus = {
    publish: (event) => bus.publish(event),
    subscribe: (listener) => {
      const unsubscribe = bus.subscribe(listener);
      const hour = setTimeout(end, LISTEN_MS);
      stopped.signal.addEventListener("abort", () => clearTimeout(hour), { once: true });
      void watch(watched, admitted, watches, stopped.signal, end, (uri) =>
        bus.publish({ kind: "resource_updated", uri }),
      );
      return () => {
        unsubscribe();
        stopped.abort();
      };
    },
  };
  handler = createMcpHandler(factory, { bus: listening });
  return handler.fetch(request, { authInfo, parsedBody: body });
}

async function watch(
  watched: readonly string[],
  admitted: Admitted,
  watches: Watches,
  signal: AbortSignal,
  end: () => void,
  publish: (uri: string) => void,
): Promise<void> {
  const { principal, token } = admitted;
  if (principal._tag !== "Agent" || token === undefined) return;
  const { projectId } = token;
  // What each address the caller may watch reads, from a cursor.
  const reads = new Map<string, (cursor: string) => Promise<Watched>>([
    [
      INBOX_URI,
      (cursor) => watches.inbox(principal.agentId, cursor, HOLD_SECONDS, token.run?.id, signal),
    ],
    ...(projectId === undefined
      ? []
      : [
          [
            feedUri(projectId),
            (cursor: string) => watches.feed(projectId, cursor, HOLD_SECONDS, signal),
          ] as const,
        ]),
  ]);
  let made = 0;
  const hold = async (uri: string, read: (cursor: string) => Promise<Watched>) => {
    let cursor = "end";
    while (!signal.aborted) {
      if (made >= MAX_LISTEN_READS) return end();
      made += 1;
      // oxlint-disable-next-line no-await-in-loop -- each hold reads on from the cursor the one before answered
      const page = await read(cursor);
      if (signal.aborted) return;
      cursor = page.cursor;
      // oxlint-disable-next-line no-await-in-loop -- the caller is admitted again at each read's end
      const again = await watches.admit(token);
      if (again === null || !watchable(again).includes(uri)) return end();
      if (page.arrived) publish(uri);
    }
  };
  await Promise.all(
    watched.flatMap((uri) => {
      const read = reads.get(uri);
      if (read === undefined) return [];
      return [
        hold(uri, read).catch(() => {
          // A read cut short by the client's going is the end it asked for; any other failure ends the stream, and the client listens again.
          if (!signal.aborted) end();
        }),
      ];
    }),
  );
}
