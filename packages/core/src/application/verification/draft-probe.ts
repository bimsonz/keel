import { Effect, Result } from "effect";
import type { Proposition } from "../../domain/coordination/index.ts";
import type { ContentHash, NamespaceId } from "../../domain/kernel/index.ts";
import {
  ADMISSION_RUNS,
  admit,
  type FlowWorld,
  type ModelAbstained,
  type World,
} from "../../domain/verification/index.ts";
import {
  NamespaceUsage,
  PlatformFunction,
  type ProbeRunner,
  type ProbeRunnerUnavailable,
  ProbeStore,
} from "../ports/index.ts";
import type { ProbeFile, ProbeTemplate } from "./probe-templates/template.ts";
import { type MatrixCell, type MatrixHarnessError, runMatrix } from "./run-matrix.ts";
import {
  describeNoNoop,
  MATRIX_WORLDS,
  type NoNoop,
  type NoopRecipe,
  noopPlaced,
} from "./world-matrix.ts";

/**
 * Repairs after the first draft (spike S26): at most 1 + DRAFT_REPAIRS model
 * calls. Probe drafting is Keel's only repair loop, and it is bounded.
 */
export const DRAFT_REPAIRS = 3;

/** What a draft is drafted from: the disagreement, and the code it is about. */
export interface DraftContext {
  /** What the premise-holder (A) relies on. */
  readonly premise: Proposition;
  /** What the other change (B) derives, which contradicts it. */
  readonly effect: Proposition;
  /** The code the premise is about, as anchors name it. */
  readonly anchors: readonly string[];
  /** The project's source, whole: a pruned file set broke every draft in setup (S26). */
  readonly source: readonly { readonly path: string; readonly text: string }[];
  /** Each change's hunks against trunk. */
  readonly hunks: { readonly A: string; readonly B: string };
}

/** A probe that ran its whole matrix clean: as ProbeStore holds it, the files it was rendered as, and every cell. */
export interface DraftRan {
  readonly probe: ContentHash;
  /** What its guard commits beside guard.json, if the domain admits it. */
  readonly files: readonly ProbeFile[];
  readonly cells: readonly MatrixCell[];
}

/** How drafting ended. Only an admitted probe goes on; any other end escalates its conflict. */
export type DraftOutcome =
  | {
      readonly _tag: "Admitted";
      readonly probe: ContentHash;
      /** The rendered probe, as ProbeStore holds it under `probe`: what its guard commits beside guard.json. */
      readonly files: readonly ProbeFile[];
      readonly cells: readonly MatrixCell[];
      readonly attempts: number;
    }
  | {
      readonly _tag: "Discarded";
      readonly reason: "non-discriminating" | "unstable" | "incomplete" | "repairs-exhausted";
      readonly attempts: number;
      /** What every failed attempt was told, in order. */
      readonly feedback: readonly string[];
      /** A probe that ran clean and was not admitted: the probe, its files and its matrix. */
      readonly ran?: DraftRan;
    }
  | {
      readonly _tag: "Abstained";
      readonly reason: string;
      readonly attempts: number;
      /** What the model's adapter said of the abstain, when it said anything: an AI error's own text. */
      readonly detail?: string;
      /** What every attempt before the abstain was told, in order: what each of them failed on. */
      readonly feedback: readonly string[];
    };

const ADMISSION_RULE = `The probe runs in five worlds, each on a fresh isolate with no network: trunk (neither change), A (the
premise-holder's change alone), B (the other change alone), AB (both), and A-noop (A with the anchored call made a
statement that does nothing). It is admitted only if, on each of ${ADMISSION_RUNS} runs, it passes or reports n/a on
trunk, passes in A, fails in AB, and fails in A-noop. B is recorded but does not decide. A probe that passes in A-noop
never tested the premise, and is never admitted.`;

const NA_RULE = `n/a means the behaviour the premise is about is absent in that world (for example, there is no revoke
route): the probe throws Error("probe not applicable: <why>"). Anything else that goes wrong is a failure.`;

const PROBE_CONTRACT = `The probe is one vitest file with exactly one test. It must log at least one observation line that
starts with "[probe]" before it decides. Only describe, it, and expect(x).toBe, toEqual, toMatch and toThrow are
available. Its harness reports pass, fail or n/a; a probe that breaks the harness (no observation, two tests, an
unsupported matcher, a module that does not bundle) is a harness error, which is never a result.`;

/**
 * The single prompt a draft or repair is given: the disagreement, the rules,
 * the code, the template's own instructions, and, on a repair, what every
 * earlier attempt was told, which is only ever deterministic text.
 */
export const draftPrompt = <S>(
  template: ProbeTemplate<S>,
  context: DraftContext,
  feedback: readonly string[],
): string =>
  [
    `## The disagreement`,
    `Change A relies on: ${JSON.stringify(context.premise)}`,
    `Change B derives: ${JSON.stringify(context.effect)}`,
    `Anchors: ${context.anchors.join(", ")}`,
    `## Worlds and admission`,
    ADMISSION_RULE,
    `## n/a`,
    NA_RULE,
    `## The probe contract`,
    PROBE_CONTRACT,
    `## Change A's hunks`,
    context.hunks.A,
    `## Change B's hunks`,
    context.hunks.B,
    `## The project's source`,
    ...context.source.map((f) => `### ${f.path}\n\`\`\`\n${f.text}\n\`\`\``),
    template.instructions,
    ...(feedback.length === 0
      ? []
      : [
          `## Your earlier replies failed`,
          `Fix what each line says, and reply with the whole JSON object again.`,
          ...feedback.map((line) => `- ${line}`),
        ]),
  ].join("\n\n");

/**
 * What a repair is told when the model's reply was unusable: a reply that did
 * not parse, or was cut at the token limit, is repaired with the parser's
 * message or the limit. A timeout, a rate limit or an unavailable model ends
 * the draft, with what the adapter said of it: no text a repair could be told
 * would fix it. Whether the conflict is drafted again later is the caller's
 * to decide.
 */
const abstainFeedback = (attempt: number, error: ModelAbstained): string | undefined => {
  switch (error.reason) {
    case "schema":
      return `attempt ${attempt}: reply did not parse as the slot schema: ${error.detail ?? "no parser message"}`;
    case "truncated":
      return `attempt ${attempt}: reply cut at the token limit (${error.detail ?? "max_tokens"}); return only the slots`;
    default:
      return undefined;
  }
};

/** Harness errors, one line per distinct reason, naming every world#run that gave it. */
const harnessFeedback = (attempt: number, errors: readonly MatrixHarnessError[]): string[] => {
  const byReason = new Map<string, string[]>();
  for (const e of errors)
    byReason.set(e.reason, [...(byReason.get(e.reason) ?? []), `${e.world}#${e.run}`]);
  return [...byReason].map(
    ([reason, where]) => `attempt ${attempt}: harness error in ${where.join(", ")}: ${reason}`,
  );
};

/**
 * The reason every world failed with, when on some run all five failed alike:
 * the probe broke on something every world shares (its own setup), so it never
 * reached the premise. Read as a plain fail, that would never be repaired.
 */
const identicalFailure = (cells: readonly MatrixCell[]): string | undefined => {
  for (let run = 1; run <= ADMISSION_RUNS; run++) {
    const here = MATRIX_WORLDS.map((world: World) =>
      cells.find((c) => c.run === run && c.world === world),
    );
    const [first] = here;
    if (
      first !== undefined &&
      here.every((c) => c !== undefined && c.outcome === "fail" && c.reason === first.reason)
    )
      return first.reason;
  }
  return undefined;
};

/**
 * Drafts a probe from a template (spike S26): the model fills the template's
 * slots, the slots name A-noop's recipe, Keel builds A-noop with `aNoop` (A's
 * tree with that call made a no-op), renders and stores the probe, and the
 * world matrix runs it ADMISSION_RUNS times. A reply that fails the
 * template's check, a recipe that is not on a line A adds or does not occur
 * exactly once in A's file, a harness error, or a failure identical in every
 * world is repaired, at most DRAFT_REPAIRS times, from deterministic text
 * only: never from the model's own rationale. An admitted probe ends it; any
 * other matrix result is discarded as admission judged it, a template with no
 * recipe is incomplete, and an abstaining model ends it too, with the
 * abstain's detail and the feedback so far. A runner that cannot run at all
 * fails, for the caller to draft again. Each call to the model is admitted
 * first against the namespace's model-calls, under `<key>:<attempt>`, so a
 * retried draft counts each call once: a refusal (the day's limit, or a
 * halted namespace) ends the draft as abstained `rate-limited` with why, and
 * calls nothing.
 */
export const draftProbe = <S, R>(
  namespace: NamespaceId,
  template: ProbeTemplate<S>,
  context: DraftContext,
  worlds: Readonly<Record<FlowWorld, ContentHash>>,
  aNoop: (recipe: NoopRecipe) => Effect.Effect<ContentHash, NoNoop, R>,
  key: string,
): Effect.Effect<
  DraftOutcome,
  ProbeRunnerUnavailable,
  PlatformFunction | ProbeStore | ProbeRunner | NamespaceUsage | R
> =>
  Effect.gen(function* () {
    const model = yield* PlatformFunction;
    const store = yield* ProbeStore;
    const usage = yield* NamespaceUsage;
    const feedback: string[] = [];
    for (let attempt = 1; attempt <= 1 + DRAFT_REPAIRS; attempt++) {
      const admitted = yield* Effect.result(
        usage.admit(namespace, "model-calls", 1, `draft:${key}:${attempt}`),
      );
      if (Result.isFailure(admitted)) {
        const refused = admitted.failure;
        return {
          _tag: "Abstained",
          reason: "rate-limited",
          attempts: attempt - 1,
          detail:
            refused.reason === "halted"
              ? `namespace.halted: verification spend is stopped for ${namespace}`
              : `quota.exceeded: ${namespace} has used ${refused.used} of its ${refused.limit} model-calls for today`,
          feedback,
        } satisfies DraftOutcome;
      }
      const reply = yield* model
        .call({
          name: template.fn,
          input: { prompt: draftPrompt(template, context, feedback) },
          outputSchema: template.schema,
        })
        .pipe(
          Effect.map((value) => ({ _tag: "Replied", value }) as const),
          Effect.catchTag("ModelAbstained", (e) =>
            Effect.succeed({ _tag: "Abstained", error: e } as const),
          ),
        );
      if (reply._tag === "Abstained") {
        const told = abstainFeedback(attempt, reply.error);
        if (told === undefined)
          return {
            _tag: "Abstained",
            reason: reply.error.reason,
            attempts: attempt,
            ...(reply.error.detail === undefined ? {} : { detail: reply.error.detail }),
            feedback,
          } satisfies DraftOutcome;
        feedback.push(told);
        continue;
      }
      const slots = template.validate(reply.value);
      if (Result.isFailure(slots)) {
        feedback.push(`attempt ${attempt}: slots: ${slots.failure}`);
        continue;
      }
      const recipe = template.noop?.(slots.success);
      if (recipe === undefined)
        return {
          _tag: "Discarded",
          reason: "incomplete",
          attempts: attempt,
          feedback: [...feedback, `template ${template.id} gives no A-noop recipe`],
        } satisfies DraftOutcome;
      const placed = noopPlaced(context.hunks.A, recipe);
      if (Result.isFailure(placed)) {
        feedback.push(`attempt ${attempt}: noop: ${placed.failure}`);
        continue;
      }
      const noop = yield* Effect.result(aNoop(recipe));
      if (Result.isFailure(noop)) {
        feedback.push(`attempt ${attempt}: noop: ${describeNoNoop(noop.failure)}`);
        continue;
      }
      const files = template.render(slots.success);
      const probe = yield* store.put(namespace, files);
      const { cells, harnessErrors } = yield* runMatrix(
        namespace,
        probe,
        { ...worlds, "A-noop": noop.success },
        ADMISSION_RUNS,
      );
      if (harnessErrors.length > 0) {
        feedback.push(...harnessFeedback(attempt, harnessErrors));
        continue;
      }
      const identical = identicalFailure(cells);
      if (identical !== undefined) {
        feedback.push(
          `attempt ${attempt}: non-discriminating: every world failed with ${JSON.stringify(identical)}`,
        );
        continue;
      }
      const admission = admit(cells);
      if (admission._tag === "admitted")
        return { _tag: "Admitted", probe, files, cells, attempts: attempt } satisfies DraftOutcome;
      return {
        _tag: "Discarded",
        reason: admission._tag === "rejected" ? admission.reason : "incomplete",
        attempts: attempt,
        feedback,
        ran: { probe, files, cells },
      } satisfies DraftOutcome;
    }
    return {
      _tag: "Discarded",
      reason: "repairs-exhausted",
      attempts: 1 + DRAFT_REPAIRS,
      feedback,
    } satisfies DraftOutcome;
  }).pipe(Effect.withSpan("verification/draftProbe"));
