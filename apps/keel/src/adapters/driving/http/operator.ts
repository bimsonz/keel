import type { ProjectRef } from "@keeltown/core/application/coordination";
import type { EnrolAgentInput } from "@keeltown/core/application/identity";
import { PROJECT_TEMPLATES, type RefusedSource } from "@keeltown/core/application/integration";
import type {
  Enrolment,
  ImportRefused,
  ProjectRecord,
  ProjectSettings,
  ProjectStartRefused,
  PutProjectSettings,
  StandingInput,
} from "@keeltown/core/ports";
import type {
  Agent,
  AgentNotKnown,
  AgentStateRefused,
  IdempotencyConflict,
  ProjectNameTaken,
} from "@keeltown/core/domain/identity";
import type { ProjectNotFound } from "@keeltown/core/domain/integration";
import { AgentId, Glob, ProjectId } from "@keeltown/core/kernel";
import { Result, Schema } from "effect";
import type {
  Operator_createProjectResult,
  Operator_enrolAgentResult,
  Operator_getSettingsResult,
  Operator_putSettingsResult,
  Operator_reinstateAgentResult,
  Operator_revokeAgentResult,
  Operator_suspendAgentResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { agentProfile } from "./mappers.ts";
import { problem, type ProblemBody } from "./problems.ts";
import type { Input } from "./work-loop.ts";

/**
 * Pure mappers for the operator's bootstrap operations: creating a project and
 * enrolling an agent. Each error union is mapped exhaustively.
 */

type Issues = NonNullable<ProblemBody["issues"]>;

const iso = (ms: number) => new Date(ms).toISOString();

const decodeProjectId = Schema.decodeUnknownOption(ProjectId);
const decodeGlobs = Schema.decodeUnknownOption(Schema.Array(Glob));

export function enrolInput(
  input: Input<"Operator_enrolAgent">,
): Result.Result<EnrolAgentInput, Issues> {
  const projectId = decodeProjectId(input.projectId);
  return projectId._tag === "Some"
    ? Result.succeed({
        name: input.name,
        kind: input.kind,
        scopes: [...input.scopes],
        projectId: projectId.value,
        idempotencyKey: input["idempotency-key"],
      })
    : Result.fail([
        { path: ["body", "projectId"], message: "Name the project the agent works in (prj_…)" },
      ]);
}

/** The project a settings operation names in its path. */
export function settingsProject(projectId: string): Result.Result<ProjectId, Issues> {
  const decoded = decodeProjectId(projectId);
  return decoded._tag === "Some"
    ? Result.succeed(decoded.value)
    : Result.fail([{ path: ["path", "projectId"], message: "Expected a project id (prj_…)" }]);
}

/** A PUT's settings: the project's protected globs, its batch size, and `verification` and `visibility` only when given. */
export function putSettingsInput(
  input: Input<"Operator_putSettings">,
): Result.Result<{ readonly projectId: ProjectId; readonly settings: PutProjectSettings }, Issues> {
  const projectId = settingsProject(input.projectId);
  if (Result.isFailure(projectId)) return Result.fail(projectId.failure);
  const protectedPaths = decodeGlobs(input.protectedPaths);
  if (protectedPaths._tag === "None")
    return Result.fail([{ path: ["body", "protectedPaths"], message: "Expected non-empty globs" }]);
  return Result.succeed({
    projectId: projectId.success,
    settings: {
      protectedPaths: protectedPaths.value,
      maxBatchSize: input.maxBatchSize,
      ...(input.verification === undefined ? {} : { verification: input.verification }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    },
  });
}

/** The project's settings, `verification` and `visibility` always present. GET and PUT answer the same body. */
export function settingsOk(
  settings: ProjectSettings,
): Extract<Operator_getSettingsResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      protectedPaths: [...settings.protectedPaths],
      maxBatchSize: settings.maxBatchSize,
      verification: settings.verification,
      visibility: settings.visibility,
    },
  };
}

export function settingsError(
  caller: Caller,
  error: ProjectNotFound,
): Extract<Operator_getSettingsResult, { readonly status: 404 }> {
  return {
    status: 404,
    body: problem(404, "resource.not_found", caller.requestId, {
      detail: `No project ${error.projectId}.`,
      nextActions: [
        { kind: "call", title: "Create the project first", operationId: "Operator_createProject" },
      ],
    }),
  };
}

/** A PUT's refusals: the project does not exist, or its request id already carried other settings. */
export function putSettingsError(
  caller: Caller,
  error: ProjectNotFound | IdempotencyConflict,
): Operator_putSettingsResult {
  switch (error._tag) {
    case "ProjectNotFound":
      return settingsError(caller, error);
    case "IdempotencyConflict":
      return {
        status: 409,
        body: problem(409, "request.idempotency_conflict", caller.requestId, {
          detail: `Request id ${error.idempotencyKey} already carried other settings.`,
          nextActions: [
            {
              kind: "call",
              title: "Send the settings again under a fresh X-Request-Id",
              operationId: "Operator_putSettings",
            },
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/**
 * A new project as its creator reads it: private until its settings say
 * otherwise, in the namespace named, and a fork with the project it was
 * taken from where its creator may read that one.
 */
export function createProjectOk(
  project: ProjectRecord,
  namespace: { readonly handle: string; readonly kind: "user" | "agent" | "org" },
  role: "owner" | "maintainer" | "member" | undefined,
  forkedFrom?: ProjectRef,
): Operator_createProjectResult {
  return {
    status: 201,
    body: {
      id: project.id,
      namespace,
      name: project.name,
      visibility: "private",
      createdAt: iso(project.createdAt),
      ...(role === undefined ? {} : { viewer: { role } }),
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
    },
  };
}

const conflict = (
  caller: Caller,
  error: IdempotencyConflict,
  operationId: string,
  what: string,
) => ({
  status: 409 as const,
  body: problem(409, "request.idempotency_conflict", caller.requestId, {
    detail: `Idempotency-Key ${error.idempotencyKey} was used for a different ${what}.`,
    nextActions: [{ kind: "call", title: "Call again with a fresh Idempotency-Key", operationId }],
  }),
});

/** What to do about an import the code host took nothing from, by its reason. */
const IMPORT_REFUSALS: Record<
  ImportRefused["reason"],
  { readonly status: 403 | 404 | 503; readonly detail: string; readonly next: string }
> = {
  "not-found": {
    status: 404,
    detail: "No public repository answers at that URL. A private one reads the same.",
    next: "Check the URL names a public repository, then create the project again",
  },
  "not-git": {
    status: 404,
    detail: "What answers at that URL is not a Git repository.",
    next: "Give the repository's own clone URL, then create the project again",
  },
  "no-branch": {
    status: 404,
    detail: "The repository lacks the branch named, or holds no branch at all.",
    next: "Name a branch the repository holds, or leave `ref` out to take its default",
  },
  unreachable: {
    status: 503,
    detail: "The repository's host did not answer.",
    next: "Create the project again shortly, with the same Idempotency-Key",
  },
  "too-large": {
    status: 403,
    detail: "The repository is larger than the code host imports.",
    next: "Import a smaller repository, or one branch of it with `ref`",
  },
};

const again = (title: string) => ({
  kind: "call" as const,
  title,
  operationId: "Operator_createProject",
});

export function createProjectError(
  caller: Caller,
  namespace: string,
  error: IdempotencyConflict | ProjectNameTaken | ProjectStartRefused,
): Operator_createProjectResult {
  switch (error._tag) {
    case "IdempotencyConflict":
      return conflict(caller, error, "Operator_createProject", "project");
    case "ProjectNameTaken":
      return {
        status: 409,
        body: problem(409, "project.name_taken", caller.requestId, {
          detail: `${namespace} already has a project named "${error.name}", in some case.`,
          nextActions: [again("Choose another name")],
        }),
      };
    case "RepoNotFound":
      return {
        status: 404,
        body: problem(404, "resource.not_found", caller.requestId, {
          detail: `No source repo ${error.repo.name} in namespace ${error.repo.namespace}.`,
          nextActions: [
            again(
              `Create or push the source repo ${error.repo.name}, then create the project again`,
            ),
          ],
        }),
      };
    case "ImportRefused": {
      const { status, detail, next } = IMPORT_REFUSALS[error.reason];
      return {
        status,
        body: problem(status, "project.import_refused", caller.requestId, {
          detail: `${detail} Nothing was imported, and no project was made (${error.reason}).`,
          nextActions: [
            error.reason === "unreachable" ? { kind: "wait" as const, title: next } : again(next),
          ],
          ...(error.reason === "unreachable" ? { retryAfterMs: 5_000 } : {}),
        }),
      };
    }
    case "ImportTooLarge":
      return {
        status: 403,
        body: problem(403, "project.import_too_large", caller.requestId, {
          detail: `The repository's history is ${error.bytes} bytes, and Keel imports at most ${error.limit} in one piece. Nothing was kept, and no project was made.`,
          nextActions: [again("Import a smaller repository, or one branch of it with `ref`")],
        }),
      };
    case "QuotaExceeded":
      return {
        status: 403,
        body: problem(403, "quota.exceeded", caller.requestId, {
          detail: `The repository's history is ${error.requested} bytes, and the namespace has ${Math.max(0, error.limit - error.used)} of its ${error.limit} left (${error.kind}). Nothing was kept, and no project was made.`,
          nextActions: [
            ...error.nextActions.map(({ kind, title, operationId, args }) => ({
              kind,
              title,
              ...(operationId === undefined ? {} : { operationId }),
              ...(args === undefined ? {} : { args }),
            })),
            again("Import a smaller repository, or create the project in a namespace with room"),
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/**
 * A template's name that is not one, or a fork of something that is no
 * project. Nothing in the core namespace is looked up by it, so it reads the
 * same whatever repo is there. Each template is offered, with the namespace
 * and the name the caller asked for.
 */
export function sourceNotFound(
  caller: Caller,
  input: Input<"Operator_createProject">,
): Extract<Operator_createProjectResult, { readonly status: 404 }> {
  const named = input.source.kind === "template" ? input.source.name : "";
  return {
    status: 404,
    body: problem(404, "resource.not_found", caller.requestId, {
      detail: `No template has the name "${named}".`,
      nextActions: Array.from(PROJECT_TEMPLATES, (template) => ({
        kind: "call" as const,
        title: `Create the project from the template ${template}`,
        operationId: "Operator_createProject",
        args: {
          namespace: input.namespace,
          name: input.name,
          source: { kind: "template", name: template },
        },
      })),
    }),
  };
}

/** Why Keel imports from no URL like the one given, said for the person who typed it. */
const URL_REFUSALS: Record<RefusedSource["why"], string> = {
  "too-long": "is longer than 2,048 characters",
  "not-https": "must begin with https://",
  credential: "must not hold a user name or a password: the URL is recorded for every reader",
  query: "must not hold a query",
  fragment: "must not hold a fragment",
  port: "must not name a port",
  "ip-literal": "must name its host, not give an address",
  host: "must name a host of dotted labels",
  path: "must hold a path of plain segments, with no escapes and no trailing slash",
  "not-a-branch": "must be a branch's short name, such as main or release/1.x",
};

/** An import whose URL or branch Keel takes none like: the field to fix, and what is wrong with it. */
export function sourceRefused(
  caller: Caller,
  refused: RefusedSource,
): Extract<Operator_createProjectResult, { readonly status: 400 }> {
  return {
    status: 400,
    body: problem(400, "request.invalid", caller.requestId, {
      detail: `The import's ${refused.field} ${URL_REFUSALS[refused.why]} (${refused.why}).`,
      issues: [{ path: ["body", "source", refused.field], message: URL_REFUSALS[refused.why] }],
      nextActions: [again(`Correct the import's ${refused.field}, then create the project again`)],
    }),
  };
}

export function enrolAgentOk(enrolment: Enrolment): Operator_enrolAgentResult {
  return {
    status: 201,
    body: {
      agent: agentProfile(enrolment.agent),
      clientId: enrolment.clientId,
      clientSecret: enrolment.clientSecret,
    },
  };
}

export function enrolAgentError(
  caller: Caller,
  error: IdempotencyConflict | ProjectNotFound,
): Operator_enrolAgentResult {
  switch (error._tag) {
    case "IdempotencyConflict":
      return conflict(caller, error, "Operator_enrolAgent", "enrolment");
    case "ProjectNotFound":
      return {
        status: 404,
        body: problem(404, "resource.not_found", caller.requestId, {
          detail: `No project ${error.projectId} in an org.`,
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/** The operator's moves on an agent's standing, by operationId. */
export type StandingOperation =
  | "Operator_suspendAgent"
  | "Operator_reinstateAgent"
  | "Operator_revokeAgent";
type StandingResult =
  | Operator_suspendAgentResult
  | Operator_reinstateAgentResult
  | Operator_revokeAgentResult;

const decodeAgentId = Schema.decodeUnknownResult(AgentId);

export function standingInput(input: {
  readonly agentId: string;
  readonly "idempotency-key": string;
  readonly reason?: string;
}): Result.Result<StandingInput, Issues> {
  const agentId = decodeAgentId(input.agentId);
  if (Result.isFailure(agentId))
    return Result.fail([{ path: ["agentId"], message: "Expected an agent id (agt_…)" }]);
  return Result.succeed({
    agentId: agentId.success,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    idempotencyKey: input["idempotency-key"],
  });
}

export function standingOk(agent: Agent): StandingResult {
  return { status: 200, body: agentProfile(agent) };
}

export function standingError(
  caller: Caller,
  operation: StandingOperation,
  error: AgentNotKnown | AgentStateRefused | IdempotencyConflict,
): StandingResult {
  switch (error._tag) {
    case "AgentNotKnown":
      return {
        status: 404,
        body: problem(404, "resource.not_found", caller.requestId, {
          detail: `No agent ${error.agentId}.`,
        }),
      };
    case "AgentStateRefused":
      return {
        status: 409,
        body: problem(409, "agent.state_refused", caller.requestId, {
          detail: `${error.agentId} is ${error.state ?? "not enrolled"}, where ${error.command} is not allowed.`,
          nextActions:
            error.state === "suspended"
              ? [
                  {
                    kind: "call",
                    title: "Reinstate the agent first",
                    operationId: "Operator_reinstateAgent",
                    args: { agentId: error.agentId },
                  },
                ]
              : [],
        }),
      };
    case "IdempotencyConflict":
      return conflict(caller, error, operation, "move on this agent");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}
