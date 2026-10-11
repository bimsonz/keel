import { describe, expect, it } from "@effect/vitest";
import { L1_SUITE_PLAN, SUITE_PROTOCOL } from "@keeltown/core/application/verification";
import { suiteStdout } from "../support-suite-stdout.ts";
import type { VerificationJob } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { VerifierRuntime } from "@keeltown/core/ports";
import { contractJob, makeEvidenceStoreMemory, PORTS } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import {
  type Durable,
  JS_TS_SUITE_COMMAND,
  type SuiteRunner,
  type SuiteRunnerOptions,
  SuiteRuntimeCi,
} from "../../src/adapters/driven/ci/suite-runtime.ts";
import { checkoutOf, keelBundleSource } from "../../src/adapters/driving/workflow/bundle-source.ts";

const step = L1_SUITE_PLAN.steps[0];
if (step === undefined) throw new Error("the L1 plan has no step");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "art_v2_x_SECRETsecret123?expires=1760140800";

const runnerStdout = (tests: number, failed: number, tail: string) =>
  suiteStdout(tests, failed, { tail, message: `leaked ${TOKEN} from ${ACCOUNT}` });

const job = (): VerificationJob => ({
  jobId: "job-1",
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${"b".repeat(64)}`),
  steps: L1_SUITE_PLAN.steps,
  fence: contractJob().fence,
});

/** The runtime over a runner the test scripts, with steps recorded instead of made durable. */
const runtime = (runner: SuiteRunner) => {
  const calls: SuiteRunnerOptions[] = [];
  const steps: string[] = [];
  const durable: Durable = (name, effect) =>
    Effect.tap(effect, () => Effect.sync(() => steps.push(name)));
  const store = makeEvidenceStoreMemory();
  const layer = Layer.merge(
    store.layer,
    SuiteRuntimeCi({
      runner: (options) => {
        calls.push(options);
        return runner(options);
      },
      durable,
      literals: [ACCOUNT],
    }).pipe(Layer.provide(store.layer)),
  );
  return { calls, steps, store, layer };
};

const stdoutRunner =
  (stdout: string | ReadableStream<Uint8Array>): SuiteRunner =>
  async () => ({ logs: { stdout } });

PORTS.VerifierRuntime.contract("ci (scripted runner)", () => runtime(stdoutRunner("")).layer);

describe("the Tier 2 suite runtime", () => {
  it.effect(
    "[runner.no-credentials] asks the engine for a runner with no credential, one retry, and only HOME and the bundle's URL in its env",
    () =>
      Effect.gen(function* () {
        const rt = runtime(stdoutRunner(""));
        yield* Effect.flatMap(VerifierRuntime, (v) => v.run(job())).pipe(Effect.provide(rt.layer));
        const [options] = rt.calls;
        if (options === undefined) throw new Error("no runner was started");
        expect(Object.keys(options)).toEqual(
          expect.arrayContaining(["cloudflareCredentials", "sourceControlCredentials"]),
        );
        expect(options).toMatchObject({
          cloudflareCredentials: false,
          sourceControlCredentials: false,
        });
        expect(options.env).toEqual({
          HOME: "/root",
          KEEL_BUNDLE_URL: `https://bundles.keel.internal/${"b".repeat(64)}`,
        });
        expect(options.config.retries.limit).toBe(1);
      }),
  );

  it("hydrates only from the bundle host, and refuses every credential", async () => {
    expect(
      checkoutOf({
        owner: "keel",
        repo: "l",
        sha: "x",
        providerData: { bundle: `sha256:${"c".repeat(64)}` },
      }),
    ).toEqual({
      kind: "archive",
      url: `https://bundles.keel.internal/${"c".repeat(64)}`,
    });
    expect(() =>
      checkoutOf({
        owner: "keel",
        repo: "l",
        sha: "x",
        providerData: { url: "https://example.com/x.tgz" },
      }),
    ).toThrow(/bundle/);
    const provider = keelBundleSource.create({});
    await expect(
      provider.getStepCredentialEnv({ owner: "keel", repo: "l", sha: "x", providerData: {} }),
    ).rejects.toThrow(/no credentials/);
    expect(() =>
      keelBundleSource.assertSource({ provider: "cloudflare-artifacts", owner: "o", repo: "r" }),
    ).toThrow(/runs only keel-bundle/);
  });

  it("prints the suite protocol and always exits 0, so the engine never retries a red suite", () => {
    const lines = JS_TS_SUITE_COMMAND.split("\n");
    expect(lines).toContain(`echo ${SUITE_PROTOCOL}`);
    expect(lines.at(-1)).toBe("exit 0");
    expect(JS_TS_SUITE_COMMAND).not.toMatch(/exit [1-9]/);
    expect(
      lines.indexOf('reason=$(keel_verify_bundle) || { hydration_diff; stop "$reason"; }'),
    ).toBeLessThan(lines.findIndex((l) => l.includes("vitest")));
  });

  it.effect("passes a green run, storing its evidence durably before citing it", () =>
    Effect.gen(function* () {
      const stdout = yield* Effect.promise(() => runnerStdout(200, 0, "200 passed"));
      const rt = runtime(stdoutRunner(stdout));
      const [result] = yield* Effect.flatMap(VerifierRuntime, (v) => v.run(job())).pipe(
        Effect.provide(rt.layer),
      );
      expect(result).toMatchObject({
        stepId: step.id,
        outcome: "pass",
        evidenceClass: "proof",
        durationMs: 4600,
      });
      expect(result?.resultRef).toMatch(/^sha256:/);
      expect(rt.steps).toEqual([`${step.id}:evidence`]);
      expect(rt.calls.map((c) => c.name)).toEqual([step.id]);
    }),
  );

  it.effect("fails a red run with no credential in it, and keeps a clean scan as evidence", () =>
    Effect.gen(function* () {
      const stdout = yield* Effect.promise(() => suiteStdout(5, 2));
      const rt = runtime(stdoutRunner(stdout));
      const [result] = yield* Effect.flatMap(VerifierRuntime, (v) => v.run(job())).pipe(
        Effect.provide(rt.layer),
      );
      expect(result?.outcome).toBe("fail");
      const [stored] = [...rt.store.documents.values()];
      expect(JSON.parse(String(stored))).toMatchObject({
        credentialScan: { token: 0, expiry: 0, remote: 0, host: 0, literal: 0 },
      });
    }),
  );

  it.effect(
    "[runner.credential-scan] abstains on a run whose raw output holds a credential, keeping only counts and redacted evidence",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Effect.promise(() =>
          runnerStdout(5, 2, `tail ${TOKEN} https://${ACCOUNT}.artifacts.cloudflare.net/x`),
        );
        const rt = runtime(stdoutRunner(stdout));
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) => v.run(job())).pipe(
          Effect.provide(rt.layer),
        );
        expect(result?.outcome).toBe("abstain");
        const [document] = [...rt.store.documents.values()];
        const stored = String(document);
        expect(JSON.parse(stored)).toMatchObject({
          outcome: "abstain",
          why: expect.stringMatching(/^credential-leak: /),
          credentialScan: { remote: 1 },
        });
        const { credentialScan: scan } = Schema.decodeUnknownSync(
          Schema.Struct({
            credentialScan: Schema.Struct({ token: Schema.Number, literal: Schema.Number }),
          }),
        )(JSON.parse(stored));
        // The tail's token and each failing test's message (2 tests): in the decoded tail and report.
        expect(scan.token).toBeGreaterThanOrEqual(3);
        expect(scan.literal).toBeGreaterThanOrEqual(3);
        expect(stored).toContain("test/sessions.test.ts");
        expect(stored).not.toContain("/workspace/");
        expect(stored).not.toMatch(/art_v\d+_|artifacts\.cloudflare\.net/);
        expect(stored).not.toContain(ACCOUNT);
        expect(stored).toContain("[REDACTED");
      }),
  );

  it.effect(
    "[runner.credential-scan] catches the staging canary's thrown dump: two token-shaped strings, two expiries, no account id",
    () =>
      Effect.gen(function* () {
        const dump = [
          "== exec env ==",
          "HOME=/root",
          "== planted child environ ==",
          "KEEL_CANARY_ENV=art_v2_x_KEELCANARYenvenvenvenv?expires=1760140800",
          "== canary ==",
          "art_v1_KEELCANARYd1d1d1d1d1d1d1d1d1d1?expires=1760140800",
        ].join("\n");
        const stdout = yield* Effect.promise(() =>
          suiteStdout(1, 1, { tail: "1 failed", message: `Error: ${dump}` }),
        );
        const rt = runtime(stdoutRunner(stdout));
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) => v.run(job())).pipe(
          Effect.provide(rt.layer),
        );
        expect(result?.outcome).toBe("abstain");
        const [document] = [...rt.store.documents.values()];
        expect(JSON.parse(String(document))).toMatchObject({
          credentialScan: { token: 2, expiry: 2, remote: 0, host: 0, literal: 0 },
        });
      }),
  );

  it.effect(
    "abstains when the engine gives up, when the log is a stream, and on an empty log",
    () =>
      Effect.gen(function* () {
        for (const runner of [
          (async () => {
            throw new Error("runner failed after its retries");
          }) satisfies SuiteRunner,
          stdoutRunner(new ReadableStream()),
          stdoutRunner(""),
        ]) {
          const [result] = yield* Effect.flatMap(VerifierRuntime, (v) => v.run(job())).pipe(
            Effect.provide(runtime(runner).layer),
          );
          expect(result?.outcome).toBe("abstain");
        }
      }),
  );

  it.effect(
    "[suite.diagnosis-kept] abstains on a failed hydration, keeping the runner's diagnosis in the evidence",
    () =>
      Effect.gen(function* () {
        const diagnosis = "entry 7 src/app.ts missing\nrefetch curl 0 http 200\n";
        const stdout = [
          SUITE_PROTOCOL,
          `KEEL_HYDRATION_DIFF ${Buffer.from(diagnosis).toString("base64")}`,
          "KEEL_HYDRATION failed hash-mismatch",
          "KEEL_END",
          "",
        ].join("\n");
        const rt = runtime(stdoutRunner(stdout));
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) => v.run(job())).pipe(
          Effect.provide(rt.layer),
        );
        expect(result?.outcome).toBe("abstain");
        const [stored] = [...rt.store.documents.values()];
        expect(JSON.parse(String(stored))).toMatchObject({
          why: "hydration-failed: hash-mismatch",
          diagnosis,
        });
      }),
  );

  it.effect("abstains on a step it has no command for, without starting a runner", () =>
    Effect.gen(function* () {
      const rt = runtime(stdoutRunner(""));
      const results = yield* Effect.flatMap(VerifierRuntime, (v) =>
        v.run({ ...job(), steps: [{ ...step, id: "other.suite" }] }),
      ).pipe(Effect.provide(rt.layer));
      expect(results.map((r) => r.outcome)).toEqual(["abstain"]);
      expect(rt.calls).toEqual([]);
    }),
  );
});
