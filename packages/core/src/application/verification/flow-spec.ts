import { Result, Schema } from "effect";
import { Predicate, PredicatePolicies } from "../../domain/coordination/index.ts";
import { type CommitSha, contentHashOf, type Json } from "../../domain/kernel/index.ts";
import {
  type FlowDefinition,
  FlowSpecInvalid,
  STEP_RUN_COMMAND_MAX,
  STEP_RUN_TIMEOUT_MAX_MS,
  type StepSpec,
} from "../../domain/verification/index.ts";
import type { FlowSources } from "../ports/index.ts";
import { detectPack, type VerifierPack } from "./packs.ts";
import { FlowJson, StepFileJson } from "./plan-codec.ts";

/** Where a project keeps its flow, read from the base commit. `.keel/flow*` changes are human-class. */
export const FLOW_SPEC_PATH = ".keel/flow.json";

const FlowFile = Schema.Struct({
  flow: Schema.optional(FlowJson),
  steps: Schema.optional(Schema.Array(StepFileJson)),
  predicates: Schema.optional(PredicatePolicies),
});

/** A step as written, with its version (the hash of the step as written, unless given) and empty lists filled in. */
const filled = (written: StepFileJson, source: Json): StepSpec => ({
  ...written,
  version: written.version ?? contentHashOf(source),
  appliesTo: written.appliesTo ?? { paths: [], subjects: [] },
  reads: written.reads ?? [],
  mayskip: written.mayskip ?? [],
  overrides: written.overrides ?? [],
  determinism: written.determinism ?? "deterministic",
  suite: written.suite ?? false,
  optional: written.optional ?? false,
});

/**
 * Why a step's command cannot run as written, if it cannot: a command runs
 * only in a container, as a deterministic step, within its limits.
 */
const runRefusal = (step: StepFileJson): string | undefined => {
  if (step.run === undefined) return undefined;
  if (step.kind !== "deterministic") return `needs a deterministic step, not ${step.kind}`;
  if (step.tier !== undefined && step.tier !== 2)
    return `runs in a container (tier 2), not tier ${step.tier}`;
  if (step.run.command.length > STEP_RUN_COMMAND_MAX)
    return `command is ${step.run.command.length} characters, over ${STEP_RUN_COMMAND_MAX}`;
  const timeout = step.run.timeoutMs;
  if (timeout !== undefined && (timeout < 1 || timeout > STEP_RUN_TIMEOUT_MAX_MS))
    return `timeoutMs is ${timeout}, outside 1 to ${STEP_RUN_TIMEOUT_MAX_MS}`;
  return undefined;
};

/** What `.keel/flow.json` says: the project's flow, if it has one, and its predicate policy. */
export interface FlowFileRead {
  readonly definition: FlowDefinition | undefined;
  /**
   * Per predicate, what a guard's proven fail does (ADR 0005): read at the
   * base, like the flow, so a change cannot loosen its own guards. A
   * predicate the file leaves out is `advise`.
   */
  readonly predicatePolicy: PredicatePolicies;
}

const invalid = (reason: string) =>
  Result.fail(new FlowSpecInvalid({ reason: `${FLOW_SPEC_PATH}${reason}` }));

/**
 * Reads `.keel/flow.json`: `{flow?, steps?, predicates?}`, where `flow` is
 * the grammar's tree, `steps` the project's own steps and `predicates` its
 * policy per predicate. A flow may name the verifier pack's steps without
 * declaring them; compile joins the two. A file may set only `predicates`,
 * and the pack's flow runs. The definition is stamped with the commit it was
 * read at, which compile checks is the change's base. Anything that is not
 * such a file (steps no flow runs, a predicate Keel does not know) is
 * FlowSpecInvalid, saying where.
 */
export const parseFlow = (
  source: string,
  commit: CommitSha,
): Result.Result<FlowFileRead, FlowSpecInvalid> => {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    return invalid(` is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const decoded = Schema.decodeUnknownResult(FlowFile)(json);
  if (Result.isFailure(decoded)) return invalid(`: ${decoded.failure.message}`);
  const { flow, steps, predicates } = decoded.success;
  const named = Object.keys(Object(Reflect.get(Object(json), "predicates")));
  const unknown = named.filter((p) => !Predicate.literals.some((known) => known === p));
  if (unknown.length > 0)
    return invalid(
      `: predicates names ${unknown.join(", ")}, which Keel does not know (it knows ${Predicate.literals.join(", ")})`,
    );
  if (flow === undefined && steps !== undefined)
    return invalid(": steps are declared, but there is no flow to run them");
  for (const step of steps ?? []) {
    const refused = runRefusal(step);
    if (refused !== undefined) return invalid(`: step ${step.id}'s run ${refused}`);
  }
  // JSON.parse answers JSON, so each step as written can be hashed as it stands.
  const written: readonly Json[] = Array.isArray(Reflect.get(Object(json), "steps"))
    ? Reflect.get(Object(json), "steps")
    : [];
  return Result.succeed({
    definition:
      flow === undefined
        ? undefined
        : {
            commit,
            flow,
            steps: (steps ?? []).map((s, i) => filled(s, written[i] ?? null)),
          },
    predicatePolicy: predicates ?? {},
  });
};

/** What compile needs from a change's base: the project's flow and predicate policy, and the pack detection chose. */
export interface FlowSetup extends FlowFileRead {
  readonly pack: VerifierPack;
}

/** The base commit's flow (parsed, stamped with the base) and its verifier pack. A malformed flow is FlowSpecInvalid. */
export const flowSetup = (
  sources: FlowSources,
  base: CommitSha,
): Result.Result<FlowSetup, FlowSpecInvalid> => {
  const pack = detectPack(sources.rootPaths, sources.packageJson);
  if (sources.flowJson === undefined)
    return Result.succeed({ definition: undefined, predicatePolicy: {}, pack });
  return Result.map(parseFlow(sources.flowJson, base), (read) => ({ ...read, pack }));
};
