// Runs every guard against the real workspace. Exit 1 on any violation,
// including a vacuous run (too few files read, or the canary missing).
import { formatResult } from "../guard.ts";
import { allChecks as guards } from "../registry.ts";
import { repoRoot } from "../scan.ts";

const root = repoRoot();
let failed = 0;
for (const guard of guards) {
  const result = await guard.run(root);
  console.log(formatResult(result));
  if (result.violations.length > 0) failed += 1;
}
console.log(failed === 0 ? `\nall ${guards.length} guards passed` : `\n${failed} guard(s) failed`);
process.exit(failed === 0 ? 0 : 1);
