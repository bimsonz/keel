import {
  abandonChange,
  createProject,
  adoptChange,
  rebaseChange,
  declareChange,
  getSettings,
  nearbyOf,
  putSettings,
  readChange,
  readChangeList,
  readConflict,
  readConflictList,
  readEscalationList,
  readProbeSource,
  resolveMove,
  ruleOnEscalation,
  type ProjectRef,
  readEvents,
  readInbox,
  readSnapshot,
  relyOn,
  reviseChange,
  submissionOf,
  submitChange,
  type Withdrawer,
} from "@keeltown/core/application/coordination";
import {
  enrolAgent,
  exchangeToken,
  signUpAgent,
  openAgentSession,
  reinstateAgent,
  revokeAgent,
  suspendAgent,
  whoami,
} from "@keeltown/core/application/identity";
import {
  listRepoCommits,
  projectSource,
  readRepoBlob,
  readRepoCommit,
  readRepoTree,
} from "@keeltown/core/application/integration";
import {
  type Actor,
  type Agent,
  type AgentResource,
  type Audience,
  authorize,
  GrantableScope,
  type PresentedKey,
  type ProjectResource,
  roleOf,
} from "@keeltown/core/domain/identity";
import {
  ConflictId,
  type NamespaceId,
  namespaceKind,
  ProbeId,
  ProjectId as ProjectIdSchema,
  type ProjectId,
} from "@keeltown/core/kernel";
import {
  AgentDirectory,
  type EscalationReader,
  Namespaces,
  ProjectNamespaces,
  type Projects,
  Sponsorships,
  Trunks,
} from "@keeltown/core/ports";
import { Effect, Option, Result, Schema } from "effect";
import type { Operations } from "../../../generated/http/app.gen.ts";
import {
  agentsOnly,
  authorizeHandlers,
  decideEach,
  decideFork,
  projectResource,
  refusalResult,
  RESOLVERS,
} from "./authorize-handlers.ts";
import type { AgentClaims, AgentToken, Caller } from "./caller.ts";
import { specRoute } from "./spec-routes.ts";
import {
  latticesOk,
  registeredOk,
  registrationRefused,
  tokenError,
  tokenOk,
  whoamiError,
  whoamiOk,
} from "./mappers.ts";
import { listProjects, viewerRole } from "./project-list.ts";
import {
  createProjectError,
  createProjectOk,
  enrolAgentError,
  enrolAgentOk,
  enrolInput,
  putSettingsError,
  putSettingsInput,
  settingsError,
  settingsOk,
  settingsProject,
  sourceNotFound,
  sourceRefused,
  type StandingOperation,
  standingError,
  standingInput,
  standingOk,
} from "./operator.ts";
import {
  escalationListInput,
  escalationsOk,
  rulingError,
  rulingInput,
  rulingOk,
} from "./escalations.ts";
import { eventsInput, eventsOk } from "./events.ts";
import {
  changeListInput,
  changesOk,
  conflictListInput,
  conflictNotFound,
  conflictOk,
  conflictsOk,
  probeNotFound,
  probeSourceOk,
  snapshotOk,
} from "./views.ts";
import { piggyback } from "./piggyback.ts";
import {
  blobOk,
  commitOk,
  commitParam,
  commitsFrom,
  commitsOk,
  repoError,
  treeOk,
} from "./repo.ts";
import { sessionError, sessionInput, sessionOk } from "./sessions.ts";
import {
  approveError,
  askError,
  askOk,
  cardNotFound,
  cardOk,
  decodeLinkAgent,
  endError,
  freshSignInRequired,
  linkOk,
  noSuchRequest,
  sponsoredOk,
} from "./sponsorship.ts";
import { notImplemented, problem } from "./problems.ts";
import type { Runner } from "./run.ts";
import {
  abandonError,
  abandonInput,
  abandonOk,
  adoptError,
  adoptInput,
  adoptOk,
  rebaseError,
  rebaseInput,
  rebaseOk,
  relyError,
  relyInput,
  relyOk,
  reviseError,
  reviseInput,
  reviseOk,
  nearbyError,
  nearbyOk,
  changeIdInput,
  changeOk,
  changeReadError,
  declareError,
  declareInput,
  declareOk,
  inboxOk,
  type Input,
  invalid,
  resolveError,
  resolveInput,
  resolveOk,
  statusError,
  statusOk,
  submitError,
  submitInput,
  submitOk,
} from "./work-loop.ts";

/** Every operation not yet implemented answers the declared 503 `service.not_implemented`. */
const notYet = (caller: Caller) => notImplemented(caller.requestId);

/** The claims of the agent calling: the policy grants an agent's own operations to agents only, so they are there. */
function claimsOf(caller: Caller): Effect.Effect<AgentClaims> {
  return caller.principal._tag === "Agent" && caller.token !== undefined
    ? Effect.succeed(caller.token)
    : Effect.die(new Error("an agent's operation ran without an agent's token"));
}

/**
 * The token of the agent calling, for work: the policy decides work on the
 * project the token names, so a token that names none was refused before here.
 */
function tokenOf(caller: Caller): Effect.Effect<AgentToken> {
  return claimsOf(caller).pipe(
    Effect.flatMap((claims) => {
      const { projectId } = claims;
      return projectId === undefined
        ? Effect.die(new Error("an agent's work ran on a token that names no project"))
        : Effect.succeed({ ...claims, projectId });
    }),
  );
}

/** Who withdraws a change: its agent (with its lease) or a maintainer of its project's org, as the policy granted. */
function withdrawerOf(caller: Caller): Effect.Effect<Withdrawer> {
  const { principal } = caller;
  if (principal._tag === "Agent")
    return Effect.map(tokenOf(caller), (token) => ({ _tag: "Agent", token }));
  if (principal._tag === "User")
    return Effect.succeed({
      _tag: "Maintainer",
      userId: principal.userId,
      projectId: projectOf(caller).projectId,
    });
  return Effect.die(new Error("abandon ran for neither an agent nor a user"));
}

/** The user governing: the policy grants governance to users only. */
function actorOf(caller: Caller): Effect.Effect<Actor & { readonly _tag: "User" }> {
  return caller.principal._tag === "User"
    ? Effect.succeed({ _tag: "User", userId: caller.principal.userId })
    : Effect.die(new Error("a governing operation ran without a user"));
}

/** The project the call was decided on, as `authorizeHandlers` resolved it. */
function projectOf(caller: Caller): ProjectResource {
  if (caller.resource?._tag !== "Project")
    throw new Error("a project's operation ran without its project resolved");
  return caller.resource;
}

/** The agent's account the call was decided on, as `authorizeHandlers` resolved it. */
function accountOf(caller: Caller): AgentResource {
  if (caller.resource?._tag !== "Agent")
    throw new Error("an operation on an agent's account ran without its account resolved");
  return caller.resource;
}

/** Who ends a sponsor's link: the agent itself, or the person the policy granted. */
function linkActorOf(caller: Caller): Actor {
  const { principal } = caller;
  if (principal._tag === "Agent") return { _tag: "Agent", agentId: principal.agentId };
  if (principal._tag === "User") return { _tag: "User", userId: principal.userId };
  throw new Error("a link's end ran for neither an agent nor a user");
}

/** Who creates a project: a person, or an agent in a namespace of its own, as the policy granted. */
function creatorOf(caller: Caller): Actor {
  const { principal } = caller;
  if (principal._tag === "Agent") return { _tag: "Agent", agentId: principal.agentId };
  if (principal._tag === "User") return { _tag: "User", userId: principal.userId };
  throw new Error("a project's creation ran for neither an agent nor a user");
}

/** The project a read was granted, and who it reads as. */
const scopeOf = (caller: Caller): { readonly project: ProjectId; readonly audience: Audience } => ({
  project: projectOf(caller).projectId,
  audience: caller.audience ?? "public",
});

/** The reader's role in a namespace: its owner's in their own, a member's in an org. */
const roleIn = (principal: Caller["principal"], namespace: NamespaceId) =>
  principal._tag === "User" ? roleOf(principal, namespace) : undefined;

const decodeScopes = Schema.decodeUnknownOption(Schema.Array(GrantableScope));

type ProjectViewBody = Extract<
  Awaited<ReturnType<Operations<Caller>["Namespaces_getProject"]>>,
  { readonly status: 200 }
>["body"];

const decodeCursor = (cursor: string) => Schema.decodeUnknownOption(ProjectIdSchema)(cursor);

/**
 * A project as the caller may read it, decided by the policy (the project's
 * read rule), with its namespace's handle and kind and the reader's role
 * there; undefined when the caller may not see it, or its namespace is gone.
 */
const readableView = (caller: Caller, projectId: ProjectId, name: string) =>
  Effect.gen(function* () {
    const resource = yield* projectResource(projectId);
    if (resource._tag !== "Project" || Result.isFailure(decideEach(caller.principal, resource)))
      return undefined;
    const namespace = yield* Namespaces.use((namespaces) => namespaces.byId(resource.namespace));
    if (Option.isNone(namespace)) return undefined;
    const role = roleIn(caller.principal, resource.namespace);
    const origin = yield* Trunks.use((trunks) => trunks.origin(projectId));
    const forkedFrom =
      Option.isSome(origin) && origin.value.kind === "forked"
        ? yield* sourceOf(caller, origin.value.project)
        : undefined;
    return {
      id: projectId,
      namespace: { handle: namespace.value.handle, kind: namespace.value.kind },
      name,
      visibility: resource.visibility,
      ...(role === undefined ? {} : { viewer: { role } }),
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
    } satisfies ProjectViewBody;
  });

/** Where a project is, as a reader is shown it: its namespace's handle and its own name. Nothing for a project with no place. */
const placeOf = (project: ProjectId) =>
  Effect.gen(function* () {
    const place = yield* ProjectNamespaces.use((places) => places.byId(project));
    if (Option.isNone(place)) return undefined;
    const namespace = yield* Namespaces.use((namespaces) => namespaces.byId(place.value.namespace));
    return {
      id: project,
      namespace: Option.match(namespace, {
        onNone: () => place.value.namespace,
        onSome: (record) => record.handle,
      }),
      name: place.value.name,
    } satisfies ProjectRef;
  });

/**
 * The project a fork was taken from, as the caller is shown it: its place,
 * and only where the policy lets the caller read that project, so a private
 * project is named to nobody outside it. Nothing for a source that is gone.
 */
const sourceOf = (caller: Caller, source: ProjectId) =>
  Effect.gen(function* () {
    const resource = yield* projectResource(source);
    return Result.isSuccess(decideEach(caller.principal, resource))
      ? yield* placeOf(source)
      : undefined;
  });

/**
 * A project's place for one item of a person's or an agent's list of
 * escalations: answered only where the policy lets the caller read what the
 * project's members see (the list's own rule), and decided once a project a
 * request.
 */
const escalationPlaces = (caller: Caller) => {
  const seen = new Map<ProjectId, ProjectRef | undefined>();
  return (project: ProjectId) =>
    seen.has(project)
      ? Effect.succeed(seen.get(project))
      : Effect.gen(function* () {
          const resource = yield* projectResource(project);
          const place = Result.isSuccess(
            authorize(caller.principal, "Operator_listEscalations", resource),
          )
            ? yield* placeOf(project)
            : undefined;
          seen.set(project, place);
          return place;
        });
};

/**
 * Whose list of escalations a caller reads: an agent, its own project's; a
 * person, their inbox, with the namespaces they maintain or own, their own
 * among them once they have a handle.
 */
const escalationReader = (caller: Caller): EscalationReader =>
  caller.principal._tag === "User"
    ? {
        _tag: "User",
        userId: caller.principal.userId,
        maintains: [
          ...(caller.principal.handle === undefined ? [] : [caller.principal.userId]),
          ...caller.principal.memberships
            .filter((membership) => membership.role !== "member")
            .map((membership) => membership.org),
        ],
      }
    : { _tag: "Project", project: projectOf(caller).projectId };

/**
 * The one handler object. The generated Hono routes and the generated MCP tools
 * both dispatch into it, so a REST call and a tool call run the same code, and
 * the same notices ride both. Lanes replace a `notYet` with a real handler as
 * they implement each operation.
 */
/** The sign-in methods mounted besides a passkey, as composition built them. */
export interface SignInMethods {
  readonly emailCode: boolean;
  readonly github: boolean;
}

/** What composition tells the handlers of the doorway they stand in. */
export interface Doorway {
  /** `https://<KEEL_HOST>`: where the console's pages are, and where a request arrived. */
  readonly origin: string;
  /** Whether the caller's session is a fresh sign-in, by the sign-in adapter's own rule. */
  readonly fresh: (caller: Caller) => boolean;
  /** Sign-up's check that the key a request registers made the proof beside it, by the identity adapter. */
  readonly provenKey: (request: {
    readonly jwk: unknown;
    readonly proof: string | undefined;
    readonly url: string;
  }) => Promise<
    | PresentedKey
    | {
        readonly refused: "invalid_client_metadata" | "invalid_dpop_proof";
        readonly detail: string;
      }
  >;
}

/** Where an agent signs up, as the spec has it: the path its proof must name. */
export const REGISTER_PATH = specRoute("Auth_registerClient");

/**
 * An agent as its own AgentSession DO answered it, with the namespace the
 * directory holds for it. The object's answer names none: it is never told
 * when an agent's namespace moves, so a profile reads it here.
 */
const placed = (agent: Agent) =>
  AgentDirectory.use((directory) => directory.findAgent(agent.id)).pipe(
    Effect.map((found) => {
      const namespace = Option.getOrUndefined(found)?.org;
      return namespace === undefined ? agent : { ...agent, org: namespace };
    }),
  );

export function makeHandlers(run: Runner, signIn: SignInMethods, doorway: Doorway) {
  /** A person's move that wants a fresh sign-in: refused here, before its port is called. */
  const touched = <A>(caller: Caller, move: () => A) =>
    doorway.fresh(caller) ? move() : freshSignInRequired(caller.requestId);
  /** An operator's move on an agent's standing, answered as the agent's profile. */
  const standing = (
    caller: Caller,
    operation: StandingOperation,
    input: Parameters<typeof standingInput>[0],
    move: typeof suspendAgent,
  ) => {
    const decoded = standingInput(input);
    if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
    return run(
      caller,
      actorOf(caller).pipe(
        Effect.flatMap((actor) => move(actor, decoded.success)),
        Effect.flatMap(placed),
        Effect.match({
          onSuccess: standingOk,
          onFailure: (error) => standingError(caller, operation, error),
        }),
      ),
    );
  };
  return piggyback(
    run,
    authorizeHandlers(
      {
        Auth_registerClient: async (caller: Caller, input: Input<"Auth_registerClient">) => {
          const proven = await doorway.provenKey({
            jwk: input.jwks.keys[0],
            proof: input.dpop,
            url: `${doorway.origin}${REGISTER_PATH}`,
          });
          if ("refused" in proven) return registrationRefused(proven.refused, proven.detail);
          return run(
            caller,
            signUpAgent(proven, input.client_name).pipe(
              Effect.map(registeredOk),
              // The id is another key's account (a collision in 128 bits of a thumbprint), or its handle is held.
              Effect.catchTag("SignUpRefused", () =>
                Effect.succeed(
                  registrationRefused(
                    "invalid_client_metadata",
                    "This key cannot sign up: make another key and sign up with that.",
                  ),
                ),
              ),
            ),
          );
        },
        Auth_exchangeToken: (
          caller: Caller,
          input: {
            readonly client_id: string;
            readonly client_secret: string;
            readonly scope?: string;
          },
        ) => {
          const requested =
            input.scope === undefined
              ? undefined
              : decodeScopes(input.scope.split(" ").filter(Boolean));
          if (requested !== undefined && requested._tag === "None") {
            return {
              status: 400 as const,
              body: { error: "invalid_scope" as const, error_description: "Unknown scope." },
            };
          }
          return run(
            caller,
            exchangeToken({
              clientId: input.client_id,
              clientSecret: input.client_secret,
              ...(requested === undefined ? {} : { scopes: requested.value }),
            }).pipe(
              Effect.map(tokenOk),
              Effect.catch((error) => Effect.succeed(tokenError(error))),
            ),
          );
        },
        whoami: (caller: Caller) =>
          caller.principal._tag !== "Agent"
            ? agentsOnly(caller.requestId)
            : run(
                caller,
                claimsOf(caller).pipe(
                  Effect.flatMap(whoami),
                  Effect.match({
                    onSuccess: whoamiOk,
                    onFailure: (error) => whoamiError(caller, error),
                  }),
                ),
              ),
        askSponsor: (caller: Caller) => {
          const { principal } = caller;
          if (principal._tag !== "Agent") return agentsOnly(caller.requestId);
          return run(
            caller,
            Sponsorships.use((links) => links.ask(principal.agentId)).pipe(
              Effect.match({
                onSuccess: (request) => askOk(doorway.origin, principal.agentId, request),
                onFailure: (error) => askError(caller, error),
              }),
            ),
          );
        },
        Agents_approveSponsor: (caller: Caller, input: Input<"Agents_approveSponsor">) =>
          touched(caller, () => {
            const agentId = decodeLinkAgent(input.agentId);
            if (Option.isNone(agentId)) return noSuchRequest(caller);
            return run(
              caller,
              actorOf(caller).pipe(
                Effect.flatMap((actor) =>
                  Sponsorships.use((links) =>
                    links.approve({
                      agentId: agentId.value,
                      by: actor.userId,
                      asked: { _tag: "Code", code: input.code },
                      idempotencyKey: input["idempotency-key"],
                    }),
                  ),
                ),
                Effect.flatMap(placed),
                Effect.match({
                  onSuccess: linkOk,
                  onFailure: (error) => approveError(caller, error),
                }),
              ),
            );
          }),
        Agents_endSponsorship: (caller: Caller, input: Input<"Agents_endSponsorship">) => {
          const end = () =>
            run(
              caller,
              Sponsorships.use((links) =>
                links.end(linkActorOf(caller), {
                  agentId: accountOf(caller).agentId,
                  idempotencyKey: input["idempotency-key"],
                }),
              ).pipe(
                Effect.flatMap(placed),
                Effect.match({
                  onSuccess: linkOk,
                  onFailure: (error) => endError(caller, error),
                }),
              ),
            );
          // An agent has no session to make fresh: the touch is asked of the person.
          return caller.principal._tag === "Agent" ? end() : touched(caller, end);
        },
        Agents_listSponsored: (caller: Caller) =>
          run(
            caller,
            actorOf(caller).pipe(
              Effect.flatMap((actor) =>
                AgentDirectory.use((directory) => directory.sponsoredBy(actor.userId)),
              ),
              Effect.map(sponsoredOk),
            ),
          ),
        Agents_getAgent: (caller: Caller, _input: Input<"Agents_getAgent">) =>
          run(
            caller,
            Effect.gen(function* () {
              const agent = yield* AgentDirectory.use((directory) =>
                directory.findAgent(accountOf(caller).agentId),
              );
              if (Option.isNone(agent)) return cardNotFound(caller);
              const { org } = agent.value;
              const place =
                org === undefined
                  ? Option.none()
                  : yield* Namespaces.use((namespaces) => namespaces.byId(org));
              return cardOk(
                agent.value,
                Option.match(place, { onNone: () => undefined, onSome: (record) => record.handle }),
              );
            }),
          ),
        Sessions_openSession: (caller: Caller, input: Input<"Sessions_openSession">) =>
          run(
            caller,
            tokenOf(caller).pipe(
              Effect.flatMap((principal) => openAgentSession(principal, sessionInput(input))),
              Effect.match({
                onSuccess: sessionOk,
                onFailure: (error) => sessionError(caller, error),
              }),
            ),
          ),
        declare: (caller: Caller, input: Input<"declare">) => {
          const decoded = declareInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            tokenOf(caller).pipe(
              Effect.flatMap((principal) => declareChange(principal, decoded.success)),
              Effect.match({
                onSuccess: declareOk,
                onFailure: (error) => declareError(caller, error),
              }),
            ),
          );
        },
        Changes_listChanges: (caller: Caller, input: Input<"Changes_listChanges">) => {
          const decoded = changeListInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            readChangeList(scopeOf(caller), decoded.success).pipe(Effect.map(changesOk)),
          );
        },
        change: (caller: Caller, input: Input<"change">) => {
          const decoded = changeIdInput(input.changeId);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            readChange(decoded.success).pipe(
              Effect.match({
                onSuccess: ({ change }) => changeOk(change),
                onFailure: (error) => changeReadError(caller, error),
              }),
            ),
          );
        },
        revise: (caller: Caller, input: Input<"revise">) => {
          const decoded = reviseInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            tokenOf(caller).pipe(
              Effect.flatMap((principal) => reviseChange(principal, decoded.success)),
              Effect.match({
                onSuccess: reviseOk,
                onFailure: (error) => reviseError(caller, error),
              }),
            ),
          );
        },
        rely: (caller: Caller, input: Input<"rely">) => {
          const decoded = relyInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            tokenOf(caller).pipe(
              Effect.flatMap((principal) => relyOn(principal, decoded.success)),
              Effect.match({ onSuccess: relyOk, onFailure: (error) => relyError(caller, error) }),
            ),
          );
        },
        nearby: (caller: Caller, input: Input<"nearby">) => {
          const decoded = changeIdInput(input.changeId);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          const changeId = decoded.success;
          return run(
            caller,
            nearbyOf(projectOf(caller).projectId, changeId).pipe(
              Effect.match({
                onSuccess: (preflight) => nearbyOk(changeId, preflight),
                onFailure: (error) => nearbyError(caller, error),
              }),
            ),
          );
        },
        abandon: (caller: Caller, input: Input<"abandon">) => {
          const decoded = abandonInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            withdrawerOf(caller).pipe(
              Effect.flatMap((by) => abandonChange(by, decoded.success)),
              Effect.match({
                onSuccess: abandonOk,
                onFailure: (error) => abandonError(caller, error),
              }),
            ),
          );
        },
        adopt: (caller: Caller, input: Input<"adopt">) => {
          const decoded = adoptInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            tokenOf(caller).pipe(
              Effect.flatMap((principal) => adoptChange(principal, decoded.success)),
              Effect.match({ onSuccess: adoptOk, onFailure: (error) => adoptError(caller, error) }),
            ),
          );
        },
        rebase: (caller: Caller, input: Input<"rebase">) => {
          const decoded = rebaseInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            tokenOf(caller).pipe(
              Effect.flatMap((principal) => rebaseChange(principal, decoded.success)),
              Effect.match({
                onSuccess: rebaseOk,
                onFailure: (error) => rebaseError(caller, error),
              }),
            ),
          );
        },
        sketch: notYet,
        Workspaces_refreshWorkspaceToken: notYet,
        Workspaces_releaseWorkspace: notYet,
        submit: (caller: Caller, input: Input<"submit">) => {
          const decoded = submitInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            tokenOf(caller).pipe(
              Effect.flatMap((principal) => submitChange(principal, decoded.success)),
              Effect.match({
                onSuccess: (change) => submitOk(change, decoded.success.commitSha),
                onFailure: (error) => submitError(caller, error),
              }),
            ),
          );
        },
        status: (caller: Caller, input: Input<"status">) => {
          const changeId = changeIdInput(input.changeId);
          if (Result.isFailure(changeId)) return invalid(caller, changeId.failure);
          return run(
            caller,
            submissionOf(changeId.success, input.wait).pipe(
              Effect.match({
                onSuccess: (status) => statusOk(caller, status),
                onFailure: (error) => statusError(caller, error),
              }),
            ),
          );
        },
        Conflicts_listConflicts: (caller: Caller, input: Input<"Conflicts_listConflicts">) => {
          const decoded = conflictListInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            readConflictList(scopeOf(caller), decoded.success).pipe(Effect.map(conflictsOk)),
          );
        },
        Conflicts_getConflict: (caller: Caller, input: Input<"Conflicts_getConflict">) =>
          run(
            caller,
            readConflict(scopeOf(caller), ConflictId.make(input.conflictId)).pipe(
              Effect.match({
                onSuccess: (record) => conflictOk(record, scopeOf(caller).audience),
                onFailure: (e) => conflictNotFound(caller, e),
              }),
            ),
          ),
        Probes_getProbeSource: (caller: Caller, input: Input<"Probes_getProbeSource">) =>
          run(
            caller,
            readProbeSource(scopeOf(caller), ProbeId.make(input.probeId)).pipe(
              Effect.match({
                onSuccess: probeSourceOk,
                onFailure: (e) => probeNotFound(caller, e),
              }),
            ),
          ),
        resolve: (caller: Caller, input: Input<"resolve">) => {
          const decoded = resolveInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          // One move is built: a party puts its conflict to a person. The others are B3's.
          if (decoded.success.move !== "escalate") return notYet(caller);
          return run(
            caller,
            tokenOf(caller).pipe(
              Effect.flatMap((principal) =>
                resolveMove(principal, scopeOf(caller), decoded.success),
              ),
              Effect.match({
                onSuccess: resolveOk,
                onFailure: (error) => resolveError(caller, error),
              }),
            ),
          );
        },
        why: notYet,
        Memory_listDecisions: notYet,
        Memory_getDecision: notYet,
        inbox: (caller: Caller, input: Input<"inbox">) =>
          caller.principal._tag !== "Agent"
            ? agentsOnly(caller.requestId)
            : run(
                caller,
                tokenOf(caller).pipe(
                  Effect.flatMap((principal) => readInbox(principal, input.cursor, input.wait)),
                  Effect.map(inboxOk),
                ),
              ),
        Inbox_listEvents: (caller: Caller, input: Input<"Inbox_listEvents">) => {
          const decoded = eventsInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          const { project: _named, ...read } = decoded.success;
          if (caller.resource !== undefined)
            return run(
              caller,
              readEvents({ _tag: "Project", ...scopeOf(caller) }, read).pipe(Effect.map(eventsOk)),
            );
          if (caller.principal._tag !== "User")
            return invalid(caller, [
              {
                path: ["project"],
                message: "Name a project: only a signed-in user reads across projects.",
              },
            ]);
          const { principal } = caller;
          // A user naming no project reads every project it may, each decided by the policy once per request.
          return run(
            caller,
            Effect.gen(function* () {
              const services = yield* Effect.context<ProjectNamespaces | Namespaces | Projects>();
              const decided = new Map<ProjectId, Audience | undefined>();
              const audienceOf = (project: ProjectId) =>
                decided.has(project)
                  ? Effect.succeed(decided.get(project))
                  : projectResource(project).pipe(
                      Effect.map((resource) => {
                        const decision = decideEach(principal, resource);
                        const audience = Result.isSuccess(decision)
                          ? (decision.success.audience ?? "public")
                          : undefined;
                        decided.set(project, audience);
                        return audience;
                      }),
                      Effect.provideContext(services),
                    );
              return eventsOk(yield* readEvents({ _tag: "Readable", audienceOf }, read));
            }),
          );
        },
        Inbox_getSnapshot: (caller: Caller, _input: Input<"Inbox_getSnapshot">) =>
          run(caller, readSnapshot(scopeOf(caller)).pipe(Effect.map(snapshotOk))),
        Lattices_listLattices: latticesOk,
        // The repo reads admit a caller without a token: the policy decided by the project's visibility.
        Repo_getTree: (caller: Caller, input: Input<"Repo_getTree">) => {
          const projectId = settingsProject(input.projectId);
          if (Result.isFailure(projectId)) return invalid(caller, projectId.failure);
          return run(
            caller,
            readRepoTree(projectId.success, {
              ...(input.ref === undefined ? {} : { ref: input.ref }),
              path: input.path ?? "",
            }).pipe(Effect.match({ onSuccess: treeOk, onFailure: (e) => repoError(caller, e) })),
          );
        },
        Repo_getBlob: (caller: Caller, input: Input<"Repo_getBlob">) => {
          const projectId = settingsProject(input.projectId);
          if (Result.isFailure(projectId)) return invalid(caller, projectId.failure);
          return run(
            caller,
            readRepoBlob(projectId.success, {
              ...(input.ref === undefined ? {} : { ref: input.ref }),
              path: input.path,
            }).pipe(Effect.match({ onSuccess: blobOk, onFailure: (e) => repoError(caller, e) })),
          );
        },
        Repo_listCommits: (caller: Caller, input: Input<"Repo_listCommits">) => {
          const projectId = settingsProject(input.projectId);
          if (Result.isFailure(projectId)) return invalid(caller, projectId.failure);
          const from = commitsFrom(input.cursor);
          if (Result.isFailure(from)) return invalid(caller, from.failure);
          return run(
            caller,
            listRepoCommits(projectId.success, {
              ...(input.ref === undefined ? {} : { ref: input.ref }),
              ...(from.success === undefined ? {} : { from: from.success }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }).pipe(Effect.match({ onSuccess: commitsOk, onFailure: (e) => repoError(caller, e) })),
          );
        },
        Repo_getCommit: (caller: Caller, input: Input<"Repo_getCommit">) => {
          const projectId = settingsProject(input.projectId);
          if (Result.isFailure(projectId)) return invalid(caller, projectId.failure);
          const sha = commitParam(input.sha);
          if (Result.isFailure(sha)) return invalid(caller, sha.failure);
          return run(
            caller,
            readRepoCommit(projectId.success, sha.success).pipe(
              Effect.match({ onSuccess: commitOk, onFailure: (e) => repoError(caller, e) }),
            ),
          );
        },
        Views_getVerdict: notYet,
        Views_getCandidate: notYet,
        Views_listLanes: notYet,
        Views_getTrunk: notYet,
        // Anyone lists projects: one page is read for the caller's audience and the policy decides each row, so a visitor sees the public ones.
        Operator_listProjects: (caller: Caller, input: Input<"Operator_listProjects">) => {
          const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
          if (after !== undefined && Option.isNone(after))
            return invalid(caller, [{ path: ["cursor"], message: "Not a cursor Keel gave out" }]);
          const limit = Math.min(input.limit ?? 50, 100);
          return run(
            caller,
            listProjects(
              caller.principal,
              after === undefined ? undefined : Option.getOrUndefined(after),
              limit,
            ).pipe(
              Effect.map((page) => ({
                status: 200 as const,
                body: {
                  items: page.items.map((row): ProjectViewBody => {
                    const role = viewerRole(caller.principal, row);
                    return {
                      id: row.projectId,
                      namespace: { handle: row.handle, kind: row.kind },
                      name: row.name,
                      visibility: row.visibility,
                      ...(role === undefined ? {} : { viewer: { role } }),
                    };
                  }),
                  ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
                },
              })),
            ),
          );
        },
        // The namespace was decided before this ran. The source is read before anything is made: an
        // import's URL and branch by Keel's own rules, and a project to fork, which is a second resource
        // named in the body, decided as a fork.
        Operator_createProject: (caller: Caller, input: Input<"Operator_createProject">) => {
          const source = projectSource(input.source);
          if (source._tag === "Unknown") return Promise.resolve(sourceNotFound(caller, input));
          if (source._tag === "Refused") return Promise.resolve(sourceRefused(caller, source));
          return run(
            caller,
            Effect.gen(function* () {
              // An agent's token names the run it creates in: the project's first event carries it.
              const actor = creatorOf(caller);
              const inRun = caller.token?.run;
              const target = caller.resource?._tag === "Namespace" ? caller.resource : undefined;
              if (target === undefined)
                return yield* Effect.die(new Error("createProject ran without its namespace"));
              if (source._tag === "Project") {
                const from = yield* projectResource(source.projectId);
                const decided = decideFork(caller.principal, from, target);
                if (Result.isFailure(decided))
                  return refusalResult(
                    "Operator_forkProject",
                    input,
                    caller.requestId,
                    decided.failure,
                  );
              }
              const forkedFrom =
                source._tag === "Project" ? yield* sourceOf(caller, source.projectId) : undefined;
              return yield* createProject(actor, {
                namespace: target.namespace,
                name: input.name,
                source,
                ...(inRun === undefined ? {} : { run: inRun }),
                idempotencyKey: input["idempotency-key"],
              }).pipe(
                Effect.map((project) =>
                  createProjectOk(
                    project,
                    {
                      handle: input.namespace.toLowerCase(),
                      kind: namespaceKind(target.namespace),
                    },
                    roleIn(caller.principal, target.namespace),
                    forkedFrom,
                  ),
                ),
                Effect.catch((error) =>
                  Effect.succeed(createProjectError(caller, input.namespace.toLowerCase(), error)),
                ),
              );
            }),
          );
        },
        Namespaces_getNamespace: (caller: Caller, input: Input<"Namespaces_getNamespace">) =>
          run(
            caller,
            Namespaces.use((namespaces) => namespaces.byHandle(input.handle)).pipe(
              Effect.map(
                Option.match({
                  onNone: () => ({
                    status: 404 as const,
                    body: problem(404, "resource.not_found", caller.requestId),
                  }),
                  onSome: (found) => ({
                    status: 200 as const,
                    body: { id: found.namespace, handle: found.handle, kind: found.kind },
                  }),
                }),
              ),
            ),
          ),
        Namespaces_getProject: (caller: Caller, input: Input<"Namespaces_getProject">) =>
          run(
            caller,
            readableView(caller, projectOf(caller).projectId, input.name.toLowerCase()).pipe(
              Effect.map((view) =>
                view === undefined
                  ? {
                      status: 404 as const,
                      body: problem(404, "resource.not_found", caller.requestId),
                    }
                  : { status: 200 as const, body: view },
              ),
            ),
          ),
        Users_me: (caller: Caller) => {
          const { principal } = caller;
          if (principal._tag !== "User")
            return Promise.reject(new Error("Users_me ran without a user"));
          return run(
            caller,
            Effect.forEach(principal.memberships, (membership) =>
              Namespaces.use((namespaces) => namespaces.byId(membership.org)).pipe(
                Effect.map((org) => ({
                  id: membership.org,
                  name: Option.match(org, {
                    onNone: () => membership.org,
                    onSome: (found) => found.handle,
                  }),
                  role: membership.role,
                })),
              ),
            ).pipe(
              Effect.map((orgs) => ({
                status: 200 as const,
                body: {
                  userId: principal.userId,
                  ...(principal.handle === undefined
                    ? {}
                    : {
                        handle: principal.handle,
                        namespace: { handle: principal.handle, kind: "user" as const },
                      }),
                  orgs,
                },
              })),
            ),
          );
        },
        Operator_getSettings: (caller: Caller, input: Input<"Operator_getSettings">) => {
          const projectId = settingsProject(input.projectId);
          if (Result.isFailure(projectId)) return invalid(caller, projectId.failure);
          return run(
            caller,
            getSettings(projectId.success).pipe(
              Effect.match({
                onSuccess: settingsOk,
                onFailure: (error) => settingsError(caller, error),
              }),
            ),
          );
        },
        Operator_putSettings: (caller: Caller, input: Input<"Operator_putSettings">) => {
          const decoded = putSettingsInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          const { projectId, settings } = decoded.success;
          return run(
            caller,
            actorOf(caller).pipe(
              Effect.flatMap((actor) => putSettings(actor, projectId, settings, caller.requestId)),
              Effect.match({
                onSuccess: settingsOk,
                onFailure: (error) => putSettingsError(caller, error),
              }),
            ),
          );
        },
        Operator_enrolAgent: (caller: Caller, input: Input<"Operator_enrolAgent">) => {
          const decoded = enrolInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            actorOf(caller).pipe(
              Effect.flatMap((actor) => enrolAgent(actor.userId, decoded.success)),
              Effect.match({
                onSuccess: enrolAgentOk,
                onFailure: (error) => enrolAgentError(caller, error),
              }),
            ),
          );
        },
        Operator_suspendAgent: (caller: Caller, input: Input<"Operator_suspendAgent">) =>
          touched(caller, () => standing(caller, "Operator_suspendAgent", input, suspendAgent)),
        Operator_reinstateAgent: (caller: Caller, input: Input<"Operator_reinstateAgent">) =>
          touched(caller, () => standing(caller, "Operator_reinstateAgent", input, reinstateAgent)),
        Operator_revokeAgent: (caller: Caller, input: Input<"Operator_revokeAgent">) =>
          standing(caller, "Operator_revokeAgent", input, revokeAgent),
        Operator_listEscalations: (caller: Caller, input: Input<"Operator_listEscalations">) => {
          const decoded = escalationListInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            readEscalationList(
              escalationReader(caller),
              decoded.success,
              escalationPlaces(caller),
            ).pipe(Effect.map(escalationsOk)),
          );
        },
        Operator_giveRuling: (caller: Caller, input: Input<"Operator_giveRuling">) => {
          const decoded = rulingInput(input);
          if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
          return run(
            caller,
            actorOf(caller).pipe(
              Effect.flatMap((actor) =>
                ruleOnEscalation({ ...decoded.success, by: actor.userId }, placeOf),
              ),
              Effect.match({
                onSuccess: rulingOk,
                onFailure: (error) => rulingError(caller, error),
              }),
            ),
          );
        },
        SignIn_methods: async () => ({ status: 200 as const, body: { ...signIn } }),
      } satisfies Operations<Caller>,
      RESOLVERS,
      run,
    ),
  );
}

export type Handlers = ReturnType<typeof makeHandlers>;
