// The command of prove:red's baseline control. It stands in for a test file
// whose claimed test fails with no mutant applied: it writes a vitest-shaped
// JSON report to the --outputFile the runner asks for, with one failing test
// that carries the tag, and exits 1. The patch beside it changes only the
// title's wording, so the failure is never the patch's doing.
import { writeFileSync } from "node:fs";

const wording = "fails before any patch is applied";

const flag = "--outputFile=";
const report = process.argv.find((arg) => arg.startsWith(flag))?.slice(flag.length);
if (report === undefined) {
  console.error("red-without-mutant: the runner must ask for a report with --outputFile");
  process.exit(2);
}
writeFileSync(
  report,
  JSON.stringify({
    testResults: [
      {
        assertionResults: [
          {
            fullName: `prove:red's control [control.red-without-mutant] ${wording}`,
            status: "failed",
          },
        ],
      },
    ],
  }),
);
process.exit(1);
