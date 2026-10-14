import { type Credential, principalOf } from "@keeltown/core/application/identity";
import { type AgentId, type ChangeId, type ProjectId, UserId } from "@keeltown/core/kernel";
import {
  AgentDirectory,
  type Changes,
  type CodeHost,
  type Enrolments,
  type Sessions,
  Sponsorships,
  type Standings,
  EventFeed,
  Inbox,
  type Notifier,
  PROJECTOR,
  type Projects,
  RepoServer,
  type Lanes,
  type Trunks,
  type WorkspacePool,
} from "@keeltown/core/ports";
import { waitUntil } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { CodeHostArtifacts } from "../adapters/driven/artifacts/code-host.ts";
import { CodeHostReadCache, makeMemoryTier } from "../adapters/driven/artifacts/read-cache.ts";
import { RepoServerArtifacts } from "../adapters/driven/artifacts/repo-server.ts";
import {
  resourceChallenge,
  verifyAgentToken,
} from "../adapters/driven/better-auth/access-tokens.ts";
import {
  type AgentAccess,
  agentResources,
  TOKEN_PATH,
} from "../adapters/driven/better-auth/agents.ts";
import {
  authorizationServerDocument,
  protectedResourceDocument,
} from "../adapters/driven/better-auth/discovery.ts";
import {
  AUTH_BASE_PATH,
  type AuthConfig,
  makeAuth,
  type OtpSender,
  signInMethods,
} from "../adapters/driven/better-auth/auth.ts";
import { reaching } from "../adapters/driven/better-auth/database.ts";
import { AgentDirectoryD1 } from "../adapters/driven/d1/agent-directory.ts";
import { MembershipsD1 } from "../adapters/driven/d1/memberships.ts";
import { NamespaceAgentsD1 } from "../adapters/driven/d1/namespace-agents.ts";
import { ProjectAgentsD1 } from "../adapters/driven/d1/project-agents.ts";
import { NamespacesD1 } from "../adapters/driven/d1/namespaces.ts";
import { ProjectNamespacesD1 } from "../adapters/driven/d1/project-namespaces.ts";
import { isD1Unavailable } from "../adapters/driven/d1/unavailable.ts";
import { UsersD1 } from "../adapters/driven/d1/users.ts";
import { ChangesRpc } from "../adapters/driven/do-rpc/changes.ts";
import { ConflictMovesRpc } from "../adapters/driven/do-rpc/conflict-moves.ts";
import { DecisionsRpc } from "../adapters/driven/do-rpc/decisions.ts";
import { VerdictsRpc } from "../adapters/driven/do-rpc/verdicts.ts";
import { EscalationsRpc } from "../adapters/driven/do-rpc/escalations.ts";
import { EnrolmentsRpc } from "../adapters/driven/do-rpc/enrolments.ts";
import { AgentSignUpsRpc } from "../adapters/driven/do-rpc/sign-ups.ts";
import { SessionsRpc } from "../adapters/driven/do-rpc/sessions.ts";
import { InvitationsRpc } from "../adapters/driven/do-rpc/invitations.ts";
import { SponsorshipsRpc } from "../adapters/driven/do-rpc/sponsorships.ts";
import { StandingsRpc } from "../adapters/driven/do-rpc/standings.ts";
import { EventFeedRpc } from "../adapters/driven/do-rpc/event-feed.ts";
import { ProjectViewsRpc } from "../adapters/driven/do-rpc/project-views.ts";
import { InboxRpc } from "../adapters/driven/do-rpc/inbox.ts";
import { NotifierRpc } from "../adapters/driven/do-rpc/notifier.ts";
import { NamespaceUsageRpc } from "../adapters/driven/do-rpc/namespace-usage.ts";
import { ProjectsRpc } from "../adapters/driven/do-rpc/projects.ts";
import { DeployTargetsRpc } from "../adapters/driven/do-rpc/deploy-targets.ts";
import { DeployTargetCheckCloudflare } from "../adapters/driven/deploy/cloudflare-api.ts";
import { CloudflareOAuthLive } from "../adapters/driven/deploy/cloudflare-oauth.ts";
import { LanesRpc } from "../adapters/driven/do-rpc/lanes.ts";
import { TrunksRpc } from "../adapters/driven/do-rpc/trunks.ts";
import { WorkspacePoolRpc } from "../adapters/driven/do-rpc/workspace-pool.ts";
import { signersFile } from "../adapters/driven/gitcore/commit-signing.ts";
import { TokenIssuerJose } from "../adapters/driven/jose/token-issuer.ts";
import { PlanStoreR2 } from "../adapters/driven/r2/plan-store.ts";
import { ProbeStoreR2 } from "../adapters/driven/r2/probe-store.ts";
import { ClockLive, SystemLive } from "../adapters/driven/system.ts";
import { credentialStoreLayer } from "./credentials.ts";
import { makeApp } from "../adapters/driving/http/app.ts";
import { cloneAccess } from "../adapters/driving/http/clone-access.ts";
import { gate, type GateDeps } from "../adapters/driving/http/gate.ts";
import type { BoundGate } from "../adapters/driving/http/route-deps.ts";
import type { TokenLimits } from "../adapters/driving/http/token-limits.ts";
import { cachedTokenBlocks } from "../adapters/driven/edge-cache/token-blocks.ts";
import type { InboxStreams } from "../adapters/driving/http/inbox-streams.ts";
import { RUN_HEADER } from "../rpc/index.ts";
import { START_PATH } from "../adapters/driving/http/front-door.ts";
import { makeHandlers, REGISTER_PATH } from "../adapters/driving/http/handlers.ts";
import { makeRunner, type IsolateServices } from "../adapters/driving/http/run.ts";
import type { Watches } from "../adapters/driving/mcp/listen.ts";
import { makeMcpEndpoint } from "../adapters/driving/mcp/server.ts";
import { artifactsLocationHint } from "./do.ts";
import { doorwayOf } from "./doorway.ts";

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
  const directory = AgentDirectoryD1(env.DB);
  // The repo read API reads trunks, which live in the core namespace alone. What it reads by id
  // is cached, behind each handler's authorisation: in this isolate's memory, then the colo's cache.
  const codeHost = CodeHostReadCache({
    host: env.KEEL_HOST,
    memory: makeMemoryTier(),
    shared: caches.default,
    background: waitUntil,
  }).pipe(Layer.provide(overrides.codeHost ?? CodeHostArtifacts({ "keel-core": env.ARTIFACTS })));
  return Layer.mergeAll(
    overrides.changes ?? ChangesRpc({ change, agentSession }),
    overrides.inbox ?? InboxRpc(agentSession),
    overrides.eventFeed ?? EventFeedRpc(projector),
    ProjectViewsRpc(projector),
    DecisionsRpc(projector),
    VerdictsRpc(projector),
    EscalationsRpc(projector, (address) => env.NAMESPACE.get(env.NAMESPACE.idFromName(address))),
    ConflictMovesRpc((address) => env.SUBJECT.get(env.SUBJECT.idFromName(address))),
    ProbeStoreR2(env.BUNDLES),
    PlanStoreR2(env.ARCHIVE),
    overrides.notifier ?? NotifierRpc(agentSession),
    overrides.projects ?? ProjectsRpc(project),
    // A project's deploy targets, held by its own object; a target's account is asked before one is set.
    DeployTargetsRpc(project),
    DeployTargetCheckCloudflare(),
    // An owner connects a target through Keel's OAuth client, which comes back to this host.
    CloudflareOAuthLive({
      clientId: env.CF_OAUTH_CLIENT_ID,
      clientSecret: () => env.CF_OAUTH_CLIENT_SECRET.get(),
      redirectUri: `https://${env.KEEL_HOST}/v1/cloudflare/callback`,
    }),
    // A project's view names what it was forked from, which its trunk keeps.
    overrides.trunks ?? TrunksRpc(env.TRUNK, artifactsLocationHint(env)),
    // A project's lanes, as their own objects count them.
    overrides.lanes ?? LanesRpc(env.LANE, artifactsLocationHint(env)),
    // A workspace's holder, which a token refresh asks its project's pool for.
    overrides.workspacePool ?? WorkspacePoolRpc(env.WORKSPACE_POOL, artifactsLocationHint(env)),
    (overrides.enrolments ?? EnrolmentsRpc(agentSession)).pipe(Layer.provide(directory)),
    AgentSignUpsRpc(agentSession),
    overrides.sessions ?? SessionsRpc(agentSession),
    overrides.standings ?? StandingsRpc(agentSession),
    overrides.sponsorships ?? SponsorshipsRpc(agentSession),
    InvitationsRpc((address) => env.NAMESPACE.get(env.NAMESPACE.idFromName(address)), project),
    credentialStoreLayer(env),
    NamespaceAgentsD1(env.DB),
    ProjectAgentsD1(env.DB),
    directory,
    UsersD1(env.DB),
    MembershipsD1(env.DB),
    NamespacesD1(env.DB),
    ProjectNamespacesD1(env.DB),
    // A namespace's own limits, read where a project is made.
    NamespaceUsageRpc(env.NAMESPACE_USAGE),
    codeHost,
    // The clone URL serves a trunk through its host's own git remote, with a read token per request.
    overrides.repoServer ?? RepoServerArtifacts().pipe(Layer.provide(codeHost)),
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
  /** Pass the trunks the projects' own objects write, when those are in memory. */
  readonly trunks?: Layer.Layer<Trunks>;
  /** Pass the lanes a test counts in memory. */
  readonly lanes?: Layer.Layer<Lanes>;
  /** Pass the pool in-memory `changes` grant from, so a workspace's holder is one of theirs. */
  readonly workspacePool?: Layer.Layer<WorkspacePool>;
  /** May need the AgentDirectory, as the in-memory enrolments project into it. */
  readonly enrolments?: Layer.Layer<Enrolments, never, AgentDirectory>;
  readonly codeHost?: Layer.Layer<CodeHost>;
  /** Pass the server of the code host's own repos, when that host is in memory. */
  readonly repoServer?: Layer.Layer<RepoServer>;
  readonly sessions?: Layer.Layer<Sessions>;
  readonly standings?: Layer.Layer<Standings>;
  readonly sponsorships?: Layer.Layer<Sponsorships>;
}

export type IsolateRuntime = ManagedRuntime.ManagedRuntime<IsolateServices, never>;

const decodeUserId = Schema.decodeUnknownOption(UserId);

/**
 * The gate's dependencies: the user a Better Auth session names (Better Auth
 * made for the call, never kept), and the principal the core gate builds for a
 * credential, with its refusals as the doorway answers them.
 */
function gateDeps(
  runtime: IsolateRuntime,
  host: string,
  auth: () => ReturnType<typeof makeAuth>,
): GateDeps {
  const origin = `https://${host}`;
  return {
    origin,
    sessionUser: async (headers) => {
      const session = await auth().api.getSession({ headers });
      if (session === null) return null;
      const userId = Option.getOrNull(decodeUserId(session.user.id));
      if (userId === null) return null;
      const by: unknown = session.session["signedInBy"];
      const passkeyAt: unknown = session.session["passkeyAt"];
      return {
        userId,
        signedIn: {
          by: typeof by === "string" ? by : null,
          at: new Date(session.session.createdAt).getTime(),
          ...(typeof passkeyAt === "number" ? { passkeyAt } : {}),
        },
      };
    },
    agentToken: (presented, door) =>
      verifyAgentToken(auth(), origin, agentResources(origin)[door], presented),
    challenge: (door, refusal) => resourceChallenge(agentResources(origin)[door], refusal),
    admit: (credential: Credential) =>
      runtime.runPromise(
        principalOf(credential).pipe(
          Effect.map((admitted) => ({ admitted })),
          Effect.catchTag("AgentNotAdmitted", () =>
            Effect.succeed({ refused: "revoked" } as const),
          ),
          Effect.catchTag("AgentUnplaced", (error) =>
            Effect.succeed({ refused: "unplaced", agentId: error.agentId } as const),
          ),
          Effect.catch(() => Effect.succeed({ refused: "invalid" } as const)),
        ),
      ),
  };
}

interface Isolate {
  readonly runtime: IsolateRuntime;
  readonly app: ReturnType<typeof makeApp>;
}

const isolates = new WeakMap<Env, Isolate>();

/**
 * The agent's live inbox: the SSE loop reads through the Inbox port, and a
 * socket upgrade goes to the caller's own AgentSession DO, named here from the
 * principal and nothing else. The object is told the run in a header set
 * here from the admitted token: whatever the request carried under that name
 * is replaced, so a client never picks the run it reads as.
 */
function inboxStreams(env: Env, runtime: IsolateRuntime): InboxStreams {
  return {
    read: (agentId, cursor, waitSeconds, signal, run) =>
      runtime.runPromise(
        Inbox.use((inbox) => inbox.read(agentId, cursor, waitSeconds, run)),
        { signal },
      ),
    socket: (agentId, request, run) => {
      const headers = new Headers(request.headers);
      if (run === undefined) headers.delete(RUN_HEADER);
      else headers.set(RUN_HEADER, run);
      return env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)).fetch(
        new Request(request, { headers }),
      );
    },
  };
}

/**
 * The held reads an MCP listen watches with: the agent's inbox through the
 * Inbox port as a peek (a listen shows no notice, so it counts none as read),
 * and the project's feed through the EventFeed port.
 */
function listenReads(runtime: IsolateRuntime): Omit<Watches, "admit"> {
  return {
    inbox: async (agentId, cursor, seconds, run, signal) => {
      const page = await runtime.runPromise(
        Inbox.use((inbox) => inbox.read(agentId, cursor, seconds, run, true)),
        { signal },
      );
      return { cursor: page.cursor, arrived: page.notices.length > 0 };
    },
    feed: async (project, cursor, seconds, signal) => {
      const page = await runtime.runPromise(
        EventFeed.use((feed) => feed.read({ cursor, waitSeconds: seconds, project })),
        { signal },
      );
      return { cursor: page.cursor, arrived: page.events.length > 0 };
    },
  };
}

/** What the identity adapter needs beyond `env`: pool tests read the codes it sends. */
export interface AuthOverrides {
  /** Email codes; production has no sender until Keel can send mail, so none are offered. */
  readonly sendOtp?: OtpSender;
  /** Told of each Better Auth instance as it is made, so a test can count them. */
  readonly made?: () => void;
}

/**
 * Better Auth's config over the Worker's D1, with GitHub only once both of its
 * secrets are set. The database is handed over as `reaching` wraps it, so a
 * query D1 was away for leaves Better Auth as an error the doorway can read.
 */
function identity(
  env: Env,
  overrides: AuthOverrides,
  agents: AgentAccess,
  endSponsorships: AuthConfig["endSponsorships"],
): AuthConfig {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = env as Env & {
    readonly GITHUB_CLIENT_ID?: string;
    readonly GITHUB_CLIENT_SECRET?: string;
  };
  return {
    db: reaching(env.DB),
    secret: env.BETTER_AUTH_SECRET,
    host: env.KEEL_HOST,
    agents,
    endSponsorships,
    background: waitUntil,
    ...(overrides.sendOtp === undefined ? {} : { sendOtp: overrides.sendOtp }),
    ...(clientId && clientSecret ? { github: { clientId, clientSecret } } : {}),
  };
}

/**
 * Ends every sponsor link a person holds, as that person: what deleting their
 * account does once nothing refuses it. An agent that is revoked, or whose
 * AgentSession names another sponsor or none, has no link of theirs to end.
 * Each end takes a key of its own, so a later attempt never answers an
 * earlier one in its place.
 */
const endSponsorships = (userId: UserId) =>
  AgentDirectory.use((directory) => directory.sponsoredBy(userId)).pipe(
    Effect.flatMap((sponsored) =>
      Sponsorships.use((links) =>
        Effect.forEach(
          sponsored,
          (agent) =>
            links
              .end(
                { _tag: "User", userId },
                { agentId: agent.id, idempotencyKey: `account-delete:${crypto.randomUUID()}` },
              )
              .pipe(
                Effect.catchTag("AgentNotKnown", () => Effect.void),
                Effect.catchTag("AgentStateRefused", () => Effect.void),
              ),
          { discard: true },
        ),
      ),
    ),
  );

/** The app over a given layer. `isolateFor` caches the production one per Env; pool tests build their own. */
export function makeIsolate(
  env: Env,
  layer: Layer.Layer<IsolateServices>,
  authOverrides: AuthOverrides = {},
): Isolate {
  const runtime = ManagedRuntime.make(layer);
  const authConfig = identity(
    env,
    authOverrides,
    {
      find: (agentId) =>
        runtime.runPromise(
          AgentDirectory.use((directory) => directory.findAgent(agentId)).pipe(
            Effect.map(Option.getOrUndefined),
          ),
        ),
    },
    (userId) => runtime.runPromise(endSponsorships(Schema.decodeSync(UserId)(userId))),
  );
  const origin = `https://${env.KEEL_HOST}`;
  const handlers = makeHandlers(
    makeRunner(runtime, isD1Unavailable),
    signInMethods(authConfig),
    doorwayOf(env.KEEL_HOST),
  );
  /**
   * Better Auth starts its initialisation (D1 included) when it is made and
   * shares that promise, and its adapter's schema check, with every later
   * caller. Made once per isolate, it was made inside whichever request came
   * first; when that request finished first, Workers dropped the work it left
   * pending, and every later /v1/auth request on the isolate waited for ever.
   * Each request makes its own, so what it awaits is its own.
   */
  const auth = () => {
    authOverrides.made?.();
    return makeAuth(authConfig);
  };
  const deps = gateDeps(runtime, env.KEEL_HOST, auth);
  // One limiter, two counts under their own keys: tokens issued to an agent, and failed exchanges from an address.
  const tokenLimits: TokenLimits = {
    issued: async (key) => (await env.TOKEN_LIMIT.limit({ key })).success,
    failed: async (key) => (await env.TOKEN_LIMIT.limit({ key })).success,
    blocks: cachedTokenBlocks(caches.default),
  };
  const boundGate: BoundGate = (request, requestId) => gate(request, requestId, deps);
  const app = makeApp({
    handlers,
    gate: boundGate,
    mcp: makeMcpEndpoint(handlers, deps, [env.KEEL_HOST], listenReads(runtime)),
    auth: {
      basePath: AUTH_BASE_PATH,
      handler: (request) => auth().handler(request),
      admit: async (key) => (await env.AUTH_LIMIT.limit({ key })).success,
      tokenPath: TOKEN_PATH,
      tokenLimits,
    },
    tokens: tokenLimits,
    wellKnown: {
      origin,
      issuerPath: AUTH_BASE_PATH,
      authorizationServer: (request) =>
        authorizationServerDocument(
          auth(),
          { signUpUrl: `${origin}${REGISTER_PATH}`, startUrl: `${origin}${START_PATH}` },
          request,
        ),
      protectedResource: (resource) =>
        protectedResourceDocument(auth(), { origin, startUrl: `${origin}${START_PATH}` }, resource),
    },
    streams: inboxStreams(env, runtime),
    git: {
      access: cloneAccess(boundGate, (effect) => runtime.runPromise(effect)),
      uploadPack: (repo, request) =>
        runtime.runPromise(
          RepoServer.use((server) => server.uploadPack(repo, request)).pipe(
            Effect.catchTag("RepoNotFound", () => Effect.succeed(null)),
          ),
        ),
    },
    signers: () => signersFile({ host: env.KEEL_HOST, signers: env.KEEL_COMMIT_SIGNERS }),
    rethrowContractDrift: env.KEEL_ENV === "test",
    databaseAway: isD1Unavailable,
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
