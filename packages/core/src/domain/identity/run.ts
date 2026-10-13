import { Result, Schema } from "effect";
import { type AgentId, makeId, ProjectId, type RunId, sha256Hex } from "../kernel/index.ts";
import type { Agent } from "./agent.ts";
import { idBody, type KeyThumbprint } from "./agent-key.ts";
import { AgentNotAdmitted } from "./errors.ts";
import type { Handle } from "./handle.ts";

/**
 * What an agent calls one of its runs: one word of lower-case
 * letters and digits, joined by `-`, `_` or `.`, at most 64 characters. It is
 * the agent's own claim; Keel proves only that the run is the agent's.
 */
export const RunLabel = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)).pipe(
  Schema.brand("RunLabel"),
);
export type RunLabel = typeof RunLabel.Type;

/** What names a run under its agent: the label it gives, or failing one the key it asks with. */
export type RunName =
  | { readonly label: RunLabel; readonly runKey?: KeyThumbprint | undefined }
  | { readonly label?: undefined; readonly runKey: KeyThumbprint };

/**
 * A run's id: made from its agent and its label, so a run that restarts with a
 * new process and a new key is still that run. A run that gives no label is its
 * key's. The two never meet: a label and a thumbprint are hashed under
 * different names.
 */
export function runIdOf(agentId: AgentId, name: RunName): RunId {
  const named = name.label === undefined ? `key\n${name.runKey}` : `label\n${name.label}`;
  return makeId("run", idBody(BigInt(`0x${sha256Hex(`${agentId}\n${named}`).slice(0, 32)}`)));
}

/** The request's `project` is not a project id. Nothing is looked up, so it says nothing of what exists. */
export class TargetRefused extends Schema.TaggedError<TargetRefused>()("TargetRefused", {}) {}

/** The request's `run` is no run label. */
export class RunLabelRefused extends Schema.TaggedError<RunLabelRefused>()("RunLabelRefused", {}) {}

/** The token was asked to be bound to one of the account's own keys: a run holds a key of its own. */
export class RunKeyRefused extends Schema.TaggedError<RunKeyRefused>()("RunKeyRefused", {}) {}

/** What a token request says of its project and run, as it arrived. */
export interface RunRequest {
  readonly project?: string | undefined;
  /** The run's label. */
  readonly run?: string | undefined;
  /** The key the token will be bound to; absent for a plain bearer. */
  readonly runKey?: KeyThumbprint | undefined;
}

/** What Keel adds to an agent's token. */
export interface RunClaims {
  /** The agent's revocation epoch when the token was made. */
  readonly epoch: number;
  readonly handle?: Handle;
  /** The one project the token is for; none for a token that stands in the agent's own namespace. */
  readonly prj?: ProjectId;
  readonly run?: { readonly id: RunId; readonly label?: RunLabel };
}

export type RunRefusal = TargetRefused | RunLabelRefused | RunKeyRefused | AgentNotAdmitted;

const asProject = Schema.decodeUnknownOption(ProjectId);
const asLabel = Schema.decodeUnknownOption(RunLabel);

/**
 * The claims a token carries for one project and one run. Whether
 * the agent may read or work in that project is not decided here: the gate
 * decides it on every request, and a project the agent cannot see answers as
 * one that does not exist. So a token request never tells whether a project
 * exists.
 */
export function runClaims(agent: Agent, request: RunRequest): Result.Result<RunClaims, RunRefusal> {
  if (agent.state !== "active")
    return Result.fail(new AgentNotAdmitted({ agentId: agent.id, reason: agent.state }));
  const { runKey } = request;
  if (runKey !== undefined && agent.keys?.some((key) => key.jkt === runKey))
    return Result.fail(new RunKeyRefused());
  const project = request.project === undefined ? undefined : asProject(request.project);
  if (project?._tag === "None") return Result.fail(new TargetRefused());
  const label = request.run === undefined ? undefined : asLabel(request.run);
  if (label?._tag === "None") return Result.fail(new RunLabelRefused());
  const name: RunName | undefined =
    label !== undefined ? { label: label.value } : runKey === undefined ? undefined : { runKey };
  return Result.succeed({
    epoch: agent.revocationEpoch,
    ...(agent.handle === undefined ? {} : { handle: agent.handle }),
    ...(project === undefined ? {} : { prj: project.value }),
    ...(name === undefined
      ? {}
      : {
          run: {
            id: runIdOf(agent.id, name),
            ...(name.label === undefined ? {} : { label: name.label }),
          },
        }),
  });
}
