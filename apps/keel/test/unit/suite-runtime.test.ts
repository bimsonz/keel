import { describe, expect, it } from "@effect/vitest";
import {
  SUITE_PROTOCOL,
  TIER2_STEP_IDS,
  TYPECHECK_PROTOCOL,
} from "@keeltown/core/application/verification";
import { suiteStdout, typecheckStdout } from "../support-suite-stdout.ts";
import type { VerificationJob } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { VerifierRuntime } from "@keeltown/core/ports";
import { bundleUrlSigned } from "@keeltown/runner-protocol";
import {
  contractJob,
  makeBundleUrlKeys,
  makeEvidenceStoreMemory,
  PORTS,
  sampleNamespace,
  suitePlan,
  workerAppPlan,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import {
  type Durable,
  JS_TS_SUITE_COMMAND,
  type SuiteRunner,
  type SuiteRunnerOptions,
  SuiteRuntimeCi,
  TIER2_RUNNERS,
  TYPECHECK_COMMAND,
} from "../../src/adapters/driven/ci/suite-runtime.ts";
import { checkoutOf, keelBundleSource } from "../../src/adapters/driving/workflow/bundle-source.ts";

const SUITE = suitePlan();
const step = SUITE.steps[0];
if (step === undefined) throw new Error("the suite plan has no step");
const typecheck = workerAppPlan().steps.find((s) => s.id === "worker-app.typecheck");
if (typecheck === undefined) throw new Error("the worker-app plan has no typecheck");
const TSC_RED = [
  "src/clock.ts(12,14): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/clock.ts(24,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "",
].join("\n");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
/** The pair bundle URLs are signed with here: keel's half signs, the bundle host's half checks. */
const KEYS = await makeBundleUrlKeys();
const X = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const Y = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V1";
const TOKEN = "art_v2_x_SECRETsecret123?expires=1760140800";

const runnerStdout = (tests: number, failed: number, tail: string) =>
  suiteStdout(tests, failed, { tail, message: `leaked ${TOKEN} from ${ACCOUNT}` });

const job = (): VerificationJob => ({
  jobId: "job-1",
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${"b".repeat(64)}`),
  steps: SUITE.steps,
  fence: contractJob().fence,
});

const typecheckJob = (): VerificationJob => ({ ...job(), steps: [typecheck] });

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
      signingKey: KEYS.signingKey,
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
    "[runner.no-credentials] asks the engine for a runner with no credential, one retry, and only HOME and the bundle's signed URL in its env",
    () =>
      Effect.gen(function* () {
        const rt = runtime(stdoutRunner(""));
        yield* Effect.flatMap(VerifierRuntime, (v) => v.run(sampleNamespace, job())).pipe(
          Effect.provide(rt.layer),
        );
        const [options] = rt.calls;
        if (options === undefined) throw new Error("no runner was started");
        expect(Object.keys(options)).toEqual(
          expect.arrayContaining(["cloudflareCredentials", "sourceControlCredentials"]),
        );
        expect(options).toMatchObject({
          cloudflareCredentials: false,
          sourceControlCredentials: false,
        });
        expect(Object.keys(options.env).toSorted()).toEqual(["HOME", "KEEL_BUNDLE_URL"]);
        expect(options.env.HOME).toBe("/root");
        // [t5.bundle-url.suite-env] The URL is the namespace's bundle, signed for it and good for thirty minutes from now (the test clock's zero).
        const url = new URL(options.env["KEEL_BUNDLE_URL"] ?? "");
        expect(`${url.origin}${url.pathname}`).toBe(
          `https://bundles.keel.internal/org_01JZ8PT2C4E6G8J0M2N4Q6S8V0/${"b".repeat(64)}`,
        );
        expect(url.searchParams.get("exp")).toBe("1800");
        const signedFor = (namespace: string, sha256: string, now: number) =>
          Effect.promise(() =>
            bundleUrlSigned(KEYS.publicKey, namespace, sha256, url.searchParams, now),
          );
        expect(yield* signedFor(X, "b".repeat(64), 1_800)).toBe(true);
        expect(yield* signedFor(X, "b".repeat(64), 1_801)).toBe(false);
        expect(yield* signedFor(Y, "b".repeat(64), 0)).toBe(false);
        expect(yield* signedFor(X, "c".repeat(64), 0)).toBe(false);
        expect(options.config.retries.limit).toBe(1);
      }),
  );

  it("[t5.bundle-url.checkout] hydrates only from the bundle host, by a URL signed for the source's own bundle, and refuses every credential", async () => {
    const checkout = await checkoutOf(
      {
        owner: "keel",
        repo: "l",
        sha: "x",
        providerData: {
          namespace: "org_01JZ8PT2C4E6G8J0M2N4Q6S8V1",
          bundle: `sha256:${"c".repeat(64)}`,
        },
      },
      KEYS.signingKey,
      1_000,
    );
    expect(checkout.kind).toBe("archive");
    const url = new URL(checkout.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://bundles.keel.internal/org_01JZ8PT2C4E6G8J0M2N4Q6S8V1/${"c".repeat(64)}`,
    );
    // Signed for that namespace's bundle alone, until thirty minutes after it was asked for.
    expect(url.searchParams.get("exp")).toBe("2800");
    const q = url.searchParams;
    expect(await bundleUrlSigned(KEYS.publicKey, Y, "c".repeat(64), q, 2_800)).toBe(true);
    expect(await bundleUrlSigned(KEYS.publicKey, Y, "c".repeat(64), q, 2_801)).toBe(false);
    expect(await bundleUrlSigned(KEYS.publicKey, X, "c".repeat(64), q, 1_000)).toBe(false);
    // [t5.checkout.namespace] A source that names no namespace, or one that is not a namespace's id, has no checkout.
    for (const providerData of [
      { bundle: `sha256:${"c".repeat(64)}` },
      { namespace: "keel-verify", bundle: `sha256:${"c".repeat(64)}` },
      { namespace: "../org_01JZ8PT2C4E6G8J0M2N4Q6S8V1", bundle: `sha256:${"c".repeat(64)}` },
      // Made only of an id's characters, so nothing but the id's own shape refuses it.
      { namespace: "keel_lane_d", bundle: `sha256:${"c".repeat(64)}` },
    ])
      await expect(
        checkoutOf({ owner: "keel", repo: "l", sha: "x", providerData }, KEYS.signingKey, 1_000),
      ).rejects.toThrow(/namespace/);
    await expect(
      checkoutOf(
        {
          owner: "keel",
          repo: "l",
          sha: "x",
          providerData: { url: "https://example.com/x.tgz" },
        },
        KEYS.signingKey,
        1_000,
      ),
    ).rejects.toThrow(/namespace/);
    // An env with no signing key makes no provider: no runner is ever handed an unsigned URL.
    expect(() => keelBundleSource.create({})).toThrow(/BUNDLE_URL_SIGNING_KEY/);
    const provider = keelBundleSource.create({ BUNDLE_URL_SIGNING_KEY: KEYS.signingKey });
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
    // Hydration is checked, and refetched at most once, before any test runs.
    const hydrate = lines.indexOf(
      'keel_hydrate $K "${KEEL_BUNDLE_URL:-}" || { echo KEEL_END; exit 0; }',
    );
    expect(hydrate).toBeGreaterThan(-1);
    expect(hydrate).toBeLessThan(lines.findIndex((l) => l.includes("vitest")));
  });

  it.effect("passes a green run, storing its evidence durably before citing it", () =>
    Effect.gen(function* () {
      const stdout = yield* Effect.promise(() => runnerStdout(200, 0, "200 passed"));
      const rt = runtime(stdoutRunner(stdout));
      const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
        v.run(sampleNamespace, job()),
      ).pipe(Effect.provide(rt.layer));
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
      const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
        v.run(sampleNamespace, job()),
      ).pipe(Effect.provide(rt.layer));
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
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, job()),
        ).pipe(Effect.provide(rt.layer));
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
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, job()),
        ).pipe(Effect.provide(rt.layer));
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
          const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
            v.run(sampleNamespace, job()),
          ).pipe(Effect.provide(runtime(runner).layer));
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
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, job()),
        ).pipe(Effect.provide(rt.layer));
        expect(result?.outcome).toBe("abstain");
        const [stored] = [...rt.store.documents.values()];
        expect(JSON.parse(String(stored))).toMatchObject({
          why: "hydration-failed: hash-mismatch",
          diagnosis,
        });
      }),
  );

  it("[d21.tier2-runners] has a runner for exactly the steps core calls executable in Tier 2", () => {
    // Precheck refuses a plan whose Tier 2 step core does not list, and the
    // runtime abstains on a step it has no runner for: the two lists are one.
    expect(Object.keys(TIER2_RUNNERS).toSorted()).toEqual([...TIER2_STEP_IDS].toSorted());
  });

  it.effect("abstains on a step it has no command for, without starting a runner", () =>
    Effect.gen(function* () {
      const rt = runtime(stdoutRunner(""));
      const results = yield* Effect.flatMap(VerifierRuntime, (v) =>
        v.run(sampleNamespace, { ...job(), steps: [{ ...step, id: "other.suite" }] }),
      ).pipe(Effect.provide(rt.layer));
      expect(results.map((r) => r.outcome)).toEqual(["abstain"]);
      expect(rt.calls).toEqual([]);
    }),
  );
});

describe("the Tier 2 typecheck", () => {
  it("prints the typecheck protocol and always exits 0, hydrating and finding a tsconfig before tsc runs", () => {
    const lines = TYPECHECK_COMMAND.split("\n");
    expect(lines).toContain(`echo ${TYPECHECK_PROTOCOL}`);
    expect(lines.at(-1)).toBe("exit 0");
    expect(TYPECHECK_COMMAND).not.toMatch(/exit [1-9]/);
    const tsc = lines.findIndex((l) => l.includes("typescript/bin/tsc --noEmit --pretty false"));
    expect(tsc).toBeGreaterThan(-1);
    expect(
      lines.indexOf('keel_hydrate $K "${KEEL_BUNDLE_URL:-}" || { echo KEEL_END; exit 0; }'),
    ).toBeGreaterThan(-1);
    expect(
      lines.indexOf('keel_hydrate $K "${KEEL_BUNDLE_URL:-}" || { echo KEEL_END; exit 0; }'),
    ).toBeLessThan(tsc);
    expect(lines.findIndex((l) => l.includes("KEEL_LOCK diverged"))).toBeLessThan(tsc);
    expect(lines.findIndex((l) => l.includes("KEEL_TSCONFIG none"))).toBeLessThan(tsc);
  });

  it.effect(
    "[runner.typecheck-routed] runs worker-app.typecheck as its own command and fails it naming tsc's errors",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Effect.promise(() => typecheckStdout(1, TSC_RED));
        const rt = runtime(stdoutRunner(stdout));
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, typecheckJob()),
        ).pipe(Effect.provide(rt.layer));
        expect(rt.calls.map((c) => [c.name, c.command])).toEqual([
          [typecheck.id, TYPECHECK_COMMAND],
        ]);
        expect(result).toMatchObject({ stepId: typecheck.id, outcome: "fail", durationMs: 2100 });
        expect(rt.steps).toEqual([`${typecheck.id}:evidence`]);
        const [stored] = [...rt.store.documents.values()];
        expect(JSON.parse(String(stored))).toMatchObject({
          why: "2 type errors",
          errors: [
            { file: "src/clock.ts", line: 12, column: 14, code: "TS2322" },
            { file: "src/clock.ts", line: 24, column: 5, code: "TS2322" },
          ],
          credentialScan: { token: 0, expiry: 0, remote: 0, host: 0, literal: 0 },
        });
      }),
  );

  it.effect("passes a clean typecheck", () =>
    Effect.gen(function* () {
      const stdout = yield* Effect.promise(() => typecheckStdout(0, ""));
      const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
        v.run(sampleNamespace, typecheckJob()),
      ).pipe(Effect.provide(runtime(stdoutRunner(stdout)).layer));
      expect(result?.outcome).toBe("pass");
    }),
  );

  it.effect(
    "[runner.typecheck-scan] abstains on a credential in tsc's output, storing it redacted",
    () =>
      Effect.gen(function* () {
        const leak = `src/keel-canary.ts(1,14): error TS2322: Type '"${TOKEN}"' is not assignable to type '1'.\n`;
        const stdout = yield* Effect.promise(() => typecheckStdout(1, leak));
        const rt = runtime(stdoutRunner(stdout));
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, typecheckJob()),
        ).pipe(Effect.provide(rt.layer));
        expect(result?.outcome).toBe("abstain");
        const stored = String([...rt.store.documents.values()][0]);
        expect(JSON.parse(stored)).toMatchObject({
          why: expect.stringMatching(/^credential-leak: /),
          credentialScan: { token: 1, expiry: 1 },
        });
        expect(stored).toContain("src/keel-canary.ts");
        expect(stored).not.toMatch(/art_v\d+_/);
        expect(stored).toContain("[REDACTED");
      }),
  );
});
