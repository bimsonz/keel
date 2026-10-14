import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  FlowJson,
  flowSetup,
  JS_TS_SUITE,
  JS_TS_SUITE_PACK,
  parseFlow,
  readStoredPlan,
  StepSpecJson,
  storedPlanText,
} from "../../../src/application/verification/index.ts";
import { contentHashOf } from "../../../src/domain/kernel/index.ts";
import { compile } from "../../../src/domain/verification/index.ts";
import { base, flowCaseArb } from "../../arbitraries/flow.ts";
import { fc } from "../../support/fast-check.ts";

/** A step with a command of its own, as a project writes it. */
const runStep = {
  id: "check",
  kind: "deterministic",
  evidenceCeiling: "proof",
  outcomes: ["pass", "fail", "abstain"],
  budget: { usd: 0, cpuMs: 60_000, tokens: 0 },
  run: { command: "pnpm test" },
};
const runFile = (step: object): string =>
  JSON.stringify({ flow: { _tag: "step", step: "check" }, steps: [{ ...runStep, ...step }] });

const reasonOf = (source: string): string => {
  const parsed = parseFlow(source, base);
  if (Result.isSuccess(parsed)) throw new Error(`parsed: ${source}`);
  return parsed.failure.reason;
};

describe("flow spec: .keel/flow.json, read from the base commit", () => {
  it("[flow-json.round-trip] every well-typed flow and step survives encoding and decoding", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) => {
        const flow = Schema.decodeUnknownSync(FlowJson)(
          JSON.parse(JSON.stringify(Schema.encodeSync(FlowJson)(c.spec.flow))),
        );
        const steps = c.spec.steps.map((s) =>
          Schema.decodeUnknownSync(StepSpecJson)(
            JSON.parse(JSON.stringify(Schema.encodeSync(StepSpecJson)(s))),
          ),
        );
        expect(flow).toEqual(c.spec.flow);
        expect(steps).toEqual(c.spec.steps);
      }),
    );
  });

  it("[flow-spec.parses] a file holding a flow and its steps reads back as that definition, at the commit given", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) => {
        const parsed = Result.getOrThrow(
          parseFlow(JSON.stringify({ flow: c.spec.flow, steps: c.spec.steps }), base),
        );
        expect(parsed).toEqual({
          definition: { commit: base, flow: c.spec.flow, steps: c.spec.steps },
          predicatePolicy: {},
        });
      }),
    );
  });

  it("[flow-spec.defaults] a step may leave out its version and its empty lists; the version is the hash of the step as written", () => {
    const written = {
      id: "lint",
      kind: "deterministic",
      evidenceCeiling: "proof",
      outcomes: ["pass", "fail", "abstain"],
      budget: { usd: 0, cpuMs: 60_000, tokens: 0 },
      tier: 2,
    };
    const parsed = Result.getOrThrow(
      parseFlow(JSON.stringify({ flow: { _tag: "step", step: "lint" }, steps: [written] }), base),
    ).definition;
    expect(parsed?.steps).toEqual([
      {
        ...written,
        version: contentHashOf(written),
        appliesTo: { paths: [], subjects: [] },
        reads: [],
        mayskip: [],
        overrides: [],
        determinism: "deterministic",
        suite: false,
        optional: false,
      },
    ]);
  });

  it("[flow-spec.pack-steps] a flow may name the pack's steps without declaring them, and compiles against the pack", () => {
    const parsed = Result.getOrThrow(
      parseFlow(
        JSON.stringify({
          flow: { _tag: "seq", exitOn: "fail", items: [{ _tag: "step", step: JS_TS_SUITE.id }] },
        }),
        base,
      ),
    ).definition;
    expect(parsed?.steps).toEqual([]);
    const plan = Result.getOrThrow(
      compile(
        parsed,
        { baseCommit: base, touchedPaths: ["src/a.ts"], subjects: [], facts: {} },
        JS_TS_SUITE_PACK,
      ),
    );
    expect(plan.steps.map((s) => s.id)).toEqual([JS_TS_SUITE.id]);
  });

  it("[flow-spec.invalid] anything else is FlowSpecInvalid, saying where", () => {
    expect(reasonOf("{")).toMatch(/not JSON/);
    expect(reasonOf("[]")).toMatch(/flow/);
    expect(reasonOf(JSON.stringify({ flow: { _tag: "loop", step: "a" } }))).toMatch(/flow/);
    expect(
      reasonOf(
        JSON.stringify({
          flow: { _tag: "cascade", accept: ["maybe"], items: [{ _tag: "step", step: "a" }] },
        }),
      ),
    ).toMatch(/accept/);
    expect(
      reasonOf(
        JSON.stringify({
          flow: { _tag: "step", step: "a" },
          steps: [
            {
              id: "a",
              kind: "magic",
              evidenceCeiling: "proof",
              outcomes: ["abstain"],
              budget: { usd: 0, cpuMs: 1, tokens: 0 },
            },
          ],
        }),
      ),
    ).toMatch(/kind/);
    expect(reasonOf(JSON.stringify({ steps: [] })), "steps with no flow to run them").toMatch(
      /no flow to run them/,
    );
  });

  it("[flow-spec.run] a step's command reads back as written, and is part of the step's version", () => {
    const [step] = Result.getOrThrow(parseFlow(runFile({}), base)).definition?.steps ?? [];
    expect(step?.run).toEqual({ command: "pnpm test" });
    expect(step?.version).toBe(contentHashOf(runStep));
    const timed = Result.getOrThrow(
      parseFlow(runFile({ run: { command: "pnpm test", timeoutMs: 600_000 } }), base),
    );
    expect(timed.definition?.steps[0]?.run).toEqual({ command: "pnpm test", timeoutMs: 600_000 });
  });

  it("[flow-spec.run-stored] a command written in the flow is the one the stored plan reads back, under the plan's hash", () => {
    const plan = Result.getOrThrow(
      compile(
        Result.getOrThrow(parseFlow(runFile({}), base)).definition,
        { baseCommit: base, touchedPaths: ["src/a.ts"], subjects: [], facts: {} },
        JS_TS_SUITE_PACK,
      ),
    );
    const read = Result.getOrThrow(
      readStoredPlan(plan.planHash, Result.getOrThrow(storedPlanText(plan))),
    );
    expect(read.steps.map((s) => [s.id, s.run])).toEqual([
      ["check", { command: "pnpm test", timeoutMs: 240_000 }],
    ]);
  });

  it("[flow-spec.run-refused] a command runs only in a container, as a deterministic step, within its limits", () => {
    const where = ".keel/flow.json: step check's run";
    expect(reasonOf(runFile({ kind: "generative" }))).toBe(
      `${where} needs a deterministic step, not generative`,
    );
    expect(reasonOf(runFile({ kind: "human" }))).toBe(
      `${where} needs a deterministic step, not human`,
    );
    expect(reasonOf(runFile({ tier: 1 }))).toBe(
      `${where} runs in a container (tier 2), not tier 1`,
    );
    expect(reasonOf(runFile({ tier: 0 }))).toBe(
      `${where} runs in a container (tier 2), not tier 0`,
    );
    expect(reasonOf(runFile({ run: { command: "x".repeat(4097) } }))).toBe(
      `${where} command is 4097 characters, over 4096`,
    );
    expect(reasonOf(runFile({ run: { command: "pnpm test", timeoutMs: 0 } }))).toBe(
      `${where} timeoutMs is 0, outside 1 to 1200000`,
    );
    expect(reasonOf(runFile({ run: { command: "pnpm test", timeoutMs: 1_200_001 } }))).toBe(
      `${where} timeoutMs is 1200001, outside 1 to 1200000`,
    );
    expect(reasonOf(runFile({ run: { command: "" } }))).toMatch(/command/);
    // Every step is checked, and the refusal names the step refused, not the first.
    const { run: _run, ...plain } = { ...runStep, id: "lint" };
    expect(
      reasonOf(
        JSON.stringify({
          flow: {
            _tag: "seq",
            exitOn: "fail",
            items: [
              { _tag: "step", step: "lint" },
              { _tag: "step", step: "docs" },
            ],
          },
          steps: [plain, { ...runStep, id: "docs", tier: 1 }],
        }),
      ),
    ).toBe(".keel/flow.json: step docs's run runs in a container (tier 2), not tier 1");
    expect(reasonOf(runFile({ run: { command: "pnpm test", timeoutMs: 1.5 } }))).toMatch(
      /timeoutMs/,
    );
    // Each limit's edge is let through.
    for (const edge of [
      { tier: 2 },
      { run: { command: "x".repeat(4096) } },
      { run: { command: "pnpm test", timeoutMs: 1 } },
      { run: { command: "pnpm test", timeoutMs: 1_200_000 } },
    ])
      expect({ edge, taken: Result.isSuccess(parseFlow(runFile(edge), base)) }).toEqual({
        edge,
        taken: true,
      });
  });

  it("[flow-spec.predicates] the file's predicate policy reads back as written; a file may set only that, and the pack's flow runs", () => {
    const read = Result.getOrThrow(
      parseFlow(
        JSON.stringify({ predicates: { freshness: "block", authority: "annotate" } }),
        base,
      ),
    );
    expect(read).toEqual({
      definition: undefined,
      predicatePolicy: { freshness: "block", authority: "annotate" },
    });
    expect(reasonOf(JSON.stringify({ predicates: { freshness: "loose" } }))).toMatch(/freshness/);
    expect(reasonOf(JSON.stringify({ predicates: { fresh: "block" } }))).toMatch(
      /predicates names fresh, which Keel does not know/,
    );
  });
});

describe("flow setup: the base commit's flow and pack, together", () => {
  it("[flow-setup.reads-both] the flow is parsed at the base and the pack is detected from the same commit", () => {
    const setup = Result.getOrThrow(
      flowSetup(
        {
          rootPaths: [".keel", "package.json", "wrangler.jsonc"],
          flowJson: JSON.stringify({
            flow: { _tag: "step", step: JS_TS_SUITE.id },
            predicates: { freshness: "block" },
          }),
          packageJson: "{}",
        },
        base,
      ),
    );
    expect(setup.predicatePolicy).toEqual({ freshness: "block" });
    expect(setup.definition).toEqual({
      commit: base,
      flow: { _tag: "step", step: JS_TS_SUITE.id },
      steps: [],
    });
    expect(setup.pack.name).toBe("worker-app");
  });

  it("[flow-setup.no-flow] with no .keel/flow.json the pack's own flow runs", () => {
    const setup = Result.getOrThrow(
      flowSetup({ rootPaths: ["package.json"], packageJson: "{}" }, base),
    );
    expect(setup.definition).toBeUndefined();
    expect(setup.predicatePolicy).toEqual({});
    expect(setup.pack.defaults).toBe(JS_TS_SUITE_PACK);
  });

  it("[flow-setup.invalid] a malformed flow is FlowSpecInvalid, never the pack's defaults in its place", () => {
    const setup = flowSetup(
      { rootPaths: ["package.json"], flowJson: "{", packageJson: "{}" },
      base,
    );
    expect(Result.isFailure(setup) && setup.failure._tag).toBe("FlowSpecInvalid");
  });
});
