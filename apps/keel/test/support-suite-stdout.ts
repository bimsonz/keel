// The suite command's stdout for a forge-lite-shaped run, for tests that stand
// in for a Tier 2 runner (unit and pool): markers, a base64 tail, and vitest's
// JSON report gzipped and base64'd, exactly as the command prints them. Also
// the typecheck command's, with tsc's output gzipped and base64'd.
import { SUITE_PROTOCOL, TYPECHECK_PROTOCOL } from "@keeltown/core/application/verification";

const b64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

const gzip = async (text: string) =>
  new Uint8Array(
    await new Response(
      new Blob([new TextEncoder().encode(text)])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

/** `tests` tests in one file, the first `failed` of them failing with `message`. */
export const suiteStdout = async (
  tests: number,
  failed: number,
  options: { readonly tail?: string; readonly message?: string } = {},
): Promise<string> => {
  const report = {
    success: failed === 0,
    numTotalTests: tests,
    numPassedTests: tests - failed,
    numFailedTests: failed,
    testResults: [
      {
        name: "/workspace/test/sessions.test.ts",
        status: failed > 0 ? "failed" : "passed",
        assertionResults: Array.from({ length: tests }, (_, i) => ({
          fullName: `sessions test ${i}`,
          status: i < failed ? "failed" : "passed",
          failureMessages: i < failed ? [options.message ?? "expected 401, received 200"] : [],
        })),
      },
    ],
  };
  return [
    SUITE_PROTOCOL,
    "KEEL_HYDRATION ok",
    "KEEL_LOCK ok",
    `KEEL_EXIT ${failed > 0 ? 1 : 0}`,
    "KEEL_DURATION_MS 4600",
    `KEEL_TAIL ${b64(new TextEncoder().encode(options.tail ?? `${tests - failed} passed`))}`,
    `KEEL_REPORT ${b64(await gzip(JSON.stringify(report)))}`,
    "KEEL_END",
    "",
  ].join("\n");
};

/** The typecheck command's stdout for a run of tsc that exited `exit` and printed `output`. */
export const typecheckStdout = async (exit: number, output: string): Promise<string> =>
  [
    TYPECHECK_PROTOCOL,
    "KEEL_HYDRATION ok",
    "KEEL_LOCK ok",
    "KEEL_TSCONFIG ok",
    `KEEL_EXIT ${exit}`,
    "KEEL_DURATION_MS 2100",
    `KEEL_OUTPUT_BYTES ${new TextEncoder().encode(output).length}`,
    output.length === 0 ? "KEEL_OUTPUT none" : `KEEL_OUTPUT ${b64(await gzip(output))}`,
    "KEEL_END",
    "",
  ].join("\n");
