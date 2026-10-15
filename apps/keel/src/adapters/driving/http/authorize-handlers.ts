import { readConnectState } from "@keeltown/core/domain/delivery";
import {
  type AgentResource,
  type AuthenticationRequired,
  type AuthorizationRefusal,
  authorize,
  type Decision,
  type MissingResource,
  type NamespaceResource,
  personOwns,
  type Principal,
  type ProjectResource,
  type Resource,
  type ResourceFor,
  SPEC_ACTIONS,
  type SpecAction,
} from "@keeltown/core/domain/identity";
import {
  AgentId,
  ChangeId,
  DecisionId,
  EscalationId,
  namespaceKind,
  ProjectId,
  type UserId,
  VerdictId,
} from "@keeltown/core/kernel";
import {
  AgentDirectory,
  Changes,
  Decisions,
  Escalations,
  NamespaceAgents,
  Namespaces,
  ProjectNamespaces,
  Projects,
  Verdicts,
} from "@keeltown/core/ports";
import { Effect, Option, Result, Schema } from "effect";
import type { Operations } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { decisionNotFound } from "./decisions.ts";
import { verdictNotFound } from "./verdicts.ts";
import { askedIn, nothingToExplain } from "./why.ts";
import { escalationNotFound } from "./escalations.ts";
import { problem, type ProblemBody } from "./problems.ts";
import type { Runner } from "./run.ts";
import { conflictNotFound, probeNotFound } from "./views.ts";
import { changeNotFound } from "./work-loop.ts";

/** The operations the spec publishes: each is an action the policy decides. */
type Operation = SpecAction & keyof Operations<Caller>;
type InputOf<A extends Operation> = Parameters<Operations<Caller>[A]>[1];

/**
 * An operation over many resources, each of which the policy decides on its
 * own (a list of projects, a feed across them): its handler calls `decideEach`
 * per item. The operation as a whole is anyone's to call.
 */
export interface PerItem {
  readonly _tag: "PerItem";
}
const PER_ITEM: PerItem = { _tag: "PerItem" };

type ResolverServices =
  | ProjectNamespaces
  | Namespaces
  | Projects
  | Changes
  | Decisions
  | Verdicts
  | AgentDirectory
  | Escalations
  | NamespaceAgents;

/** How an operation finds the resource it is decided on, from its input and its caller. */
export type Resolver<A extends Operation> = (
  input: InputOf<A>,
  caller: Caller,
) => Effect.Effect<ResourceFor<A> | PerItem, never, ResolverServices>;

/** One resolver per operation in the spec: a missing one does not compile. */
export type Resolvers = { readonly [A in Operation]: Resolver<A> };

const MISSING: MissingResource = { _tag: "Missing" };
const instance = () => Effect.succeed({ _tag: "Instance" } as const);
const self = () => Effect.succeed({ _tag: "Self" } as const);
const perItem = () => Effect.succeed(PER_ITEM);

/**
 * A project as the policy needs it: its namespace (from its place), whether
 * that namespace is suspended, and its visibility (from its settings). A
 * project with no place or no settings is missing.
 *
 * `personOwned` is read from the namespace's kind, here and in
 * `namespaceNamed`: a person's own and an org are people's, an agent's own is
 * the agent's. An org keeps its last owner, and only a signed-in person makes
 * one.
 */
export const projectResource = (
  projectId: ProjectId,
  sponsor?: UserId,
): Effect.Effect<
  ProjectResource | MissingResource,
  never,
  ProjectNamespaces | Namespaces | Projects
> =>
  Effect.gen(function* () {
    const place = yield* ProjectNamespaces.use((places) => places.byId(projectId));
    if (Option.isNone(place)) return MISSING;
    const { namespace } = place.value;
    const record = yield* Namespaces.use((namespaces) => namespaces.byId(namespace));
    const settings = yield* Projects.use((projects) => projects.settings(projectId)).pipe(
      Effect.option,
    );
    if (Option.isNone(settings)) return MISSING;
    return {
      _tag: "Project",
      namespace,
      projectId,
      visibility: settings.value.visibility,
      namespaceSuspended: Option.match(record, {
        onNone: () => false,
        onSome: (found) => found.suspended,
      }),
      personOwned: personOwns(namespaceKind(namespace)),
      ...(sponsor === undefined ? {} : { sponsor }),
    } satisfies ProjectResource;
  });

const decodeProjectId = Schema.decodeUnknownOption(ProjectId);
const decodeChangeId = Schema.decodeUnknownOption(ChangeId);
const decodeAgentId = Schema.decodeUnknownOption(AgentId);
const decodeEscalationId = Schema.decodeUnknownOption(EscalationId);
const decodeDecisionId = Schema.decodeUnknownOption(DecisionId);
const decodeVerdictId = Schema.decodeUnknownOption(VerdictId);

/** The project an id names, or missing when it names none. */
const projectNamed = (id: unknown) =>
  Option.match(decodeProjectId(id), {
    onNone: () => Effect.succeed(MISSING),
    onSome: (projectId) => projectResource(projectId),
  });

/**
 * The agent's own project: the one its token names, where work is ever done.
 * Anyone else, and an agent whose token names none, asks about nothing.
 */
const ownProject = (_input: unknown, caller: Caller) =>
  caller.principal._tag === "Agent" && caller.principal.projectId !== undefined
    ? projectResource(caller.principal.projectId)
    : Effect.succeed(MISSING);

/** The project named, or for an agent naming none, its own. */
const projectOrOwn = (id: unknown, caller: Caller) =>
  id === undefined ? ownProject(undefined, caller) : projectNamed(id);

/** The project a change belongs to, read from the change itself. */
const changeProject = (id: unknown) =>
  Option.match(decodeChangeId(id), {
    onNone: () => Effect.succeed(MISSING),
    onSome: (changeId) =>
      Changes.use((changes) => changes.get(changeId)).pipe(
        Effect.flatMap((read) => projectResource(read.projectId)),
        Effect.catchTag("ChangeNotFound", () => Effect.succeed(MISSING)),
      ),
  });

/** The project a decision was ruled in, read from Keel's memory. */
const decisionProject = (id: unknown) =>
  Option.match(decodeDecisionId(id), {
    onNone: () => Effect.succeed(MISSING),
    onSome: (decisionId) =>
      Decisions.use((decisions) => decisions.get(decisionId)).pipe(
        Effect.flatMap((read) => projectResource(read.project)),
        Effect.catchTag("DecisionNotFound", () => Effect.succeed(MISSING)),
      ),
  });

/** The project a verdict was issued in, from the Projector's verdict index: what a read of it is decided on. */
const verdictProject = (id: unknown) =>
  Option.match(decodeVerdictId(id), {
    onNone: () => Effect.succeed(MISSING),
    onSome: (verdictId) =>
      Verdicts.use((verdicts) => verdicts.get(verdictId)).pipe(
        Effect.flatMap((read) => projectResource(read.project)),
        Effect.catchTag("VerdictNotFound", () => Effect.succeed(MISSING)),
      ),
  });

/** The project an agent is enrolled in, with its sponsor: what a move on the agent is decided on. */
const agentProject = (id: unknown) =>
  Option.match(decodeAgentId(id), {
    onNone: () => Effect.succeed(MISSING),
    onSome: (agentId) =>
      AgentDirectory.use((directory) => directory.findAgent(agentId)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(MISSING),
            // A move on an agent is decided on the project a person enrolled it in; one that signed up by key has none.
            onSome: (agent) =>
              agent.projectId === undefined
                ? Effect.succeed(MISSING)
                : projectResource(agent.projectId, agent.sponsor),
          }),
        ),
      ),
  });

/**
 * An agent's own account, with the person who stands behind it: what a pause,
 * the end of its sponsor's link and a read of the agent are decided on. The
 * directory's row has the sponsor before a link move answers, so the next
 * request is decided on it.
 */
const agentAccount = (id: unknown) =>
  Option.match(decodeAgentId(id), {
    onNone: () => Effect.succeed(MISSING),
    onSome: (agentId) =>
      AgentDirectory.use((directory) => directory.findAgent(agentId)).pipe(
        Effect.map(
          Option.match({
            onNone: () => MISSING,
            onSome: (agent) =>
              ({
                _tag: "Agent",
                agentId: agent.id,
                ...(agent.sponsor === undefined ? {} : { sponsor: agent.sponsor }),
              }) satisfies AgentResource,
          }),
        ),
      ),
  });

/**
 * The project an escalation's question is about, with the user asked first:
 * what a ruling is decided on. An escalation the Projector has not heard
 * raised is missing.
 */
const escalationProject = (id: unknown) =>
  Option.match(decodeEscalationId(id), {
    onNone: () => Effect.succeed(MISSING),
    onSome: (escalationId) =>
      Escalations.use((escalations) => escalations.get(escalationId)).pipe(
        Effect.flatMap((record) => projectResource(record.project, record.sponsor)),
        Effect.catchTag("EscalationNotFound", () => Effect.succeed(MISSING)),
      ),
  });

/** A namespace by its handle, in any case: a person's own, an agent's own or an org. */
const namespaceNamed = (handle: string) =>
  Namespaces.use((namespaces) => namespaces.byHandle(handle)).pipe(
    Effect.map(
      Option.match({
        onNone: () => MISSING,
        onSome: (found) =>
          ({
            _tag: "Namespace",
            namespace: found.namespace,
            suspended: found.suspended,
            personOwned: personOwns(found.kind),
          }) as const,
      }),
    ),
  );

/**
 * A namespace by its handle, with the member who invited an agent into it:
 * what taking that agent out again is decided on. With no invitation standing
 * there it names no inviter, and only a maintainer is let through to be told so.
 */
const namespaceAgent = (handle: string, id: unknown) =>
  namespaceNamed(handle).pipe(
    Effect.flatMap((resource) => {
      const agentId = decodeAgentId(id);
      if (resource._tag !== "Namespace" || Option.isNone(agentId)) return Effect.succeed(resource);
      return NamespaceAgents.use((agents) => agents.find(agentId.value, resource.namespace)).pipe(
        Effect.map(
          Option.match({
            onNone: () => resource,
            onSome: (invitation) => ({ ...resource, inviter: invitation.by }),
          }),
        ),
      );
    }),
  );

/** A project by its namespace's handle and its own name, as `/<namespace>/<project>` names it. */
export const projectByName = (handle: string, name: string) =>
  Namespaces.use((namespaces) => namespaces.byHandle(handle)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (found) => ProjectNamespaces.use((places) => places.byName(found.namespace, name)),
      }),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(MISSING),
        onSome: (place) => projectResource(place.projectId),
      }),
    ),
  );

/**
 * What each operation is decided on. Work is only ever in the agent's own
 * project; reads of a change are decided on the change's project; a revocation
 * on the agent's project and sponsor; a pause, the end of a sponsor's link and a
 * read of an agent on the agent's own account; a ruling on the project its
 * escalation is about and the user asked first. A person's list of escalations
 * spans projects, so each item is decided on its own; an agent's is its own
 * project's. Operations not implemented yet that
 * name a resource by an id of their own resolve to the caller's own project
 * until their lane resolves the id.
 */
export const RESOLVERS: Resolvers = {
  Auth_exchangeToken: instance,
  Auth_registerClient: instance,
  SignIn_methods: instance,
  Lattices_listLattices: instance,
  whoami: self,
  inbox: self,
  askSponsor: self,
  Users_me: self,
  Agents_approveSponsor: self,
  Agents_listSponsored: self,
  Agents_endSponsorship: (input) => agentAccount(input.agentId),
  Agents_getAgent: (input) => agentAccount(input.agentId),
  Agents_listNamespaces: self,
  Agents_acceptInvitation: self,
  Agents_leaveNamespace: self,
  Agents_listProjects: self,
  Agents_listReachableProjects: self,
  Agents_acceptProjectInvitation: self,
  Agents_leaveProject: self,

  Operator_listProjects: perItem,
  Operator_createProject: (input) => namespaceNamed(input.namespace),
  Namespaces_getNamespace: (input) => namespaceNamed(input.handle),
  Namespaces_getProject: (input) => projectByName(input.handle, input.name),
  Namespaces_listAgents: (input) => namespaceNamed(input.handle),
  Namespaces_inviteAgent: (input) => namespaceNamed(input.handle),
  Namespaces_removeAgent: (input) => namespaceAgent(input.handle, input.agentId),
  Projects_listAgents: (input) => projectNamed(input.projectId),
  Projects_inviteAgent: (input) => projectNamed(input.projectId),
  Projects_removeAgent: (input) => projectNamed(input.projectId),
  Delivery_createCredential: (input) => namespaceNamed(input.handle),
  Delivery_listCredentials: (input) => namespaceNamed(input.handle),
  Delivery_deleteCredential: (input) => namespaceNamed(input.handle),
  Delivery_putDeployTarget: (input) => projectNamed(input.projectId),
  Delivery_listDeployTargets: (input) => projectNamed(input.projectId),
  Delivery_deleteDeployTarget: (input) => projectNamed(input.projectId),
  Delivery_beginCloudflareConnect: (input) => projectNamed(input.projectId),
  // The project a Connect's state names: anything else names none, and is refused as a missing one.
  Delivery_completeCloudflareConnect: (input) =>
    projectNamed(
      Option.getOrUndefined(Option.map(readConnectState(input.state), (state) => state.projectId)),
    ),

  Changes_listChanges: (input, caller) => projectOrOwn(input.project, caller),
  change: (input) => changeProject(input.changeId),
  diff: (input) => changeProject(input.changeId),
  status: (input) => changeProject(input.changeId),
  nearby: (input) => changeProject(input.changeId),
  abandon: (input) => changeProject(input.changeId),
  Inbox_listEvents: (input, caller) =>
    input.project !== undefined || caller.principal._tag === "Agent"
      ? projectOrOwn(input.project, caller)
      : perItem(),
  Inbox_getSnapshot: (input, caller) => projectOrOwn(input.project, caller),
  Repo_getTree: (input) => projectNamed(input.projectId),
  Repo_getBlob: (input) => projectNamed(input.projectId),
  Repo_listCommits: (input) => projectNamed(input.projectId),
  Repo_getCommit: (input) => projectNamed(input.projectId),
  Repo_compare: (input) => projectNamed(input.projectId),
  Views_getTrunk: (input) => projectNamed(input.projectId),
  Views_listLanes: (input) => projectNamed(input.projectId),
  Views_getVerdict: (input) => verdictProject(input.verdictId),
  Conflicts_listConflicts: (input, caller) => projectOrOwn(input.project, caller),
  Conflicts_getConflict: (input, caller) => projectOrOwn(input.project, caller),
  Probes_getProbeSource: (input, caller) => projectOrOwn(input.project, caller),
  Memory_listDecisions: (input, caller) => projectOrOwn(input.project, caller),
  Memory_getDecision: (input) => decisionProject(input.decisionId),
  why: (input, caller) => projectOrOwn(input.project, caller),

  Operator_getSettings: (input) => projectNamed(input.projectId),
  Operator_putSettings: (input) => projectNamed(input.projectId),
  Operator_syncUpstream: (input) => projectNamed(input.projectId),
  Operator_listEscalations: (_input, caller) =>
    caller.principal._tag === "User" ? perItem() : ownProject(undefined, caller),
  Operator_giveRuling: (input) => escalationProject(input.escalationId),
  Operator_enrolAgent: (input) => projectNamed(input.projectId),
  Operator_suspendAgent: (input) => agentAccount(input.agentId),
  Operator_reinstateAgent: (input) => agentAccount(input.agentId),
  Operator_revokeAgent: (input) => agentProject(input.agentId),

  declare: ownProject,
  adopt: ownProject,
  rely: ownProject,
  rebase: ownProject,
  commit: ownProject,
  revise: ownProject,
  submit: ownProject,
  resolve: ownProject,
  Sessions_openSession: ownProject,
  refreshWorkspaceToken: ownProject,
};

/** The policy's next actions as a problem carries them: absent fields left out rather than undefined. */
const actions = (next: AuthenticationRequired["nextActions"]) =>
  next.map((action) => ({
    kind: action.kind,
    title: action.title,
    ...(action.operationId === undefined ? {} : { operationId: action.operationId }),
    ...(action.args === undefined ? {} : { args: action.args }),
  }));

/** The operations keyed by a change: what the caller cannot see reads as that change not found. */
const CHANGE_KEYED: ReadonlySet<string> = new Set([
  "change",
  "diff",
  "status",
  "nearby",
  "abandon",
]);

/** A refusal as the operation answers it. NotVisible reads exactly as the operation's own not-found. */
export function refusalResult(
  action: string,
  input: unknown,
  requestId: string,
  refusal: AuthorizationRefusal,
): { readonly status: 401 | 403 | 404; readonly body: ProblemBody } {
  // A project `why` may not read, named or the agent's own, has nothing to explain there.
  if (refusal._tag === "NotVisible" && action === "why")
    return nothingToExplain({ requestId }, askedIn(input));
  switch (refusal._tag) {
    case "AuthenticationRequired":
      return {
        status: 401,
        body: problem(401, "auth.required", requestId, {
          nextActions: actions(refusal.nextActions),
        }),
      };
    case "AccessRefused":
      return {
        status: 403,
        body: problem(403, "auth.forbidden", requestId, {
          detail: `Refused: ${refusal.reason}.`,
          nextActions: actions(refusal.nextActions),
        }),
      };
    case "NotVisible":
      if (CHANGE_KEYED.has(action))
        return changeNotFound({ requestId }, { changeId: String(Object(input).changeId) });
      if (action === "Conflicts_getConflict")
        return conflictNotFound({ requestId }, { conflictId: String(Object(input).conflictId) });
      if (action === "Memory_getDecision")
        return decisionNotFound({ requestId }, String(Object(input).decisionId));
      if (action === "Views_getVerdict")
        return verdictNotFound({ requestId }, String(Object(input).verdictId));
      if (action === "Probes_getProbeSource")
        return probeNotFound({ requestId }, { probeId: String(Object(input).probeId) });
      if (action === "Operator_giveRuling")
        return escalationNotFound(
          { requestId },
          { escalationId: String(Object(input).escalationId) },
        );
      return { status: 404, body: problem(404, "resource.not_found", requestId) };
    default: {
      const unmapped: never = refusal;
      return unmapped;
    }
  }
}

/**
 * An operation about an agent's own record (its identity, its inbox) asked by a
 * user: the policy grants it to anyone on their own record, and a user has none
 * of an agent's. It points to the user's own.
 */
export function agentsOnly(requestId: string): {
  readonly status: 403;
  readonly body: ProblemBody;
} {
  return {
    status: 403,
    body: problem(403, "auth.forbidden", requestId, {
      detail: "Refused: agents-only. This reads an agent's own record.",
      nextActions: [{ kind: "call", title: "Read who you are as a user", operationId: "Users_me" }],
    }),
  };
}

/** The policy's decision for one item of a per-item operation, under that item's own read rule. */
export const decideEach = (
  principal: Principal,
  resource: ProjectResource | MissingResource,
): Decision => authorize(principal, "Namespaces_getProject", resource);

/**
 * The policy's decision on forking `source` into a new project of `target`,
 * for the one operation that names a second resource in its body: the caller
 * must read the source and be a member of the target, and a private project
 * forks only into its own org.
 */
export const decideFork = (
  principal: Principal,
  source: ProjectResource | MissingResource,
  target: NamespaceResource,
): Decision => authorize(principal, "Operator_forkProject", { _tag: "Fork", source, target });

/**
 * The one authorization policy, in front of every operation: each operation's
 * resource is resolved, `authorize` decides,
 * and only a granted call reaches its handler, with the audience a read was
 * granted. No handler holds a check of its own. REST and MCP dispatch into the
 * same wrapped object.
 */
/* oxlint-disable typescript/no-unsafe-type-assertion -- the wrapper dispatches by operation name over
   tables whose entries are typed where they are declared (Operations, Resolvers): here each is one
   function of the same shape, and ResourceFor<action> is what that action's resolver answers. */
export function authorizeHandlers<H extends Operations<Caller>>(
  handlers: H,
  resolvers: Resolvers,
  run: Runner,
): H {
  const wrapped: Record<string, unknown> = { ...(handlers as unknown as Record<string, unknown>) };
  for (const action of Object.keys(SPEC_ACTIONS) as Operation[]) {
    const handler = handlers[action] as (caller: Caller, input: unknown) => unknown;
    const resolve = resolvers[action] as (
      input: unknown,
      caller: Caller,
    ) => Effect.Effect<Resource | PerItem, never, ResolverServices>;
    wrapped[action] = async (caller: Caller, input: unknown) => {
      const resolved = await run(caller, resolve(input, caller));
      if ("status" in resolved) return resolved;
      if (resolved._tag === "PerItem") return handler(caller, input);
      const decided = authorize(caller.principal, action, resolved as ResourceFor<typeof action>);
      if (Result.isFailure(decided))
        return refusalResult(action, input, caller.requestId, decided.failure);
      const { audience } = decided.success;
      return handler(
        { ...caller, resource: resolved, ...(audience === undefined ? {} : { audience }) },
        input,
      );
    };
  }
  return wrapped as unknown as H;
}
/* oxlint-enable typescript/no-unsafe-type-assertion */
