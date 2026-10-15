import {
  type Actor,
  type Agent,
  type AgentClaims,
  answers,
  type Audience,
  type IdempotencyConflict,
  INVITED_SCOPES,
  type Invitation,
  type InvitationRefused,
  InvitationScopes,
} from "@keeltown/core/domain/identity";
import { AgentId, NamespaceId, ProjectId, type UserId } from "@keeltown/core/kernel";
import {
  AgentDirectory,
  Clock,
  Invitations,
  Memberships,
  NamespaceAgents,
  type NamespaceRecord,
  Namespaces,
  ProjectAgents,
  ProjectNamespaces,
  type ProjectPlace,
} from "@keeltown/core/ports";
import { Effect, Option, Result, Schema } from "effect";
import type {
  Agents_acceptInvitationResult,
  Agents_acceptProjectInvitationResult,
  Agents_leaveNamespaceResult,
  Agents_leaveProjectResult,
  Agents_listNamespacesResult,
  Agents_listProjectsResult,
  Agents_listReachableProjectsResult,
  Agents_useProjectResult,
  Namespaces_inviteAgentResult,
  Namespaces_listAgentsResult,
  Namespaces_removeAgentResult,
  Operations,
  Projects_inviteAgentResult,
  Projects_listAgentsResult,
  Projects_removeAgentResult,
} from "../../../generated/http/app.gen.ts";
import { agentsOnly } from "./authorize-handlers.ts";
import type { Caller } from "./caller.ts";
import { runView } from "./mappers.ts";
import { problem, type ProblemBody } from "./problems.ts";
import type { Runner } from "./run.ts";

/**
 * The invitation of an agent into an org: a member's invitation and removal,
 * the list anyone reads, and the agent's own list, acceptance and leaving. And
 * the same six for one project of a person's own namespace, where an agent is
 * taken on a project and never on the whole namespace. Mappers are pure and
 * each error union is mapped exhaustively; the handlers call the ports and
 * nothing else.
 */

type Input<A extends keyof Operations<Caller>> = Parameters<Operations<Caller>[A]>[1];

const iso = (ms: number) => new Date(ms).toISOString();

const decodeAgentId = Schema.decodeUnknownOption(AgentId);
const decodeNamespaceId = Schema.decodeUnknownOption(NamespaceId);
const decodeProjectId = Schema.decodeUnknownOption(ProjectId);
const decodeScopes = Schema.decodeUnknownOption(InvitationScopes);

type NamespaceAgentBody = Extract<Namespaces_removeAgentResult, { readonly status: 200 }>["body"];
type AgentNamespaceBody = Extract<Agents_leaveNamespaceResult, { readonly status: 200 }>["body"];
type AgentProjectBody = Extract<Agents_leaveProjectResult, { readonly status: 200 }>["body"];

/**
 * An agent in an org as its members read it, or as anyone else does: who it
 * is and where its invitation stands, and never what the invitation gives or
 * who made it.
 */
export function namespaceAgent(
  invitation: Invitation,
  agent: Agent | undefined,
  audience: Audience,
): NamespaceAgentBody {
  return {
    id: invitation.agentId,
    name: agent?.name ?? invitation.agentId,
    ...(agent?.handle === undefined ? {} : { handle: agent.handle }),
    ...(agent?.kind === undefined ? {} : { kind: agent.kind }),
    state: invitation.state,
    ...(audience === "members"
      ? {
          scopes: [...invitation.scopes],
          invitedBy: invitation.by,
          invitedAt: iso(invitation.invitedAt),
        }
      : {}),
    ...(invitation.joinedAt === undefined ? {} : { joinedAt: iso(invitation.joinedAt) }),
  };
}

/** A namespace an agent was invited into, as the agent reads it: never who invited it. */
export function agentNamespace(invitation: Invitation, place: NamespaceRecord): AgentNamespaceBody {
  return {
    namespace: { handle: place.handle, kind: place.kind },
    state: invitation.state,
    scopes: [...invitation.scopes],
    invitedAt: iso(invitation.invitedAt),
    ...(invitation.joinedAt === undefined ? {} : { joinedAt: iso(invitation.joinedAt) }),
  };
}

/**
 * The orgs an agent has joined, as anyone reads them on its card: each by its
 * handle, oldest invitation first. An invitation not yet accepted is in none,
 * and who made any of them is never read.
 */
export const joinedOrgs = (agentId: AgentId) =>
  Effect.gen(function* () {
    const rows = yield* NamespaceAgents.use((agents) => agents.ofAgent(agentId));
    const namespaces = yield* Namespaces;
    const places = yield* Effect.forEach(
      rows.filter((row) => row.state === "joined"),
      (row) => namespaces.byId(row.namespace),
    );
    return places.flatMap((place) =>
      Option.match(place, {
        onNone: () => [],
        onSome: (found) => [{ handle: found.handle, kind: found.kind }],
      }),
    );
  });

/** Whether whoever made an invitation still answers for the agent it invited, as the gate reads it. */
const answered = (invitation: Invitation) =>
  Memberships.use((memberships) => memberships.standing(invitation.by, invitation.namespace)).pipe(
    Effect.map(answers),
  );

/**
 * The projects an agent can read and work in now, by the facts the gate
 * decides a token on: every project of its own namespace, every project of
 * each org whose invitation it accepted, and each project it accepted an
 * invitation to by itself, while whoever invited it still answers for it
 * there. A pending invitation reaches nothing. By namespace handle, then name.
 */
export const reachableProjects = (agentId: AgentId) =>
  Effect.gen(function* () {
    const places = yield* ProjectNamespaces;
    const namespaces = yield* Namespaces;
    // An agent governs its own namespace: it reads and works on every project there.
    const own = places
      .inNamespace(agentId)
      .pipe(
        Effect.map((projects) =>
          projects.map((place) => ({ place, through: "own" as const, scopes: INVITED_SCOPES })),
        ),
      );
    const orgs = NamespaceAgents.use((agents) => agents.ofAgent(agentId)).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.filter((row) => row.state === "joined"),
          (row) =>
            Effect.flatMap(answered(row), (stands) =>
              stands
                ? places.inNamespace(row.namespace).pipe(
                    Effect.map((projects) =>
                      projects.map((place) => ({
                        place,
                        through: "org" as const,
                        scopes: row.scopes,
                      })),
                    ),
                  )
                : Effect.succeed([]),
            ),
        ),
      ),
      Effect.map((lists) => lists.flat()),
    );
    const projects = ProjectAgents.use((agents) => agents.ofAgent(agentId)).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.filter((row) => row.state === "joined"),
          (row) => {
            const { projectId } = row;
            return projectId === undefined
              ? Effect.succeed([])
              : Effect.flatMap(answered(row), (stands) =>
                  stands
                    ? places.byId(projectId).pipe(
                        Effect.map((place) =>
                          Option.toArray(place).map((found) => ({
                            place: found,
                            through: "project" as const,
                            scopes: row.scopes,
                          })),
                        ),
                      )
                    : Effect.succeed([]),
                );
          },
        ),
      ),
      Effect.map((lists) => lists.flat()),
    );
    const reached = [...(yield* own), ...(yield* orgs), ...(yield* projects)];
    const named = yield* Effect.forEach(reached, (item) =>
      namespaces.byId(item.place.namespace).pipe(
        Effect.map(
          Option.map((namespace) => ({
            project: {
              id: item.place.projectId,
              namespace: namespace.handle,
              name: item.place.name,
            },
            through: item.through,
            scopes: [...item.scopes],
          })),
        ),
      ),
    );
    return named
      .flatMap((item) => Option.toArray(item))
      .toSorted(
        (a, b) =>
          a.project.namespace.localeCompare(b.project.namespace) ||
          a.project.name.localeCompare(b.project.name),
      );
  });

/**
 * The project a token names, as the agent reaches it now; none when the token
 * names no project or the agent cannot reach it. What the agent may do there
 * is the policy's to say.
 */
export const tokenProject = (claims: AgentClaims) =>
  Effect.gen(function* () {
    if (claims.projectId === undefined) return undefined;
    return (yield* reachableProjects(claims.agentId)).find(
      (item) => item.project.id === claims.projectId,
    )?.project;
  });

/**
 * A project an agent was invited to, as the agent reads it: the project by its
 * id, its name and its namespace's handle, and never who invited it.
 */
export function agentProject(
  invitation: Invitation,
  place: ProjectPlace,
  namespace: NamespaceRecord,
): AgentProjectBody {
  return {
    project: { id: place.projectId, namespace: namespace.handle, name: place.name },
    state: invitation.state,
    scopes: [...invitation.scopes],
    invitedAt: iso(invitation.invitedAt),
    ...(invitation.joinedAt === undefined ? {} : { joinedAt: iso(invitation.joinedAt) }),
  };
}

const notFound = (caller: Caller, detail?: string) => ({
  status: 404 as const,
  body: problem(
    404,
    "resource.not_found",
    caller.requestId,
    detail === undefined ? {} : { detail },
  ),
});

/** A project chosen by a token that names no run: a choice is a run's, and nothing holds one that is no run's. */
const runRequired = (caller: Caller) => ({
  status: 409 as const,
  body: problem(409, "run.required", caller.requestId, {
    detail:
      "Your token names no run, and the project you work in is chosen for a run: ask for a token with `run` set.",
    nextActions: [
      {
        kind: "escalate" as const,
        title:
          "Ask the token endpoint for a token with `run` set to a label of your own, then choose again",
      },
    ],
  }),
});

/** An invitation asked for with scopes no invitation gives: 400, from the body's check or the machine's. */
const scopesRefused = (caller: Caller) => ({
  status: 400 as const,
  body: problem(400, "request.invalid", caller.requestId, {
    detail: "An invitation gives agent:read, or agent:read and agent:work, each named once.",
  }),
});

const idempotencyConflict = (caller: Caller, error: IdempotencyConflict, operationId: string) => ({
  status: 409 as const,
  body: problem(409, "request.idempotency_conflict", caller.requestId, {
    detail: `Idempotency-Key ${error.idempotencyKey} was used for a different move on this invitation.`,
    nextActions: [
      { kind: "call" as const, title: "Call again with a fresh Idempotency-Key", operationId },
    ],
  }),
});

/**
 * The refusals of a move on an agent's place as it stands, in a namespace or
 * on one project: 409, saying what is in the way. It names no person: a member
 * reads who invited the agent from the org's list, and a project's owner made
 * every invitation to it. Scopes no invitation gives are 400, as the body's
 * own check answers them before the machine is asked.
 */
function stateRefused(
  caller: Caller,
  error: InvitationRefused,
): { readonly status: 400 | 409; readonly body: ProblemBody } {
  switch (error.reason) {
    case "already-invited":
      return {
        status: 409,
        body: problem(
          409,
          "invitation.state_refused",
          caller.requestId,
          error.projectId === undefined
            ? {
                detail: `${error.agentId} already has an invitation here, and one member answers for an agent in an org. Take it out first to invite it again or to change what it may do.`,
                nextActions: [
                  {
                    kind: "read",
                    title: "Read the org's agents and who invited each",
                    operationId: "Namespaces_listAgents",
                  },
                ],
              }
            : {
                detail: `${error.agentId} already has an invitation to this project. Take it off first to invite it again or to change what it may do.`,
                nextActions: [
                  {
                    kind: "read",
                    title: "Read the agents invited to the project",
                    operationId: "Projects_listAgents",
                  },
                ],
              },
        ),
      };
    case "not-invited":
      return {
        status: 409,
        body: problem(409, "invitation.state_refused", caller.requestId, {
          detail: `${error.agentId} has no invitation here.`,
        }),
      };
    case "not-a-party":
      return {
        status: 409,
        body: problem(409, "invitation.state_refused", caller.requestId, {
          detail: `The invitation of ${error.agentId} is not this caller's to end.`,
        }),
      };
    case "invalid-scopes":
      return scopesRefused(caller);
    default: {
      const unmapped: never = error.reason;
      return unmapped;
    }
  }
}

export function inviteError(
  caller: Caller,
  error: InvitationRefused | IdempotencyConflict,
  operationId = "Namespaces_inviteAgent",
): { readonly status: 400 | 409; readonly body: ProblemBody } {
  switch (error._tag) {
    case "InvitationRefused":
      return stateRefused(caller, error);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, operationId);
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/**
 * The refusals of an end, or of the agent's own answer: with no invitation
 * there the agent, or the namespace or the project, is not found, whoever
 * asks, so a place that never invited an agent and one that does not exist
 * read the same to it.
 */
function moveError(
  caller: Caller,
  error: InvitationRefused | IdempotencyConflict,
  operationId: string,
): { readonly status: 400 | 404 | 409; readonly body: ProblemBody } {
  switch (error._tag) {
    case "InvitationRefused":
      return error.reason === "not-invited" ? notFound(caller) : stateRefused(caller, error);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, operationId);
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/** Who ends an invitation: the agent itself, or the person the policy granted. */
function endingActor(caller: Caller): Actor {
  const { principal } = caller;
  if (principal._tag === "Agent") return { _tag: "Agent", agentId: principal.agentId };
  if (principal._tag === "User") return { _tag: "User", userId: principal.userId };
  throw new Error("an invitation's end ran for neither an agent nor a user");
}

/** The namespace the call was decided on, as `authorizeHandlers` resolved it. */
function namespaceOf(caller: Caller): NamespaceId {
  if (caller.resource?._tag !== "Namespace")
    throw new Error("a namespace's operation ran without its namespace resolved");
  return caller.resource.namespace;
}

/** A namespace as an agent names it: by its id, as an invitation's notice does, or by its handle. */
const namespaceGiven = (given: string) =>
  Namespaces.use((namespaces) =>
    Option.match(decodeNamespaceId(given), {
      onNone: () => namespaces.byHandle(given),
      onSome: (id) => namespaces.byId(id),
    }),
  );

const withAgent = (invitation: Invitation) =>
  AgentDirectory.use((directory) => directory.findAgent(invitation.agentId)).pipe(
    Effect.map((agent) => namespaceAgent(invitation, Option.getOrUndefined(agent), "members")),
  );

/**
 * What an invitation's request asks, checked before any object is called: the
 * person inviting, the agent its handle names, and what the invitation gives.
 * A failure is the answer to give in its place.
 */
const invitationAsked = (
  caller: Caller,
  input: { readonly agent: string; readonly scopes?: readonly string[] | undefined },
): Effect.Effect<
  Result.Result<
    { readonly by: UserId; readonly agentId: AgentId; readonly scopes: InvitationScopes },
    { readonly status: 400 | 404; readonly body: ProblemBody }
  >,
  never,
  Namespaces
> =>
  Effect.gen(function* () {
    const { principal } = caller;
    if (principal._tag !== "User")
      return yield* Effect.die(new Error("an invitation ran without a user"));
    const scopes = decodeScopes(input.scopes ?? INVITED_SCOPES);
    if (Option.isNone(scopes)) return Result.fail(scopesRefused(caller));
    // An agent's handle is its own namespace's, and that namespace's id is the agent's.
    const named = yield* Namespaces.use((namespaces) => namespaces.byHandle(input.agent));
    const agentId = Option.flatMap(named, (found) =>
      found.kind === "agent" ? decodeAgentId(found.namespace) : Option.none(),
    );
    if (Option.isNone(agentId))
      return Result.fail(notFound(caller, `No agent has the handle ${input.agent}.`));
    return Result.succeed({ by: principal.userId, agentId: agentId.value, scopes: scopes.value });
  });

/** The project the call was decided on, as `authorizeHandlers` resolved it. */
function projectIn(caller: Caller) {
  if (caller.resource?._tag !== "Project")
    throw new Error("a project's operation ran without its project resolved");
  return caller.resource;
}

/** A project as an agent names it, by its id, with its namespace: where its invitation is kept and how it is shown. */
const projectGiven = (
  given: string,
): Effect.Effect<
  Option.Option<{ readonly place: ProjectPlace; readonly namespace: NamespaceRecord }>,
  never,
  ProjectNamespaces | Namespaces
> =>
  Option.match(decodeProjectId(given), {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (projectId) =>
      Effect.gen(function* () {
        const place = yield* ProjectNamespaces.use((places) => places.byId(projectId));
        if (Option.isNone(place)) return Option.none();
        const namespace = yield* Namespaces.use((namespaces) =>
          namespaces.byId(place.value.namespace),
        );
        return Option.map(namespace, (record) => ({ place: place.value, namespace: record }));
      }),
  });

/** An agent's own operation: asked by anyone else it is refused as every agents' operation is. */
const asAgent = <A>(caller: Caller, move: (agentId: AgentId) => A) =>
  caller.principal._tag === "Agent" ? move(caller.principal.agentId) : agentsOnly(caller.requestId);

/**
 * The six operations of an agent's invitation into an org. `touched` asks a
 * person's fresh sign-in before a move: the invitation and the removal are a
 * signed-in page's to make, or a terminal's whose sign-in was approved with a
 * passkey within ten minutes. The agent's own answer needs none: it has no
 * session to make fresh.
 */
export function invitationHandlers(
  run: Runner,
  touched: <A>(
    caller: Caller,
    move: () => A,
  ) => A | { readonly status: 403; readonly body: ProblemBody },
) {
  return {
    Namespaces_listAgents: (caller: Caller, _input: Input<"Namespaces_listAgents">) =>
      run(
        caller,
        Effect.gen(function* () {
          const audience = caller.audience ?? "public";
          const rows = yield* NamespaceAgents.use((agents) =>
            agents.inNamespace(namespaceOf(caller)),
          );
          const directory = yield* AgentDirectory;
          // A pending invitation is its members' to see: anyone else reads who has joined.
          const items = yield* Effect.forEach(
            rows.filter((row) => audience === "members" || row.state === "joined"),
            (row) =>
              directory
                .findAgent(row.agentId)
                .pipe(
                  Effect.map((agent) =>
                    namespaceAgent(row, Option.getOrUndefined(agent), audience),
                  ),
                ),
          );
          return { status: 200 as const, body: { items } } satisfies Namespaces_listAgentsResult;
        }),
      ),
    Namespaces_inviteAgent: (caller: Caller, input: Input<"Namespaces_inviteAgent">) =>
      touched(caller, () =>
        run(
          caller,
          Effect.gen(function* () {
            const asked = yield* invitationAsked(caller, input);
            if (Result.isFailure(asked))
              return asked.failure satisfies Namespaces_inviteAgentResult;
            return yield* Invitations.use((invitations) =>
              invitations.invite({
                namespace: namespaceOf(caller),
                ...asked.success,
                idempotencyKey: input["idempotency-key"],
              }),
            ).pipe(
              Effect.flatMap(withAgent),
              Effect.match({
                onSuccess: (body) => ({ status: 201 as const, body }),
                onFailure: (error) => inviteError(caller, error),
              }),
            );
          }),
        ),
      ),
    Namespaces_removeAgent: (caller: Caller, input: Input<"Namespaces_removeAgent">) =>
      touched(caller, () =>
        run(
          caller,
          Option.match(decodeAgentId(input.agentId), {
            onNone: () => Effect.succeed<Namespaces_removeAgentResult>(notFound(caller)),
            onSome: (agentId) =>
              Invitations.use((invitations) =>
                invitations.end(endingActor(caller), {
                  namespace: namespaceOf(caller),
                  agentId,
                  idempotencyKey: input["idempotency-key"],
                }),
              ).pipe(
                Effect.flatMap(withAgent),
                Effect.match({
                  onSuccess: (body): Namespaces_removeAgentResult => ({ status: 200, body }),
                  onFailure: (error) => moveError(caller, error, "Namespaces_removeAgent"),
                }),
              ),
          }),
        ),
      ),
    Agents_listNamespaces: (caller: Caller) =>
      asAgent(caller, (agentId) =>
        run(
          caller,
          Effect.gen(function* () {
            const rows = yield* NamespaceAgents.use((agents) => agents.ofAgent(agentId));
            const namespaces = yield* Namespaces;
            const places = yield* Effect.forEach(rows, (row) =>
              namespaces
                .byId(row.namespace)
                .pipe(Effect.map(Option.map((place) => agentNamespace(row, place)))),
            );
            return {
              status: 200 as const,
              body: { items: places.flatMap((place) => Option.toArray(place)) },
            } satisfies Agents_listNamespacesResult;
          }),
        ),
      ),
    Agents_acceptInvitation: (caller: Caller, input: Input<"Agents_acceptInvitation">) =>
      asAgent(caller, (agentId) =>
        run(
          caller,
          namespaceGiven(input.namespace).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed<Agents_acceptInvitationResult>(notFound(caller)),
                onSome: (place) =>
                  Invitations.use((invitations) =>
                    invitations.accept({
                      namespace: place.namespace,
                      agentId,
                      run: caller.token?.run,
                      idempotencyKey: input["idempotency-key"],
                    }),
                  ).pipe(
                    Effect.match({
                      onSuccess: (invitation): Agents_acceptInvitationResult => ({
                        status: 200,
                        body: agentNamespace(invitation, place),
                      }),
                      onFailure: (error) => moveError(caller, error, "Agents_acceptInvitation"),
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
    Agents_leaveNamespace: (caller: Caller, input: Input<"Agents_leaveNamespace">) =>
      asAgent(caller, (agentId) =>
        run(
          caller,
          namespaceGiven(input.namespace).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed<Agents_leaveNamespaceResult>(notFound(caller)),
                onSome: (place) =>
                  Invitations.use((invitations) =>
                    invitations.end(endingActor(caller), {
                      namespace: place.namespace,
                      agentId,
                      run: caller.token?.run,
                      idempotencyKey: input["idempotency-key"],
                    }),
                  ).pipe(
                    Effect.match({
                      onSuccess: (invitation): Agents_leaveNamespaceResult => ({
                        status: 200,
                        body: agentNamespace(invitation, place),
                      }),
                      onFailure: (error) => moveError(caller, error, "Agents_leaveNamespace"),
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
  };
}

/**
 * The six operations of an agent's invitation to one project of a person's
 * own namespace. The policy has already answered a project anywhere else as
 * missing, and an agent that asks to invite or remove as refused. `touched`
 * asks the person's fresh sign-in before their two moves, as for an org.
 */
export function projectInvitationHandlers(
  run: Runner,
  touched: <A>(
    caller: Caller,
    move: () => A,
  ) => A | { readonly status: 403; readonly body: ProblemBody },
) {
  return {
    Projects_listAgents: (caller: Caller, _input: Input<"Projects_listAgents">) =>
      run(
        caller,
        Effect.gen(function* () {
          // An agent invited here reads who has joined, as anyone does: what waits and who asked is the person's to see.
          const audience =
            caller.principal._tag === "User" ? (caller.audience ?? "public") : "public";
          const rows = yield* ProjectAgents.use((agents) =>
            agents.inProject(projectIn(caller).projectId),
          );
          const directory = yield* AgentDirectory;
          const items = yield* Effect.forEach(
            rows.filter((row) => audience === "members" || row.state === "joined"),
            (row) =>
              directory
                .findAgent(row.agentId)
                .pipe(
                  Effect.map((agent) =>
                    namespaceAgent(row, Option.getOrUndefined(agent), audience),
                  ),
                ),
          );
          return { status: 200 as const, body: { items } } satisfies Projects_listAgentsResult;
        }),
      ),
    Projects_inviteAgent: (caller: Caller, input: Input<"Projects_inviteAgent">) =>
      touched(caller, () =>
        run(
          caller,
          Effect.gen(function* () {
            const asked = yield* invitationAsked(caller, input);
            if (Result.isFailure(asked)) return asked.failure satisfies Projects_inviteAgentResult;
            const { namespace, projectId } = projectIn(caller);
            return yield* Invitations.use((invitations) =>
              invitations.invite({
                namespace,
                projectId,
                ...asked.success,
                idempotencyKey: input["idempotency-key"],
              }),
            ).pipe(
              Effect.flatMap(withAgent),
              Effect.match({
                onSuccess: (body) => ({ status: 201 as const, body }),
                onFailure: (error) => inviteError(caller, error, "Projects_inviteAgent"),
              }),
            );
          }),
        ),
      ),
    Projects_removeAgent: (caller: Caller, input: Input<"Projects_removeAgent">) =>
      touched(caller, () =>
        run(
          caller,
          Option.match(decodeAgentId(input.agentId), {
            onNone: () => Effect.succeed<Projects_removeAgentResult>(notFound(caller)),
            onSome: (agentId) => {
              const { namespace, projectId } = projectIn(caller);
              return Invitations.use((invitations) =>
                invitations.end(endingActor(caller), {
                  namespace,
                  projectId,
                  agentId,
                  idempotencyKey: input["idempotency-key"],
                }),
              ).pipe(
                Effect.flatMap(withAgent),
                Effect.match({
                  onSuccess: (body): Projects_removeAgentResult => ({ status: 200, body }),
                  onFailure: (error) => moveError(caller, error, "Projects_removeAgent"),
                }),
              );
            },
          }),
        ),
      ),
    Agents_listProjects: (caller: Caller) =>
      asAgent(caller, (agentId) =>
        run(
          caller,
          Effect.gen(function* () {
            const rows = yield* ProjectAgents.use((agents) => agents.ofAgent(agentId));
            // A project that has no place any more is in no list.
            const found = yield* Effect.forEach(rows, (row) =>
              row.projectId === undefined
                ? Effect.succeed(Option.none())
                : projectGiven(row.projectId).pipe(
                    Effect.map(
                      Option.map(({ place, namespace }) => agentProject(row, place, namespace)),
                    ),
                  ),
            );
            return {
              status: 200 as const,
              body: { items: found.flatMap((item) => Option.toArray(item)) },
            } satisfies Agents_listProjectsResult;
          }),
        ),
      ),
    Agents_listReachableProjects: (caller: Caller) =>
      asAgent(caller, (agentId) =>
        run(
          caller,
          Effect.map(
            reachableProjects(agentId),
            (items) =>
              ({
                status: 200 as const,
                body: { items },
              }) satisfies Agents_listReachableProjectsResult,
          ),
        ),
      ),
    // A run's choice is checked against the same reading as the list, and the gate checks it again on every request.
    Agents_useProject: (caller: Caller, input: Input<"Agents_useProject">) =>
      asAgent(caller, (agentId) => {
        const ofRun = caller.token?.run;
        if (ofRun === undefined) return runRequired(caller);
        return run(
          caller,
          Effect.gen(function* () {
            const reached = (yield* reachableProjects(agentId)).find(
              (item) => item.project.id === input.projectId,
            );
            if (reached === undefined)
              return notFound(
                caller,
                "You cannot work in that project now: `Agents_listReachableProjects` lists the ones you can.",
              );
            const at = yield* Clock.use((clock) => clock.now);
            yield* AgentDirectory.use((directory) =>
              directory.chooseProject(agentId, ofRun.id, reached.project.id, at),
            );
            const { project } = reached;
            return {
              status: 200 as const,
              body: {
                ok: true,
                summary: `Run ${ofRun.label ?? ofRun.id} works in ${project.namespace}/${project.name} from now on: each token it asks for without a project is for it. A token that names none is refused once (401) so your client asks for one that does.`,
                result: { project, run: runView(ofRun) },
                findings: [],
                next: [
                  {
                    kind: "call" as const,
                    title: `Declare the change you will make in ${project.namespace}/${project.name}`,
                    operationId: "declare",
                  },
                ],
                notices: [],
                cost: {},
              },
            } satisfies Agents_useProjectResult;
          }),
        );
      }),
    Agents_acceptProjectInvitation: (
      caller: Caller,
      input: Input<"Agents_acceptProjectInvitation">,
    ) =>
      asAgent(caller, (agentId) =>
        run(
          caller,
          projectGiven(input.projectId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.succeed<Agents_acceptProjectInvitationResult>(notFound(caller)),
                onSome: ({ place, namespace }) =>
                  Invitations.use((invitations) =>
                    invitations.accept({
                      namespace: place.namespace,
                      projectId: place.projectId,
                      agentId,
                      run: caller.token?.run,
                      idempotencyKey: input["idempotency-key"],
                    }),
                  ).pipe(
                    Effect.match({
                      onSuccess: (invitation): Agents_acceptProjectInvitationResult => ({
                        status: 200,
                        body: agentProject(invitation, place, namespace),
                      }),
                      onFailure: (error) =>
                        moveError(caller, error, "Agents_acceptProjectInvitation"),
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
    Agents_leaveProject: (caller: Caller, input: Input<"Agents_leaveProject">) =>
      asAgent(caller, (agentId) =>
        run(
          caller,
          projectGiven(input.projectId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed<Agents_leaveProjectResult>(notFound(caller)),
                onSome: ({ place, namespace }) =>
                  Invitations.use((invitations) =>
                    invitations.end(endingActor(caller), {
                      namespace: place.namespace,
                      projectId: place.projectId,
                      agentId,
                      run: caller.token?.run,
                      idempotencyKey: input["idempotency-key"],
                    }),
                  ).pipe(
                    Effect.match({
                      onSuccess: (invitation): Agents_leaveProjectResult => ({
                        status: 200,
                        body: agentProject(invitation, place, namespace),
                      }),
                      onFailure: (error) => moveError(caller, error, "Agents_leaveProject"),
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
  };
}
