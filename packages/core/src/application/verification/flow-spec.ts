import { Result, Schema } from "effect";
import { type CommitSha, contentHashOf, type Json } from "../../domain/kernel/index.ts";
import {
  type FlowDefinition,
  FlowSpecInvalid,
  type StepSpec,
} from "../../domain/verification/index.ts";
import type { FlowSources } from "../ports/index.ts";
import { detectPack, type VerifierPack } from "./packs.ts";
import { FlowJson, StepFileJson } from "./plan-codec.ts";

/** Where a project keeps its flow, read from the base commit. `.keel/flow*` changes are human-class. */
export const FLOW_SPEC_PATH = ".keel/flow.json";

const FlowFile = Schema.Struct({
  flow: FlowJson,
  steps: Schema.optional(Schema.Array(StepFileJson)),
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
 * Reads `.keel/flow.json`: `{flow, steps?}`, where `flow` is the grammar's
 * tree and `steps` the project's own steps. A flow may name the verifier
 * pack's steps without declaring them; compile joins the two. The definition
 * is stamped with the commit it was read at, which compile checks is the
 * change's base. Anything that is not such a file is FlowSpecInvalid, saying where.
 */
export const parseFlow = (
  source: string,
  commit: CommitSha,
): Result.Result<FlowDefinition, FlowSpecInvalid> => {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    return Result.fail(
      new FlowSpecInvalid({
        reason: `${FLOW_SPEC_PATH} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
  const decoded = Schema.decodeUnknownResult(FlowFile)(json);
  if (Result.isFailure(decoded))
    return Result.fail(
      new FlowSpecInvalid({ reason: `${FLOW_SPEC_PATH}: ${decoded.failure.message}` }),
    );
  // JSON.parse answers JSON, so each step as written can be hashed as it stands.
  const written: readonly Json[] = Array.isArray(Reflect.get(Object(json), "steps"))
    ? Reflect.get(Object(json), "steps")
    : [];
  return Result.succeed({
    commit,
    flow: decoded.success.flow,
    steps: (decoded.success.steps ?? []).map((s, i) => filled(s, written[i] ?? null)),
  });
};

/** What compile needs from a change's base: the project's flow, if it has one, and the pack detection chose. */
export interface FlowSetup {
  readonly definition: FlowDefinition | undefined;
  readonly pack: VerifierPack;
}

/** The base commit's flow (parsed, stamped with the base) and its verifier pack. A malformed flow is FlowSpecInvalid. */
export const flowSetup = (
  sources: FlowSources,
  base: CommitSha,
): Result.Result<FlowSetup, FlowSpecInvalid> => {
  const pack = detectPack(sources.rootPaths, sources.packageJson);
  if (sources.flowJson === undefined) return Result.succeed({ definition: undefined, pack });
  return Result.map(parseFlow(sources.flowJson, base), (definition) => ({ definition, pack }));
};
