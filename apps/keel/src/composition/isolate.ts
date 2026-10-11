import { admit } from "@keeltown/core/application/identity";
import type { AgentId, ChangeId, ProjectId } from "@keeltown/core/kernel";
import {
  type AgentDirectory,
  type Changes,
  type CodeHost,
  type Enrolments,
  type Sessions,
  type Standings,
  type EventFeed,
  Inbox,
  type Notifier,
  PROJECTOR,
  type Projects,
  TokenIssuer,
} from "@keeltown/core/ports";
import { waitUntil } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CodeHostArtifacts } from "../adapters/driven/artifacts/code-host.ts";
import { AUTH_BASE_PATH, makeAuth, type OtpSender } from "../adapters/driven/better-auth/auth.ts";
import { AgentDirectoryWithBootstrap } from "../adapters/driven/bootstrap/directory.ts";
import { AgentDirectoryD1 } from "../adapters/driven/d1/agent-directory.ts";
import { ChangesRpc } from "../adapters/driven/do-rpc/changes.ts";
import { EnrolmentsRpc } from "../adapters/driven/do-rpc/enrolments.ts";
import { SessionsRpc } from "../adapters/driven/do-rpc/sessions.ts";
import { StandingsRpc } from "../adapters/driven/do-rpc/standings.ts";
import { EventFeedRpc } from "../adapters/driven/do-rpc/event-feed.ts";
import { ProjectViewsRpc } from "../adapters/driven/do-rpc/project-views.ts";
import { InboxRpc } from "../adapters/driven/do-rpc/inbox.ts";
import { NotifierRpc } from "../adapters/driven/do-rpc/notifier.ts";
import { ProjectsRpc } from "../adapters/driven/do-rpc/projects.ts";
import { TokenIssuerJose } from "../adapters/driven/jose/token-issuer.ts";
import { ClockLive, SystemLive } from "../adapters/driven/system.ts";
import { makeApp } from "../adapters/driving/http/app.ts";
import type { TokenVerifier, Verification } from "../adapters/driving/http/caller.ts";
import type { InboxStreams } from "../adapters/driving/http/inbox-streams.ts";
import { makeHandlers } from "../adapters/driving/http/handlers.ts";
import { makeRunner, type IsolateServices } from "../adapters/driving/http/run.ts";
import { makeMcpEndpoint } from "../adapters/driving/mcp/server.ts";

/**
 * The isolate's composition root: the one place `env` becomes objects. One
 * ManagedRuntime per Env, built only from binding-backed adapters; nothing
 * request-scoped is cached in it.
 */
export function isolateLayer(
  env: Env,
  overrides: IsolateOverrides = {},
): Layer.Layer<IsolateServices> {
  const agentSession = (agentId: AgentId) =>
    env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`));
  const change = (changeId: ChangeId) =>
    env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`));
  const project = (projectId: ProjectId) =>
    env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`));
  const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR));
  const directory = AgentDirectoryWithBootstrap(env.KEEL_BOOTSTRAP_SECRET).pipe(
    Layer.provide(AgentDirectoryD1(env.DB)),
  );
  return Layer.mergeAll(
    overrides.changes ?? ChangesRpc({ change, agentSession }),
    overrides.inbox ?? InboxRpc(agentSession),
    overrides.eventFeed ?? EventFeedRpc(projector),
    ProjectViewsRpc(projector),
    overrides.notifier ?? NotifierRpc(agentSession),
    overrides.projects ?? ProjectsRpc(project),
    (overrides.enrolments ?? EnrolmentsRpc(agentSession)).pipe(Layer.provide(directory)),
    overrides.sessions ?? SessionsRpc(agentSession),
    overrides.standings ?? StandingsRpc(agentSession),
    directory,
    // The repo read API reads trunks, which live in the core namespace alone.
    overrides.codeHost ?? CodeHostArtifacts({ "keel-core": env.ARTIFACTS }),
    TokenIssuerJose({ privateJwk: env.KEEL_SIGNING_KEY, issuer: env.KEEL_HOST }).pipe(
      Layer.provide(ClockLive),
    ),
    SystemLive,
  );
}

/** Pool tests swap the work loop's DO-backed ports for in-memory ones; production passes none. */
export interface IsolateOverrides {
  readonly changes?: Layer.Layer<Changes>;
  readonly inbox?: Layer.Layer<Inbox>;
  readonly eventFeed?: Layer.Layer<EventFeed>;
  /** The piggyback; pass it with `inbox` when both read one memory. */
  readonly notifier?: Layer.Layer<Notifier>;
  readonly projects?: Layer.Layer<Projects>;
  /** May need the AgentDirectory, as the in-memory enrolments project into it. */
  readonly enrolments?: Layer.Layer<Enrolments, never, AgentDirectory>;
  readonly codeHost?: Layer.Layer<CodeHost>;
  readonly sessions?: Layer.Layer<Sessions>;
  readonly standings?: Layer.Layer<Standings>;
}

export type IsolateRuntime = ManagedRuntime.ManagedRuntime<IsolateServices, never>;

/**
 * A bearer token is good if it verifies and its agent may still act at the
 * token's epoch. `admit` reads only the AgentDirectory: the gate never calls
 * an AgentSession DO.
 */
function makeVerifier(runtime: IsolateRuntime): TokenVerifier {
  return (token) =>
    runtime.runPromise(
      TokenIssuer.use((issuer) => issuer.verify(token)).pipe(
        Effect.flatMap((principal) =>
          admit(principal).pipe(
            Effect.as<Verification>({ principal }),
            Effect.catchTag("AgentNotAdmitted", () =>
              Effect.succeed<Verification>({ refused: "revoked" }),
            ),
          ),
        ),
        Effect.catch(() => Effect.succeed<Verification>({ refused: "invalid" })),
      ),
    );
}

interface Isolate {
  readonly runtime: IsolateRuntime;
  readonly app: ReturnType<typeof makeApp>;
}

const isolates = new WeakMap<Env, Isolate>();

/**
 * The agent's live inbox: the SSE loop reads through the Inbox port, and a
 * socket upgrade goes to the caller's own AgentSession DO, named here from the
 * principal and nothing else.
 */
function inboxStreams(env: Env, runtime: IsolateRuntime): InboxStreams {
  return {
    read: (agentId, cursor, waitSeconds, signal) =>
      runtime.runPromise(
        Inbox.use((inbox) => inbox.read(agentId, cursor, waitSeconds)),
        { signal },
      ),
    socket: (agentId, request) =>
      env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)).fetch(request),
  };
}

/** What the identity adapter needs beyond `env`: pool tests read the codes it sends. */
export interface AuthOverrides {
  /** Email codes; production has no sender until Keel can send mail, so none are offered. */
  readonly sendOtp?: OtpSender;
}

/** Better Auth over the Worker's D1, with GitHub only once both of its secrets are set. */
function identity(env: Env, overrides: AuthOverrides) {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = env as Env & {
    readonly GITHUB_CLIENT_ID?: string;
    readonly GITHUB_CLIENT_SECRET?: string;
  };
  return makeAuth({
    db: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    host: env.KEEL_HOST,
    background: waitUntil,
    ...(overrides.sendOtp === undefined ? {} : { sendOtp: overrides.sendOtp }),
    ...(clientId && clientSecret ? { github: { clientId, clientSecret } } : {}),
  });
}

/** The app over a given layer. `isolateFor` caches the production one per Env; pool tests build their own. */
export function makeIsolate(
  env: Env,
  layer: Layer.Layer<IsolateServices>,
  authOverrides: AuthOverrides = {},
): Isolate {
  const runtime = ManagedRuntime.make(layer);
  const handlers = makeHandlers(makeRunner(runtime));
  const verify = makeVerifier(runtime);
  const auth = identity(env, authOverrides);
  const app = makeApp({
    handlers,
    verify,
    mcp: makeMcpEndpoint(handlers, verify, [env.KEEL_HOST]),
    auth: {
      basePath: AUTH_BASE_PATH,
      handler: (request) => auth.handler(request),
      admit: async (key) => (await env.AUTH_LIMIT.limit({ key })).success,
    },
    streams: inboxStreams(env, runtime),
    rethrowContractDrift: env.KEEL_ENV === "test",
  });
  return { runtime, app };
}

export function isolateFor(env: Env): Isolate {
  let isolate = isolates.get(env);
  if (isolate === undefined) {
    isolate = makeIsolate(env, isolateLayer(env));
    isolates.set(env, isolate);
  }
  return isolate;
}
