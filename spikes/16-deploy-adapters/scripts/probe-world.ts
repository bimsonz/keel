// Prints which world a URL serves (stateless classify) and, with --flow, the
// end-to-end revoke flow.
//
//   node scripts/probe-world.ts <base-url> [--flow] [--expect base|A]
//
// With --expect, exits 1 when the classified world differs.
import { classify, revokeFlow } from "./world.ts";

const args = process.argv.slice(2);
const baseUrl = args[0];
if (!baseUrl) {
  console.error("usage: node scripts/probe-world.ts <base-url> [--flow] [--expect base|A]");
  process.exit(2);
}
const expectIdx = args.indexOf("--expect");
const expected = expectIdx >= 0 ? args[expectIdx + 1] : undefined;

const c = await classify(baseUrl);
console.log(JSON.stringify({ classify: c }));
if (args.includes("--flow")) console.log(JSON.stringify({ flow: await revokeFlow(baseUrl) }));
if (expected && c.world !== expected) {
  console.error(`MISMATCH: expected world ${expected}, got ${c.world}`);
  process.exit(1);
}
