/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion -- test doubles of the SDK's call context and of the handler object, each holding only what the door reads */
import type { Admitted } from "@keeltown/core/application/identity";
import type { AgentClaims } from "@keeltown/core/domain/identity";
import { type AgentId, makeId } from "@keeltown/core/kernel";
import { sampleOrgId, sampleProjectId } from "@keeltown/testing";
import { ulid } from "ulid";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../../src/generated/mcp/mcp-runtime.gen.ts";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import type { Handlers } from "../../src/adapters/driving/http/handlers.ts";
import {
  feedUri,
  INBOX_URI,
  LISTEN_MS,
  MAX_LISTEN_READS,
  narrowListen,
  serveListen,
  stands,
  watchable,
  type Watches,
} from "../../src/adapters/driving/mcp/listen.ts";
import { held, UNTOLD_WAIT_SECONDS } from "../../src/adapters/driving/mcp/server.ts";

const AGENT: AgentId = makeId("agt", ulid());

/** An agent admitted on its own token, as the gate admits one: `token` and `principal` change what a case is about. */
function admitted(
  token: Partial<AgentClaims> = {},
  principal: { readonly paused?: boolean; readonly standing?: "Governs" | "None" } = {},
): Admitted {
  const claims: AgentClaims = {
    agentId: AGENT,
    projectId: sampleProjectId,
    scopes: [],
    revocationEpoch: 0,
    bound: false,
    ...token,
  };
  return {
    principal: {
      _tag: "Agent",
      agentId: AGENT,
      namespace: sampleOrgId,
      ...(claims.projectId === undefined ? {} : { projectId: claims.projectId }),
      scopes: [],
      paused: principal.paused ?? false,
      standing: { _tag: principal.standing ?? "Governs" },
    },
    token: claims,
  };
}

/** The claims an admitted agent presented. */
function claimsOf(agent: Admitted): AgentClaims {
  if (agent.token === undefined) throw new Error("admitted with no token");
  return agent.token;
}

const listening = (resourceSubscriptions: unknown) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "subscriptions/listen",
  params: {
    notifications: { toolsListChanged: true, resourceSubscriptions },
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "keel-unit-test", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});

describe("what an MCP listen may watch", () => {
  it("[mcp.watchable] an agent on its own token, unpaused and standing in its project, watches its inbox and that project's feed, and nothing else watches anything", () => {
    const feed = feedUri(sampleProjectId);
    const { projectId: _none, ...unprojected } = claimsOf(admitted());
    const exchanged = admitted();
    const { bound: _bound, ...unbound } = claimsOf(exchanged);
    expect({
      bearer: watchable(admitted()),
      proved: watchable(admitted({ bound: true })),
      noProject: watchable({ ...admitted(), token: unprojected }),
      exchanged: watchable({ ...exchanged, token: unbound }),
      paused: watchable(admitted({}, { paused: true })),
      removed: watchable(admitted({}, { standing: "None" })),
      person: watchable({ principal: { _tag: "Anonymous" } }),
    }).toEqual({
      bearer: [INBOX_URI, feed],
      proved: [INBOX_URI, feed],
      noProject: [INBOX_URI],
      exchanged: [],
      paused: [],
      removed: [],
      person: [],
    });
    expect(stands(admitted({}, { paused: true }))).toBe(false);
  });

  it("[mcp.narrow] a listen's resources are narrowed to what may be watched, once each, and the rest of its body is kept; a body that is no listen of resources passes as it came", () => {
    const may = [INBOX_URI, feedUri(sampleProjectId)];
    const other = feedUri(makeId("prj", ulid()));
    const narrowed = narrowListen(
      listening([other, INBOX_URI, "keel://other", INBOX_URI, 3, feedUri(sampleProjectId)]),
      may,
    );
    expect(narrowed).toEqual({
      body: listening([INBOX_URI, feedUri(sampleProjectId)]),
      watched: [INBOX_URI, feedUri(sampleProjectId)],
    });
    expect(narrowListen(listening([other]), may).watched).toEqual([]);
    for (const body of [
      null,
      "listen",
      { params: {} },
      listening(INBOX_URI),
      [listening([INBOX_URI])],
    ])
      expect(narrowListen(body, may)).toEqual({ body, watched: [] });
  });
});

/** The wait each of the three reads was handed, and every notice sent before them. */
function door(progressToken?: string) {
  const sent: unknown[] = [];
  const waits: unknown[] = [];
  const answer = (_caller: Caller, input: { readonly wait?: number }) => {
    waits.push(input.wait);
    return { status: 200, sent: sent.length } as never;
  };
  const handlers = {
    inbox: answer,
    Inbox_listEvents: answer,
    status: answer,
  } as unknown as Handlers;
  const context = {
    mcpReq: {
      ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
      notify: async (notification: unknown) => {
        sent.push(notification);
      },
    },
  } as unknown as ServerContext;
  const caller = {} as Caller;
  const tools = held(handlers, context);
  return { sent, waits, tools, caller };
}

describe("a held tool call at the MCP door", () => {
  it("[mcp.held] with no progress token a wait is held to 30 seconds at most; with one, a progress notice goes first and the wait is as asked; with no wait, nothing is sent", async () => {
    const untold = door();
    await untold.tools.inbox(untold.caller, { wait: 900 });
    await untold.tools.Inbox_listEvents(untold.caller, { wait: 20 });
    await untold.tools.status(untold.caller, { changeId: "chg_x", wait: 31 } as never);
    expect({ waits: untold.waits, sent: untold.sent }).toEqual({
      waits: [UNTOLD_WAIT_SECONDS, 20, UNTOLD_WAIT_SECONDS],
      sent: [],
    });

    const told = door("p-1");
    const answered = await told.tools.inbox(told.caller, { wait: 900 });
    await told.tools.inbox(told.caller, {});
    expect({ waits: told.waits, sent: told.sent, before: answered }).toEqual({
      waits: [900, undefined],
      sent: [
        {
          method: "notifications/progress",
          params: expect.objectContaining({ progressToken: "p-1", progress: 0 }),
        },
      ],
      before: { status: 200, sent: 1 },
    });
  });
});

/** A server that says a resource may be watched, as the door's does to the current revision. */
function listeningServer(): McpServer {
  const server = new McpServer({ name: "keel", version: "0" });
  server.server.registerCapabilities({ resources: { subscribe: true } });
  return server;
}

/** A listen for the agent's inbox, served as the door serves one, over `watches`. */
function serve(watches: Watches): Promise<Response> {
  const body = listening([INBOX_URI]);
  const request = new Request("https://keel.localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "subscriptions/listen",
    },
    body: JSON.stringify(body),
  });
  return serveListen(
    listeningServer,
    watches,
    request,
    { token: "t", clientId: AGENT, scopes: [] },
    admitted(),
    body,
  );
}

describe("how a listen ends", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[mcp.listen-budget] a listen whose every read answers at once ends cleanly after its count of reads, with the stream's last result", async () => {
    let reads = 0;
    const response = await serve({
      inbox: async (_agent, cursor) => {
        reads += 1;
        return { cursor, arrived: false };
      },
      feed: async (_project, cursor) => ({ cursor, arrived: false }),
      admit: async () => admitted(),
    });
    const text = await response.text();
    expect(reads).toBe(MAX_LISTEN_READS);
    expect(text).toContain('"resultType":"complete"');
  });

  it("[mcp.listen-gone] when the client lets the stream go, the held read is let go with it", async () => {
    let letGo = false;
    const response = await serve({
      inbox: (_agent, _cursor, _seconds, _run, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            letGo = true;
            reject(new Error("let go"));
          });
        }),
      feed: async (_project, cursor) => ({ cursor, arrived: false }),
      admit: async () => admitted(),
    });
    if (response.body === null) throw new Error("the listen has no stream");
    const reader = response.body.getReader();
    await reader.read();
    expect(letGo).toBe(false);
    await reader.cancel();
    await vi.waitFor(() => {
      expect(letGo).toBe(true);
    });
  });

  it("[mcp.listen-hour] a listen whose reads never answer ends after an hour, with the stream's last result, and its held read is let go", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let letGo = false;
    const response = await serve({
      inbox: (_agent, _cursor, _seconds, _run, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            letGo = true;
            reject(new Error("let go"));
          });
        }),
      feed: async (_project, cursor) => ({ cursor, arrived: false }),
      admit: async () => admitted(),
    });
    const text = response.text();
    await vi.advanceTimersByTimeAsync(LISTEN_MS - 1);
    expect(letGo).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await text).toContain('"resultType":"complete"');
    expect(letGo).toBe(true);
  });
});
