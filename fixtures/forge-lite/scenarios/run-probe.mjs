// Runs the revocation probe (scenarios/s1/probe.test.ts) and reports exactly
// one outcome as a single JSON line on stdout:
//
//   {"outcome":"pass","reason":"..."}   exit 0
//   {"outcome":"fail","reason":"..."}   exit 1
//   {"outcome":"n/a","reason":"..."}    exit 3
//
// Before the JSON line it prints the probe's own observations (the "[probe]"
// lines), such as "bob DELETE /repos/alice/forge -> 204 (expected 403)".
//
// The probe can only pass by running to its last assertion and reporting
// Bob's DELETE on the way. It is n/a only when it throws its own marked error,
// which it does only for Hono's default not-found on the revoke route. If the
// harness itself breaks (no report, no test, a skipped test, a pass with no
// observation) the outcome is "fail" with exit 2, so a broken probe can never
// look like a pass. Set PROBE_VERBOSE=1 to see vitest's full output.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT = { pass: 0, fail: 1, "n/a": 3 };
const HARNESS_ERROR = 2;
const NOT_APPLICABLE = /^Error: probe not applicable: (.+)$/m;
const OBSERVATION = /^\[probe\] (.*)$/gm;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-lite-probe-"));
const reportPath = join(scratch, "report.json");

function finish(outcome, reason, exitCode = EXIT[outcome]) {
  process.stdout.write(`${JSON.stringify({ outcome, reason })}\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(exitCode);
}

function harnessError(reason, output) {
  process.stderr.write(output);
  finish("fail", `probe harness error: ${reason}`, HARNESS_ERROR);
}

const run = spawnSync(
  join(root, "node_modules", ".bin", "vitest"),
  [
    "run",
    "--config",
    "scenarios/vitest.probe.config.ts",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportPath}`,
  ],
  { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } },
);
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
if (process.env.PROBE_VERBOSE === "1") process.stderr.write(output);

const observations = [...(run.stdout ?? "").matchAll(OBSERVATION)].map((match) => match[1]);
for (const line of observations) process.stdout.write(`${line}\n`);

if (run.error) harnessError(`could not start vitest: ${run.error.message}`, output);
if (!existsSync(reportPath)) harnessError(`vitest wrote no report (exit ${run.status})`, output);

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const tests = report.testResults.flatMap((file) => file.assertionResults);
if (tests.length !== 1) {
  const fileErrors = report.testResults.map((file) => file.message).filter(Boolean).join("; ");
  harnessError(`expected exactly one probe test, found ${tests.length}${fileErrors ? `: ${fileErrors}` : ""}`, output);
}

const [test] = tests;
const failure = test.failureMessages.join("\n");
const bobDelete = observations.findLast((line) => line.startsWith("bob DELETE"));

if (test.status === "passed") {
  if (bobDelete === undefined) harnessError("the probe passed without reporting bob's DELETE", output);
  finish("pass", `${bobDelete}; alice/forge still exists`);
}

if (test.status === "failed") {
  const notApplicable = NOT_APPLICABLE.exec(failure);
  if (notApplicable) finish("n/a", notApplicable[1]);
  // Name the first step that answered differently from what the premise expects.
  const mismatch = observations.find((line) => {
    const statuses = /-> (\d+)\b.*\(expected (\d+)\)$/.exec(line);
    return statuses !== null && statuses[1] !== statuses[2];
  });
  finish("fail", mismatch ?? (failure.split("\n")[0] || "the probe failed"));
}

harnessError(`the probe test was ${test.status}`, output);
