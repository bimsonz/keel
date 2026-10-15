import { describe, expect, it } from "@effect/vitest";
import {
  type DepsAnswer,
  depsRemedy,
  SUITE_PROTOCOL,
  TIER2_STEP_IDS,
  TYPECHECK_PROTOCOL,
} from "@keeltown/core/application/verification";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandReportStdout,
  commandStdout,
  suiteStdout,
  typecheckStdout,
} from "../support-suite-stdout.ts";
import type { VerificationJob } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { EvidenceStore, VerifierRuntime } from "@keeltown/core/ports";
import { bundleUrlSigned, depsPartUrlSigned } from "@keeltown/runner-protocol";
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
  type BoxLedger,
  boxHoldMs,
  type Durable,
  JS_TS_SUITE_COMMAND,
  judgeCommandOutput,
  projectCommand,
  type SuiteRunner,
  type SuiteRunnerOptions,
  SUITE_CONFIG,
  SuiteRuntimeCi,
  TIER2_RUNNERS,
  tier2RunnerFor,
  TYPECHECK_COMMAND,
} from "../../src/adapters/driven/ci/suite-runtime.ts";
import { checkoutOf, keelBundleSource } from "../../src/adapters/driving/workflow/bundle-source.ts";
import { DEPS_BUILD_STEP } from "../../src/adapters/driving/workflow/deps-build-step.ts";

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

/** A deps bundle of two parts, as the job's Workflow ensured it. */
const PARTS = [
  { sha256: "d".repeat(64), bytes: 10 },
  { sha256: "e".repeat(64), bytes: 5 },
];
const READY: DepsAnswer = { _tag: "DepsReady", install: "1".repeat(64), parts: PARTS };

/** The runtime over a runner the test scripts, with steps recorded instead of made durable. */
/**
 * A box ledger that grants every ask unless told to refuse or to throw, and
 * records each ask and each release, with what the runner had been asked by then.
 */
const ledger = (answer: "grant" | "refuse" | "throw" = "grant") => {
  const asked: Array<{ readonly holder: string; readonly ttlMs: number }> = [];
  const released: string[] = [];
  const boxes: BoxLedger = {
    acquire: async (holder, ttlMs) => {
      asked.push({ holder, ttlMs });
      if (answer === "throw") throw new Error("the gate is away");
      return answer === "grant"
        ? { granted: true, leaseId: `lease-${asked.length}` }
        : { granted: false };
    },
    release: async (leaseId) => {
      released.push(leaseId);
    },
  };
  return { asked, released, boxes };
};

const runtime = (runner: SuiteRunner, boxes: BoxLedger = ledger().boxes) => {
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
      boxes,
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

/** How long a step's retries wait in all, as Workflows spaces them: the delay, then doubled each time for exponential. */
const retryWaitMs = (retries: {
  readonly limit: number;
  readonly delay: number;
  readonly backoff?: "constant" | "linear" | "exponential";
}): number =>
  Array.from({ length: retries.limit }, (_, i) =>
    retries.backoff === "exponential"
      ? retries.delay * 2 ** i
      : retries.backoff === "linear"
        ? retries.delay * (i + 1)
        : retries.delay,
  ).reduce((sum, wait) => sum + wait, 0);

describe("the Tier 2 suite runtime", () => {
  it.effect(
    "[runner.no-credentials] asks the engine for a runner with no credential, one retry, and only HOME, the bundle's signed URL and its deps parts' in its env",
    () =>
      Effect.gen(function* () {
        const rt = runtime(stdoutRunner(""));
        yield* Effect.flatMap(VerifierRuntime, (v) => v.run(sampleNamespace, job(), READY)).pipe(
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
        expect(Object.keys(options.env).toSorted()).toEqual([
          "HOME",
          "KEEL_BUNDLE_URL",
          "KEEL_DEPS_PARTS",
        ]);
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
        expect(options.config.retries).toEqual(SUITE_CONFIG.retries);
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

  it("[suite.no-vitest-command] with no vitest among the deps put in place, says so, drops them and ends; with vitest it goes on to run it", () => {
    const lines = JS_TS_SUITE_COMMAND.split("\n");
    const check = lines.findIndex((l) => l.includes("KEEL_VITEST none"));
    expect(check).toBeGreaterThan(lines.indexOf("echo KEEL_DEPS ok"));
    expect(check).toBeLessThan(lines.findIndex((l) => l.startsWith("node node_modules/vitest")));
    // The check as the box's sh runs it, from the candidate's root, with the drop recorded.
    const run = (withVitest: boolean) => {
      const root = mkdtempSync(join(tmpdir(), "keel-no-vitest-"));
      try {
        if (withVitest) {
          mkdirSync(join(root, "node_modules/vitest"), { recursive: true });
          writeFileSync(join(root, "node_modules/vitest/vitest.mjs"), "");
        }
        const script = [
          'keel_deps_drop() { echo "dropped $1"; }',
          `cd ${root}`,
          ...lines.slice(check, check + 2),
          "echo went-on",
        ].join("\n");
        return execFileSync("sh", ["-c", script], { encoding: "utf8" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    expect(run(false)).toBe("dropped /workspace\nKEEL_VITEST none\nKEEL_END\n");
    expect(run(true)).toBe("KEEL_VITEST ok\nwent-on\n");
  });

  it.effect("passes a green run, storing its evidence durably before citing it", () =>
    Effect.gen(function* () {
      const stdout = yield* Effect.promise(() => runnerStdout(200, 0, "200 passed"));
      const rt = runtime(stdoutRunner(stdout));
      const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
        v.run(sampleNamespace, job(), READY),
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
        v.run(sampleNamespace, job(), READY),
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
          v.run(sampleNamespace, job(), READY),
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
          v.run(sampleNamespace, job(), READY),
        ).pipe(Effect.provide(rt.layer));
        expect(result?.outcome).toBe("abstain");
        const [document] = [...rt.store.documents.values()];
        expect(JSON.parse(String(document))).toMatchObject({
          credentialScan: { token: 2, expiry: 2, remote: 0, host: 0, literal: 0 },
        });
      }),
  );

  it.effect(
    "[no-runner.gave-up] abstains when the engine gives up (unavailable), when the log is a stream, and on an empty log",
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
            v.run(sampleNamespace, job(), READY),
          ).pipe(Effect.provide(runtime(runner).layer));
          expect(result?.outcome).toBe("abstain");
        }
        // A runner the engine gave up on had a runner: its box was unavailable.
        const [gaveUp] = yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, job(), READY),
        ).pipe(
          Effect.provide(
            runtime(async () => {
              throw new Error("runner failed after its retries");
            }).layer,
          ),
        );
        expect(gaveUp?.failure).toBe("unavailable");
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
          v.run(sampleNamespace, job(), READY),
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

  it("[box.outlasts-deploy] a step in a box is tried again for at least five minutes, so a keel-verify deploy and keel's after it cut no step for good, and at most three times, so a hung command costs four of its deadlines", () => {
    const runStep = { ...step, run: { command: "pnpm test", timeoutMs: 1_200_000 } };
    for (const retries of [
      SUITE_CONFIG.retries,
      tier2RunnerFor(runStep)?.config.retries,
      DEPS_BUILD_STEP.retries,
    ]) {
      if (retries === undefined) throw new Error("a step with a command has no runner");
      // On 15 Oct 01:00 the two deploys took 100 s, and a rollout's last step comes after them.
      expect(retryWaitMs(retries)).toBeGreaterThanOrEqual(5 * 60_000);
      expect(retries.limit).toBeLessThanOrEqual(3);
    }
  });

  it.effect(
    "[capacity.lease] a Tier 2 step holds a lease named for its job and step while its runner runs, for every attempt's deadline and the waits between, and gives it back after, even when the engine gave up; a step with no runner takes none",
    () =>
      Effect.gen(function* () {
        const green = yield* Effect.promise(() => runnerStdout(3, 0, "3 passed"));
        for (const runner of [
          stdoutRunner(green),
          (async () => {
            throw new Error("runner failed after its retries");
          }) satisfies SuiteRunner,
        ]) {
          const l = ledger();
          let heldWhileRunning = false;
          const rt = runtime(async (options) => {
            heldWhileRunning = l.asked.length === 1 && l.released.length === 0;
            return runner(options);
          }, l.boxes);
          const j = job();
          yield* Effect.flatMap(VerifierRuntime, (v) => v.run(sampleNamespace, j, READY)).pipe(
            Effect.provide(rt.layer),
          );
          expect(heldWhileRunning).toBe(true);
          expect(l.asked).toEqual([
            { holder: `${sampleNamespace}/${j.jobId}/${step.id}`, ttlMs: boxHoldMs(SUITE_CONFIG) },
          ]);
          expect(boxHoldMs(SUITE_CONFIG)).toBeGreaterThan(
            SUITE_CONFIG.timeout * (SUITE_CONFIG.retries.limit + 1),
          );
          expect(l.released).toEqual(["lease-1"]);
        }
        const none = ledger();
        yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, { ...job(), steps: [{ ...step, id: "other.suite" }] }, READY),
        ).pipe(Effect.provide(runtime(stdoutRunner(""), none.boxes).layer));
        expect(none.asked).toEqual([]);
      }),
  );

  it.effect(
    "[capacity.never-stops] a lease refused, or a gate that throws, still runs the step: the ledger only counts",
    () =>
      Effect.gen(function* () {
        const green = yield* Effect.promise(() => runnerStdout(3, 0, "3 passed"));
        for (const answer of ["refuse", "throw"] as const) {
          const l = ledger(answer);
          const rt = runtime(stdoutRunner(green), l.boxes);
          const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
            v.run(sampleNamespace, job(), READY),
          ).pipe(Effect.provide(rt.layer));
          expect(result?.outcome).toBe("pass");
          expect(rt.calls).toHaveLength(1);
          expect(l.released).toEqual([]);
        }
      }),
  );

  it.effect(
    "[no-runner.tier2] abstains as no runner's on a step it has no command for, without starting a runner",
    () =>
      Effect.gen(function* () {
        const rt = runtime(stdoutRunner(""));
        const results = yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, { ...job(), steps: [{ ...step, id: "other.suite" }] }, READY),
        ).pipe(Effect.provide(rt.layer));
        expect(results.map((r) => [r.outcome, r.failure])).toEqual([["abstain", "no-runner"]]);
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
    expect(lines.findIndex((l) => l.includes("keel_deps_fetch $K /workspace"))).toBeLessThan(tsc);
    expect(lines.findIndex((l) => l.includes("KEEL_TSCONFIG none"))).toBeLessThan(tsc);
  });

  it.effect(
    "[runner.typecheck-routed] runs worker-app.typecheck as its own command and fails it naming tsc's errors",
    () =>
      Effect.gen(function* () {
        const stdout = yield* Effect.promise(() => typecheckStdout(1, TSC_RED));
        const rt = runtime(stdoutRunner(stdout));
        const [result] = yield* Effect.flatMap(VerifierRuntime, (v) =>
          v.run(sampleNamespace, typecheckJob(), READY),
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
        v.run(sampleNamespace, typecheckJob(), READY),
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
          v.run(sampleNamespace, typecheckJob(), READY),
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

/** Both Tier 2 steps in one job. */
const both = (): VerificationJob => ({ ...job(), steps: [step, typecheck] });

/** Runs both Tier 2 steps handed `handed`, and reads back what each stored. */
const handedTo = (handed: DepsAnswer) =>
  Effect.gen(function* () {
    const rt = runtime(stdoutRunner(""));
    const results = yield* Effect.flatMap(VerifierRuntime, (v) =>
      v.run(sampleNamespace, both(), handed),
    ).pipe(Effect.provide(rt.layer));
    const stored = yield* Effect.forEach(results, (r) =>
      Effect.flatMap(EvidenceStore, (s) =>
        s.get(sampleNamespace, Schema.decodeUnknownSync(ContentHash)(r.resultRef)),
      ),
    ).pipe(Effect.provide(rt.layer));
    return { rt, results, stored };
  });

describe("a Tier 2 step and the deps its Workflow ensured", () => {
  it.effect(
    "[suite-runtime.deps-parts] hands each runner its deps parts' URLs in order, each signed for the namespace's own part and for a step's life",
    () =>
      Effect.gen(function* () {
        const rt = runtime(stdoutRunner(""));
        yield* Effect.flatMap(VerifierRuntime, (v) => v.run(sampleNamespace, both(), READY)).pipe(
          Effect.provide(rt.layer),
        );
        expect(rt.calls).toHaveLength(2);
        for (const options of rt.calls) {
          const urls = (options.env["KEEL_DEPS_PARTS"] ?? "").split(" ").map((u) => new URL(u));
          expect(urls.map((u) => `${u.origin}${u.pathname}`)).toEqual(
            PARTS.map((part) => `https://deps.keel.internal/${X}/${part.sha256}`),
          );
          for (const [i, url] of urls.entries()) {
            const part = PARTS[i]?.sha256 ?? "";
            const signedFor = (namespace: string, sha256: string, now: number) =>
              Effect.promise(() =>
                depsPartUrlSigned(KEYS.publicKey, namespace, sha256, url.searchParams, now),
              );
            expect(url.searchParams.get("exp")).toBe("1800");
            expect(yield* signedFor(X, part, 1_800)).toBe(true);
            expect(yield* signedFor(X, part, 1_801)).toBe(false);
            expect(yield* signedFor(Y, part, 0)).toBe(false);
            expect(yield* signedFor(X, "f".repeat(64), 0)).toBe(false);
          }
        }
      }),
  );

  it.effect(
    "[suite-runtime.deps-refused] fails every Tier 2 step handed refused deps, asks no runner, and stores the reason with what to do",
    () =>
      Effect.gen(function* () {
        const reason = "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE";
        const { rt, results, stored } = yield* handedTo({ _tag: "DepsRefused", reason });
        expect(rt.calls).toEqual([]);
        expect(rt.steps).toEqual(["js-ts.suite:evidence", "worker-app.typecheck:evidence"]);
        expect(results.map((r) => [r.stepId, r.outcome, r.durationMs])).toEqual([
          ["js-ts.suite", "fail", 0],
          ["worker-app.typecheck", "fail", 0],
        ]);
        expect(results.map((r) => r.evidenceClass)).toEqual([
          step.evidenceCeiling,
          typecheck.evidenceCeiling,
        ]);
        expect(stored).toEqual(
          ["js-ts.suite", "worker-app.typecheck"].map((stepId) => ({
            stepId,
            outcome: "fail",
            why: `deps-refused: ${reason}`,
            tail: "",
            deps: {
              refused: reason,
              remedy:
                "the installer refused the lockfile (ERR_PNPM_OUTDATED_LOCKFILE): run pnpm install and commit the pnpm-lock.yaml it writes",
            },
          })),
        );
        expect(depsRemedy(reason)).toBe(
          "the installer refused the lockfile (ERR_PNPM_OUTDATED_LOCKFILE): run pnpm install and commit the pnpm-lock.yaml it writes",
        );
      }),
  );

  it.effect(
    "[suite-runtime.deps-unavailable] abstains every Tier 2 step handed unavailable deps, or none, asks no runner, and stores why",
    () =>
      Effect.gen(function* () {
        const reason = "install-failed exit 1 ERR_PNPM_FETCH_503";
        const down = yield* handedTo({ _tag: "DepsUnavailable", reason });
        expect(down.rt.calls).toEqual([]);
        expect(down.results.map((r) => [r.stepId, r.outcome])).toEqual([
          ["js-ts.suite", "abstain"],
          ["worker-app.typecheck", "abstain"],
        ]);
        expect(down.stored).toEqual(
          ["js-ts.suite", "worker-app.typecheck"].map((stepId) => ({
            stepId,
            outcome: "abstain",
            why: `deps-unavailable: ${reason}`,
            tail: "",
          })),
        );
        const none = yield* handedTo({ _tag: "DepsUnneeded" });
        expect(none.rt.calls).toEqual([]);
        expect(none.results.map((r) => r.outcome)).toEqual(["abstain", "abstain"]);
        expect(none.stored.map((d) => Schema.decodeUnknownSync(Why)(d).why)).toEqual([
          "deps-unavailable: no deps were ensured for this step",
          "deps-unavailable: no deps were ensured for this step",
        ]);
      }),
  );

  it("[suite-runtime.deps-in-place] every Tier 2 command fetches the deps after hydrating and before its tool, stops on a bundle that is not put there, switches pnpm's own install off, and drops the deps before every end that follows", () => {
    for (const [command, tool] of [
      [JS_TS_SUITE_COMMAND, "node_modules/vitest/vitest.mjs run"],
      [TYPECHECK_COMMAND, "node_modules/typescript/bin/tsc --noEmit"],
      [projectCommand({ command: "pnpm test", timeoutMs: 1 }), "sh $K/command.sh"],
    ] as const) {
      const lines = command.split("\n");
      const at = (text: string) => lines.findIndex((l) => l.includes(text));
      expect(command).not.toContain("/opt/forge-deps");
      expect(command).not.toContain("KEEL_LOCK");
      expect(at("keel_deps_fetch() {")).toBeGreaterThan(-1);
      expect(at("keel_deps_drop() {")).toBeGreaterThan(-1);
      const fetch = lines.indexOf(
        'why=$(keel_deps_fetch $K /workspace ${KEEL_DEPS_PARTS:-}) || { keel_deps_drop /workspace; echo "KEEL_DEPS missing $why"; echo KEEL_END; exit 0; }',
      );
      expect(fetch).toBeGreaterThan(at('keel_hydrate $K "${KEEL_BUNDLE_URL:-}"'));
      // The parts' URLs hold a `?` and are expanded unquoted: no glob is read while they are.
      expect(lines[fetch - 1]).toBe("set -f");
      expect(lines[fetch + 1]).toBe("set +f");
      expect(lines[fetch + 2]).toBe("echo KEEL_DEPS ok");
      // [suite-runtime.no-deps-check] The name pnpm 11 reads, as tried in the box's image: npm_config_* and .npmrc are not read.
      expect(lines[fetch + 3]).toBe("export pnpm_config_verify_deps_before_run=false");
      expect(fetch + 3).toBeLessThan(at(tool));
      // Every KEEL_END after the fetch has the deps dropped before it, on its own line or the same one.
      const ends = lines.flatMap((l, i) => (i > fetch && l.includes("echo KEEL_END") ? [i] : []));
      expect(ends.length).toBeGreaterThan(0);
      for (const end of ends)
        expect(
          lines[end - 1] === "keel_deps_drop /workspace" ||
            (lines[end] ?? "").includes("keel_deps_drop /workspace; "),
        ).toBe(true);
    }
  });
});

describe("a step command of the project's own", () => {
  const run = { command: "pnpm gen && pnpm test", timeoutMs: 600_000 };
  const own = (id = "keel.check") => ({
    ...step,
    id,
    tier: { tier: 2 as const, reason: "a command of the project's own runs in a container" },
    run,
  });
  const ranWith = (stdout: string, id?: string) =>
    Effect.gen(function* () {
      const rt = runtime(stdoutRunner(stdout));
      const results = yield* Effect.flatMap(VerifierRuntime, (v) =>
        v.run(sampleNamespace, { ...job(), steps: [own(id)] }, READY),
      ).pipe(Effect.provide(rt.layer));
      const documents = [...rt.store.documents.values()].map(String);
      return { rt, results, documents };
    });

  it.effect(
    "[suite-runtime.project-command] runs the plan's command in one runner, given the step's time, judges it by its exit and stores why",
    () =>
      Effect.gen(function* () {
        for (const [exit, outcome, why] of [
          [0, "pass", "the command exited 0"],
          [3, "fail", "the command exited 3"],
          [137, "abstain", "the command was killed by signal 9 (exit 137)"],
        ] as const) {
          const { rt, results, documents } = yield* ranWith(
            commandStdout(exit, "FAIL a.test.ts\n"),
          );
          expect(results.map((r) => [r.stepId, r.outcome])).toEqual([["keel.check", outcome]]);
          expect(
            rt.calls.map((c) => [c.name, c.command, c.config.commandTimeoutMs, c.config.timeout]),
          ).toEqual([["keel.check", projectCommand(run), 600_000, 660_000]]);
          expect(rt.steps).toEqual(["keel.check:evidence"]);
          expect(documents.map((d) => JSON.parse(d))).toEqual([
            {
              stepId: "keel.check",
              outcome,
              why,
              exit,
              tail: "FAIL a.test.ts\n",
              credentialScan: { token: 0, expiry: 0, remote: 0, host: 0, literal: 0 },
            },
          ]);
          expect(results[0]?.resultRef).toBeDefined();
        }
      }),
  );

  it.effect(
    "[suite-runtime.project-command-wins] a step that reuses a pack's id with a command of its own runs its command, not the pack's",
    () =>
      Effect.gen(function* () {
        const { rt, results } = yield* ranWith(commandStdout(0), "js-ts.suite");
        expect(rt.calls.map((c) => c.command)).toEqual([projectCommand(run)]);
        expect(results.map((r) => r.outcome)).toEqual(["pass"]);
      }),
  );

  it.effect(
    "[suite-runtime.project-command-leak] a tail holding a secret abstains, and the stored evidence never holds it",
    () =>
      Effect.gen(function* () {
        const { results, documents } = yield* ranWith(commandStdout(0, `account ${ACCOUNT}\n`));
        expect(results.map((r) => r.outcome)).toEqual(["abstain"]);
        expect(documents).toHaveLength(1);
        expect(documents[0]).not.toContain(ACCOUNT);
        expect(JSON.parse(documents[0] ?? "{}").why).toMatch(/^credential-leak: /);
      }),
  );

  it("[suite-runtime.command-decodes] the plan's command is in the runner's command only as base64, and the box's own decode gives it back byte for byte", () => {
    const tricky = `printf '%s\\n' "it's $HOME" && echo "\u00fcn\u00ef \u20ac" \`date\`\nexit 3`;
    const command = projectCommand({ command: tricky, timeoutMs: 1 });
    expect(command).not.toContain("it's");
    const line = command.split("\n").find((l) => l.includes("| base64 -d >$K/command.sh"));
    if (line === undefined) throw new Error("no decode line");
    const decoded = execFileSync("sh", ["-c", line.replace(" >$K/command.sh", "")], {
      encoding: "utf8",
    });
    expect(decoded).toBe(tricky);
  });
});

/** A JUnit report with one failing test, named as the box saw it, with this failure message. */
const reportXml = (name: string, message: string) =>
  `<testsuite><testcase classname="/workspace/test/a.test.ts" name="${name}"><failure message="${message}"/></testcase></testsuite>`;

describe("a step command's JUnit report", () => {
  const report = { junit: "out/junit.xml" };

  it("[suite-runtime.command-report] the report is read back after the command, its path only as base64, and removed before the deps are dropped; a step naming none reads none", () => {
    expect(projectCommand({ command: "pnpm test", timeoutMs: 1 })).not.toContain("KEEL_REPORT");
    const command = projectCommand({ command: "pnpm test", timeoutMs: 1, report });
    const lines = command.split("\n");
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(command).not.toContain("out/junit.xml");
    const path = lines[at("R=$(echo ")] ?? "";
    expect(execFileSync("sh", ["-c", `${path}; printf %s "$R"`], { encoding: "utf8" })).toBe(
      "out/junit.xml",
    );
    expect(at("R=$(echo ")).toBeGreaterThan(at('echo "KEEL_TAIL'));
    expect(lines.slice(at("R=$(echo ") + 1, at("R=$(echo ") + 5)).toEqual([
      'if [ -L "$R" ] || [ ! -f "$R" ]; then echo "KEEL_REPORT none missing";',
      `elif [ "$(wc -c <"$R" | tr -d ' ')" -gt 4194304 ]; then echo "KEEL_REPORT none too-large";`,
      'else echo "KEEL_REPORT $(gzip -c "$R" | base64 -w0)"; fi',
      'rm -f "$R"',
    ]);
    expect(at('rm -f "$R"')).toBe(lines.lastIndexOf("keel_deps_drop /workspace") - 1);
  });

  it.effect(
    "[suite-runtime.command-report-judged] a fail cites its report's failing tests relative to the candidate, and only those names are scanned for credentials",
    () =>
      Effect.gen(function* () {
        const named = { ...step, run: { command: "pnpm test", timeoutMs: 1, report } };
        const cited = yield* judgeCommandOutput(
          named,
          yield* Effect.promise(() =>
            commandReportStdout(1, reportXml("a > breaks", `saw ${ACCOUNT}`)),
          ),
          [ACCOUNT],
        );
        expect([cited.report.outcome, cited.evidence.failing, cited.evidence.why]).toEqual([
          "fail",
          [{ file: "test/a.test.ts", test: "a > breaks" }],
          "the command exited 1; its JUnit report names 1 failing test",
        ]);
        expect(JSON.stringify(cited.document)).not.toContain(ACCOUNT);
        const leaked = yield* judgeCommandOutput(
          named,
          yield* Effect.promise(() => commandReportStdout(1, reportXml(`a > ${ACCOUNT}`, "x"))),
          [ACCOUNT],
        );
        expect([leaked.report.outcome, leaked.evidence.why]).toEqual([
          "abstain",
          expect.stringMatching(/^credential-leak: /),
        ]);
        expect(JSON.stringify(leaked.document)).not.toContain(ACCOUNT);
      }),
  );
});

/** The reason a stored evidence document gives. */
const Why = Schema.Struct({ why: Schema.String });
