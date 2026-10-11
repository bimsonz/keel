import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  FlowJson,
  flowSetup,
  JS_TS_SUITE,
  JS_TS_SUITE_PACK,
  parseFlow,
  StepSpecJson,
} from "../../../src/application/verification/index.ts";
import { contentHashOf } from "../../../src/domain/kernel/index.ts";
import { compile } from "../../../src/domain/verification/index.ts";
import { base, flowCaseArb } from "../../arbitraries/flow.ts";
import { fc } from "../../support/fast-check.ts";

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
        expect(parsed).toEqual({ commit: base, flow: c.spec.flow, steps: c.spec.steps });
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
    );
    expect(parsed.steps).toEqual([
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
    );
    expect(parsed.steps).toEqual([]);
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
  });
});

describe("flow setup: the base commit's flow and pack, together", () => {
  it("[flow-setup.reads-both] the flow is parsed at the base and the pack is detected from the same commit", () => {
    const setup = Result.getOrThrow(
      flowSetup(
        {
          rootPaths: [".keel", "package.json", "wrangler.jsonc"],
          flowJson: JSON.stringify({ flow: { _tag: "step", step: JS_TS_SUITE.id } }),
          packageJson: "{}",
        },
        base,
      ),
    );
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
