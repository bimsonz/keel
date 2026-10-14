import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  citeDiagnostic,
  judgeTypecheck,
  parseTypecheckOutput,
  readDiagnostics,
  type TscDiagnostic,
  TYPECHECK_OUTPUT_LIMIT,
  TYPECHECK_PROTOCOL,
  type TypecheckOutput,
  WORKER_APP_PACK,
} from "../../../src/application/verification/index.ts";
import { CommitSha } from "../../../src/domain/kernel/index.ts";
import { compile } from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

const plan = compile(
  undefined,
  { baseCommit: CommitSha.make("0".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
  WORKER_APP_PACK,
);
if (Result.isFailure(plan)) throw new Error("the worker-app pack does not compile");
const step = plan.success.steps.find((s) => s.id === "worker-app.typecheck");
if (step === undefined) throw new Error("the worker-app plan has no typecheck");

/** A runner's stdout, built the way the typecheck command prints it. */
const stdout = (fields: Record<string, string>, extra: readonly string[] = []) =>
  [
    TYPECHECK_PROTOCOL,
    ...Object.entries(fields).map(([k, v]) => `${k} ${v}`),
    ...extra,
    "KEEL_END",
    "",
  ].join("\n");

const ran = (exit: number, output = "H4sI"): Record<string, string> => ({
  KEEL_HYDRATION: "ok",
  KEEL_DEPS: "ok",
  KEEL_TSCONFIG: "ok",
  KEEL_EXIT: String(exit),
  KEEL_DURATION_MS: "2100",
  KEEL_OUTPUT_BYTES: "240",
  KEEL_OUTPUT: output,
});

const output = (exit: number, outputBytes = 240): TypecheckOutput => ({
  _tag: "ran",
  exit,
  durationMs: 2100,
  outputBytes,
  output: "H4sI",
});
/** A run in which tsc printed nothing. */
const silent = (exit: number): TypecheckOutput => ({
  _tag: "ran",
  exit,
  durationMs: 2100,
  outputBytes: 0,
});
const judge = (o: TypecheckOutput, text: string | undefined) =>
  judgeTypecheck(step, o, { output: text });

const malformed = (s: string) => parseTypecheckOutput(s)._tag;

/** A diagnostic as tsc prints it with `--pretty false`, its continuation lines indented. */
const printed = ({ d, more }: { d: TscDiagnostic; more: readonly string[] }) =>
  [
    d.file === undefined
      ? `error ${d.code}: ${d.message}`
      : `${d.file}(${d.line},${d.column}): error ${d.code}: ${d.message}`,
    ...more.map((m) => `  ${m}`),
  ].join("\n");

const TWO_ERRORS = [
  "src/clock.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/clock.ts(25,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  The expected type comes from the return type of this signature.",
  "",
].join("\n");

describe("the typecheck runner's report", () => {
  it("[typecheck.reads] reads a well-formed run", () => {
    expect(parseTypecheckOutput(stdout(ran(1)))).toEqual({
      _tag: "ran",
      exit: 1,
      durationMs: 2100,
      outputBytes: 240,
      output: "H4sI",
    });
    expect(
      parseTypecheckOutput(stdout({ ...ran(0), KEEL_OUTPUT_BYTES: "0", KEEL_OUTPUT: "none" })),
    ).toEqual({ _tag: "ran", exit: 0, durationMs: 2100, outputBytes: 0 });
    expect(
      parseTypecheckOutput(stdout({ ...ran(1), KEEL_HYDRATION_RETRIED: "hash-mismatch" })),
    ).toMatchObject({ _tag: "ran", rehydrated: "hash-mismatch" });
  });

  it("[typecheck.reads] reads the stops: hydration, missing deps and no tsconfig", () => {
    expect(parseTypecheckOutput(stdout({ KEEL_HYDRATION: "failed hash-mismatch" }))).toEqual({
      _tag: "hydration-failed",
      reason: "hash-mismatch",
    });
    expect(
      parseTypecheckOutput(stdout({ KEEL_HYDRATION: "ok", KEEL_DEPS: "missing fetch-failed" })),
    ).toEqual({ _tag: "deps-missing", reason: "fetch-failed" });
    expect(
      parseTypecheckOutput(
        stdout({ KEEL_HYDRATION: "ok", KEEL_DEPS: "ok", KEEL_TSCONFIG: "none" }),
      ),
    ).toEqual({ _tag: "no-tsconfig" });
    // Missing deps stop the run before it looks for a tsconfig.
    expect(
      parseTypecheckOutput(
        stdout({ KEEL_HYDRATION: "ok", KEEL_DEPS: "missing no-parts", KEEL_TSCONFIG: "none" }),
      ),
    ).toEqual({ _tag: "deps-missing", reason: "no-parts" });
    expect(parseTypecheckOutput(stdout({ KEEL_HYDRATION: "ok", KEEL_TSCONFIG: "none" }))).toEqual({
      _tag: "malformed",
      reason: "no KEEL_DEPS",
    });
  });

  it("[typecheck.reads] calls anything else malformed", () => {
    expect(malformed("")).toBe("malformed");
    expect(malformed(stdout(ran(0)).replace(TYPECHECK_PROTOCOL, "KEEL_SUITE/1"))).toBe("malformed");
    expect(malformed(stdout(ran(0), ["KEEL_EXIT 0"]))).toBe("malformed");
    expect(malformed(`${stdout(ran(0))}${stdout(ran(1))}`)).toBe("malformed");
    expect(malformed(stdout({ ...ran(0), KEEL_TSCONFIG: "maybe" }))).toBe("malformed");
    expect(malformed(stdout({ ...ran(0), KEEL_OUTPUT_BYTES: "-1" }))).toBe("malformed");
    expect(malformed(stdout({ ...ran(0), KEEL_OUTPUT: "not base64!" }))).toBe("malformed");
    const { KEEL_OUTPUT: _output, ...noOutput } = ran(0);
    expect(malformed(stdout(noOutput))).toBe("malformed");
  });
});

describe("tsc's diagnostics", () => {
  it("[typecheck.reads-back] reads located and unlocated errors, folding indented lines into the message", () => {
    expect(
      readDiagnostics(
        `${TWO_ERRORS}error TS5058: The specified path does not exist: 'tsconfig.json'.\n`,
      ),
    ).toEqual({
      diagnostics: [
        {
          file: "src/clock.ts",
          line: 12,
          column: 3,
          code: "TS2322",
          message: "Type 'string' is not assignable to type 'number'.",
        },
        {
          file: "src/clock.ts",
          line: 25,
          column: 5,
          code: "TS2322",
          message:
            "Type 'string' is not assignable to type 'number'.\nThe expected type comes from the return type of this signature.",
        },
        { code: "TS5058", message: "The specified path does not exist: 'tsconfig.json'." },
      ],
      reported: 3,
    });
  });

  const segment = fc.stringMatching(/^[a-z0-9_.()-]{1,8}$/);
  const diagnosticArb: fc.Arbitrary<{ d: TscDiagnostic; more: readonly string[] }> = fc.record({
    d: fc.oneof(
      fc.record({
        file: fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => s.join("/")),
        line: fc.integer({ min: 1, max: 99_999 }),
        column: fc.integer({ min: 1, max: 999 }),
        code: fc.integer({ min: 1000, max: 99_999 }).map((n) => `TS${n}`),
        message: fc.string({ maxLength: 120 }).filter((m) => !m.includes("\n")),
      }),
      fc.record({
        code: fc.integer({ min: 1000, max: 99_999 }).map((n) => `TS${n}`),
        message: fc.string({ maxLength: 120 }).filter((m) => !m.includes("\n")),
      }),
    ),
    more: fc.array(fc.stringMatching(/^[A-Za-z',.][A-Za-z ',.]{0,40}[A-Za-z',.]$/), {
      maxLength: 3,
    }),
  });

  it("[typecheck.reads-back] reads back every diagnostic tsc prints, in order", () => {
    fc.assert(
      fc.property(fc.array(diagnosticArb, { maxLength: 8 }), (ds) => {
        const read = readDiagnostics(`${ds.map(printed).join("\n")}\n`);
        expect(read.diagnostics).toEqual(
          ds.map(({ d, more }) => ({ ...d, message: [d.message, ...more].join("\n") })),
        );
        expect(read.reported).toBeGreaterThanOrEqual(ds.length);
      }),
    );
  });

  it("cites a diagnostic by place, code and the first line of its message", () => {
    expect(
      citeDiagnostic({
        file: "src/a.ts",
        line: 3,
        column: 9,
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.\nmore",
      }),
    ).toBe("src/a.ts:3:9 TS2322 Type 'string' is not assignable to type 'number'.");
    expect(citeDiagnostic({ code: "TS5058", message: "x".repeat(200) })).toBe(
      `TS5058 ${"x".repeat(159)}…`,
    );
  });
});

describe("judging a typecheck", () => {
  it("[typecheck.clean-passes] passes exit 0 with nothing reported", () => {
    const j = judge(silent(0), undefined);
    expect(j.report).toMatchObject({ stepId: step.id, outcome: "pass", durationMs: 2100 });
    expect(j.report.failure).toBeUndefined();
    expect(j.evidence).toMatchObject({ outcome: "pass", errors: [], errorCount: 0 });
  });

  it("[typecheck.errors-fail] fails a non-zero exit that names errors, citing each, unlocated ones too", () => {
    const j = judge(output(1), `${TWO_ERRORS}error TS5058: The specified path does not exist.\n`);
    expect(j.report.outcome).toBe("fail");
    expect(j.evidence.why).toBe("3 type errors");
    expect(j.evidence.errorCount).toBe(3);
    expect(j.evidence.errors.map(citeDiagnostic)).toEqual([
      "src/clock.ts:12:3 TS2322 Type 'string' is not assignable to type 'number'.",
      "src/clock.ts:25:5 TS2322 Type 'string' is not assignable to type 'number'.",
      "TS5058 The specified path does not exist.",
    ]);
    expect(
      judge(output(1), "error TS5083: Cannot read file 'tsconfig.json'.\n").report.outcome,
    ).toBe("fail");
  });

  it("[typecheck.exit-agrees] abstains when the exit code and the output disagree", () => {
    // Errors printed, yet exit 0.
    expect(judge(output(0), TWO_ERRORS).report).toMatchObject({
      outcome: "abstain",
      failure: "schema",
    });
    // A non-zero exit with nothing read: tsc's help, a crash, an empty log.
    expect(judge(output(1), "Version 7.0.2\ntsc: The TypeScript Compiler\n").report.outcome).toBe(
      "abstain",
    );
    expect(judge(silent(2), undefined).report.outcome).toBe("abstain");
    // Errors in a shape this reader does not know (`--pretty`), whatever the exit.
    const pretty = "src/a.ts:1:7 - error TS2322: Type 'string' is not assignable.\n";
    expect(judge(output(0), pretty).report.outcome).toBe("abstain");
    expect(judge(output(1), pretty).evidence.why).toBe(
      "exit 1 contradicts tsc's output (0 errors read, 1 reported)",
    );
  });

  it("[typecheck.never-passes-errors] never passes output that reports an error anywhere, whatever the exit", () => {
    const line = fc.string({ maxLength: 60 }).filter((l) => !l.includes("\n"));
    fc.assert(
      fc.property(
        fc.array(line, { maxLength: 5 }),
        fc.array(line, { maxLength: 5 }),
        line,
        fc.integer({ min: 1000, max: 99_999 }),
        line,
        fc.integer({ min: 0, max: 3 }),
        (before, after, prefix, code, suffix, exit) => {
          const text = [...before, `${prefix}error TS${code}${suffix}`, ...after].join("\n");
          expect(judge(output(exit), text).report.outcome).not.toBe("pass");
        },
      ),
    );
  });

  it("[typecheck.no-tsconfig] fails with no tsconfig.json, as missing configuration with what to add, never as infra", () => {
    const j = judge({ _tag: "no-tsconfig" }, undefined);
    expect(j.report.outcome).toBe("fail");
    expect(j.report).not.toHaveProperty("failure");
    expect(j.evidence).toMatchObject({
      outcome: "fail",
      why: "no tsconfig.json at the candidate's root",
      errors: [],
      config: {
        missing: "tsconfig.json",
        remedy:
          "the typecheck step runs the project's own tsc --noEmit with the tsconfig.json at the repository's root, and there is none: add one that includes the Worker's sources, and commit it",
      },
    });
  });

  it("abstains on every infra stop, and on output that did not decode", () => {
    expect(
      judge({ _tag: "malformed", reason: "no typecheck report" }, undefined).report,
    ).toMatchObject({ outcome: "abstain", failure: "schema" });
    expect(
      judge({ _tag: "hydration-failed", reason: "hash-mismatch" }, undefined).report,
    ).toMatchObject({ outcome: "abstain", failure: "unavailable" });
    const missing = judge({ _tag: "deps-missing", reason: "part-hash-mismatch" }, undefined);
    expect(missing.report).toMatchObject({ outcome: "abstain", failure: "unavailable" });
    expect(missing.evidence.why).toBe("deps-unavailable: part-hash-mismatch");
    expect(judge(output(1), undefined).evidence.why).toBe("tsc's output did not decode");
  });

  it("[typecheck.truncated] marks errors read from cut-short output as a lower bound", () => {
    const j = judge(output(1, TYPECHECK_OUTPUT_LIMIT + 1), TWO_ERRORS);
    expect(j.report.outcome).toBe("fail");
    expect(j.evidence).toMatchObject({ why: "2+ type errors", truncated: true });
    expect(judge(output(1), TWO_ERRORS).evidence).not.toHaveProperty("truncated");
  });

  it("[typecheck.credential-scan] abstains on a credential in the runner's output, whatever tsc said", () => {
    const scan = { token: 1, expiry: 1, remote: 0, host: 0, literal: 0 };
    const j = judgeTypecheck(step, output(1), { output: TWO_ERRORS, credentialScan: scan });
    expect(j.report).toMatchObject({ outcome: "abstain", failure: "schema" });
    expect(j.evidence).toMatchObject({ outcome: "abstain", credentialScan: scan });
    expect(j.evidence.why).toMatch(/^credential-leak: /);
    const clean = { token: 0, expiry: 0, remote: 0, host: 0, literal: 0 };
    expect(
      judgeTypecheck(step, output(1), { output: TWO_ERRORS, credentialScan: clean }).evidence,
    ).toMatchObject({ outcome: "fail", credentialScan: clean });
  });
});
