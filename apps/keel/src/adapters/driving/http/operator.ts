import type {
  Enrolment,
  EnrolInput,
  ProjectRecord,
  ProjectSettings,
  PutProjectSettings,
  RepoNotFound,
} from "@keeltown/core/ports";
import type { IdempotencyConflict } from "@keeltown/core/domain/identity";
import type { ProjectNotFound } from "@keeltown/core/domain/integration";
import { Glob, ProjectId } from "@keeltown/core/kernel";
import { Result, Schema } from "effect";
import type {
  Operator_createProjectResult,
  Operator_enrolAgentResult,
  Operator_getSettingsResult,
  Operator_putSettingsResult,
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

export function enrolInput(input: Input<"Operator_enrolAgent">): Result.Result<EnrolInput, Issues> {
  const base = {
    name: input.name,
    kind: input.kind,
    scopes: [...input.scopes],
    ...(input.onBehalfOf === undefined ? {} : { onBehalfOf: input.onBehalfOf }),
    idempotencyKey: input["idempotency-key"],
  };
  if (input.projectId === undefined) return Result.succeed(base);
  const projectId = decodeProjectId(input.projectId);
  return projectId._tag === "Some"
    ? Result.succeed({ ...base, projectId: projectId.value })
    : Result.fail([{ path: ["body", "projectId"], message: "Expected a project id (prj_…)" }]);
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

export function createProjectOk(project: ProjectRecord): Operator_createProjectResult {
  return {
    status: 201,
    body: { id: project.id, name: project.name, createdAt: iso(project.createdAt) },
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

export function createProjectError(
  caller: Caller,
  error: IdempotencyConflict | RepoNotFound,
): Operator_createProjectResult {
  switch (error._tag) {
    case "IdempotencyConflict":
      return conflict(caller, error, "Operator_createProject", "project");
    case "RepoNotFound":
      return {
        status: 404,
        body: problem(404, "resource.not_found", caller.requestId, {
          detail: `No source repo ${error.repo.name} in namespace ${error.repo.namespace}.`,
          nextActions: [
            {
              kind: "call",
              title: `Create or push the source repo ${error.repo.name}, then create the project again`,
              operationId: "Operator_createProject",
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
  error: IdempotencyConflict,
): Operator_enrolAgentResult {
  switch (error._tag) {
    case "IdempotencyConflict":
      return conflict(caller, error, "Operator_enrolAgent", "enrolment");
    default: {
      const unmapped: never = error._tag;
      return unmapped;
    }
  }
}

/**
 * The 403 for the bootstrap credential anywhere but enrolment: it exists only
 * to enrol the first operator, who does everything else.
 */
export function bootstrapConfined(requestId: string): {
  readonly status: 403;
  readonly body: ProblemBody;
} {
  return {
    status: 403,
    body: problem(403, "auth.insufficient_scope", requestId, {
      detail: "The bootstrap credential may only enrol agents.",
      nextActions: [
        {
          kind: "call",
          title: "Enrol an operator, then call this as that operator",
          operationId: "Operator_enrolAgent",
        },
      ],
    }),
  };
}
