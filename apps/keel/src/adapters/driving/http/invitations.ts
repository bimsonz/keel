import {
  type Actor,
  type Agent,
  type Audience,
  type IdempotencyConflict,
  INVITED_SCOPES,
  type Invitation,
  type InvitationRefused,
  InvitationScopes,
} from "@keeltown/core/domain/identity";
import { AgentId, NamespaceId } from "@keeltown/core/kernel";
import {
  AgentDirectory,
  Invitations,
  NamespaceAgents,
  type NamespaceRecord,
  Namespaces,
} from "@keeltown/core/ports";
import { Effect, Option, Schema } from "effect";
import type {
  Agents_acceptInvitationResult,
  Agents_leaveNamespaceResult,
  Agents_listNamespacesResult,
  Namespaces_inviteAgentResult,
  Namespaces_listAgentsResult,
  Namespaces_removeAgentResult,
  Operations,
} from "../../../generated/http/app.gen.ts";
import { agentsOnly } from "./authorize-handlers.ts";
import type { Caller } from "./caller.ts";
import { problem, type ProblemBody } from "./problems.ts";
import type { Runner } from "./run.ts";

/**
 * The invitation of an agent into an org: a member's invitation and removal,
 * the list anyone reads, and the agent's own list, acceptance and leaving.
 * Mappers are pure and each error union is mapped exhaustively; the handlers
 * call the ports and nothing else.
 */

type Input<A extends keyof Operations<Caller>> = Parameters<Operations<Caller>[A]>[1];

const iso = (ms: number) => new Date(ms).toISOString();

const decodeAgentId = Schema.decodeUnknownOption(AgentId);
const decodeNamespaceId = Schema.decodeUnknownOption(NamespaceId);
const decodeScopes = Schema.decodeUnknownOption(InvitationScopes);

type NamespaceAgentBody = Extract<Namespaces_removeAgentResult, { readonly status: 200 }>["body"];
type AgentNamespaceBody = Extract<Agents_leaveNamespaceResult, { readonly status: 200 }>["body"];

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

const notFound = (caller: Caller, detail?: string) => ({
  status: 404 as const,
  body: problem(
    404,
    "resource.not_found",
    caller.requestId,
    detail === undefined ? {} : { detail },
  ),
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
 * The refusals of a move on an agent's place in a namespace as it stands: 409,
 * saying what is in the way. It names no person: a member reads who invited
 * the agent from the org's list.
 */
function stateRefused(
  caller: Caller,
  error: InvitationRefused,
): { readonly status: 409; readonly body: ProblemBody } {
  switch (error.reason) {
    case "already-invited":
      return {
        status: 409,
        body: problem(409, "invitation.state_refused", caller.requestId, {
          detail: `${error.agentId} already has an invitation here, and one member answers for an agent in an org. Take it out first to invite it again or to change what it may do.`,
          nextActions: [
            {
              kind: "read",
              title: "Read the org's agents and who invited each",
              operationId: "Namespaces_listAgents",
            },
          ],
        }),
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
    default: {
      const unmapped: never = error.reason;
      return unmapped;
    }
  }
}

export function inviteError(
  caller: Caller,
  error: InvitationRefused | IdempotencyConflict,
): Namespaces_inviteAgentResult {
  switch (error._tag) {
    case "InvitationRefused":
      return stateRefused(caller, error);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, "Namespaces_inviteAgent");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/**
 * The refusals of an end, or of the agent's own answer: with no invitation
 * there the agent, or the namespace, is not found, whoever asks, so a
 * namespace that never invited an agent and one that does not exist read the
 * same to it.
 */
function moveError(
  caller: Caller,
  error: InvitationRefused | IdempotencyConflict,
  operationId: string,
): Namespaces_removeAgentResult & Agents_acceptInvitationResult & Agents_leaveNamespaceResult {
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

/** An agent's own operation: asked by anyone else it is refused as every agents' operation is. */
const asAgent = <A>(caller: Caller, move: (agentId: AgentId) => A) =>
  caller.principal._tag === "Agent" ? move(caller.principal.agentId) : agentsOnly(caller.requestId);

/**
 * The six operations of an agent's invitation into an org. `touched` asks a
 * person's fresh sign-in before a move: the invitation and the removal are a
 * signed-in page's to make. The agent's own answer needs none: it has no
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
            const { principal } = caller;
            if (principal._tag !== "User")
              return yield* Effect.die(new Error("an invitation ran without a user"));
            const scopes = decodeScopes(input.scopes ?? INVITED_SCOPES);
            if (Option.isNone(scopes))
              return {
                status: 400 as const,
                body: problem(400, "request.invalid", caller.requestId, {
                  detail:
                    "An invitation gives agent:read, or agent:read and agent:work, each named once.",
                }),
              } satisfies Namespaces_inviteAgentResult;
            // An agent's handle is its own namespace's, and that namespace's id is the agent's.
            const named = yield* Namespaces.use((namespaces) => namespaces.byHandle(input.agent));
            const agentId = Option.flatMap(named, (found) =>
              found.kind === "agent" ? decodeAgentId(found.namespace) : Option.none(),
            );
            if (Option.isNone(agentId))
              return notFound(caller, `No agent has the handle ${input.agent}.`);
            return yield* Invitations.use((invitations) =>
              invitations.invite({
                namespace: namespaceOf(caller),
                agentId: agentId.value,
                by: principal.userId,
                scopes: scopes.value,
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
