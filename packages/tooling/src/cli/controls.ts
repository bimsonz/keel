// Runs every guard against its control fixture, exactly as it runs against the
// real tree. Every control is a deliberate violation, so every guard must go
// red here. Exit 1 when they all do (the expected, red outcome); exit 2 if any
// control stayed green, because a rule that cannot fail is not a check.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatResult } from "../guard.ts";
import { guards } from "../registry.ts";
import { repoRoot } from "../scan.ts";

const root = repoRoot();
const inert: string[] = [];
for (const guard of guards) {
  const control = join(root, "test/controls", guard.name);
  if (!existsSync(control)) {
    console.log(`MISSING control for ${guard.name}: test/controls/${guard.name}`);
    inert.push(guard.name);
    continue;
  }
  const result = guard.run(control, {
    skip: [],
    vacuity: { minFiles: 1, canary: guard.controlCanary },
  });
  console.log(formatResult({ ...result, rule: `${guard.name} ← control` }));
  if (result.violations.length === 0) inert.push(guard.name);
}
if (inert.length > 0) {
  console.log(`\nINERT: these controls did not go red: ${inert.join(", ")}`);
  process.exit(2);
}
console.log(`\nall ${guards.length} controls went red, as they must`);
process.exit(1);
