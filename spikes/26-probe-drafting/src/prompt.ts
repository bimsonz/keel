// The draftProbe prompt. It is built only from the propositions, the anchors,
// the base source and the patch hunks. The fixture's hand-written probe and the
// scenario write-up are never part of it.
import { templatePrompt } from "./template.ts";

export interface DraftInput {
  propositions: Record<string, unknown>;
  anchors: unknown[];
  /** Base-tree source excerpts, path -> text. */
  sources: Record<string, string>;
  /** src/ hunks of each patch, label -> unified diff. */
  hunks: Record<string, string>;
}

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "object",
      properties: { "probe.test.ts": { type: "string", description: "The complete probe file." } },
      required: ["probe.test.ts"],
      additionalProperties: false,
    },
    rationale: { type: "string", description: "One paragraph: what the probe does and why it tells the worlds apart." },
  },
  required: ["files", "rationale"],
  additionalProperties: false,
} as const;

export const SYSTEM = [
  "You draft probes for a code-review platform. A probe is a small, deterministic vitest test that checks one premise",
  "about a codebase by exercising the application. You answer with a single JSON object that matches the output schema,",
  "and nothing else.",
].join(" ");

const CONTRACT = `## Probe contract

- The probe is the file \`probe/probe.test.ts\`. The application source sits beside it in \`src/\`, so import with
  relative paths such as \`../src/app.ts\` (keep the \`.ts\` extension). Import only files that exist in the base tree:
  the same file must bundle in all four worlds.
- Import the test API from \`"vitest"\`: \`describe\`, \`it\`, \`expect\`. The file holds exactly one test. Do not use
  \`.skip\`, \`.todo\`, \`.only\`, \`vi.mock\`, fake timers, snapshots, \`expect.poll\` or \`test.extend\`.
- Build a fresh application inside the test with \`createApp\` from \`src/app.ts\` and in-memory dependencies, and drive it
  only through \`app.request(path, init)\`. No network, no timers, no randomness, no Node built-ins.
- Outcomes:
  - **pass**: the test passes. The premise held.
  - **fail**: an \`expect\` assertion fails. The premise was broken.
  - **n/a**: the premise's precondition is absent. Signal it by throwing \`new Error("probe not applicable: <reason>")\`
    (a plain \`Error\`, with exactly that prefix). Never return early instead.
- Observations: log each step that decides the outcome as one line,
  \`console.log("[probe] <actor> <METHOD> <path> -> <status> (expected <status>)")\`. A probe that passes must have logged
  at least one \`[probe]\` line. Observation text must not be JSON.
- The runner prints the observations, then exactly one JSON line \`{"outcome":"pass"|"fail"|"n/a","reason":"..."}\`, and
  exits 0 for pass, 1 for fail, 3 for n/a, and 2 for a harness error: the file does not load, it does not hold exactly
  one test, the test is skipped, or it passes without an observation.`;

function fenced(lang: string, text: string): string {
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}

export function userPrompt(input: DraftInput, mode: "probe" | "template" = "probe"): string {
  const sources = Object.entries(input.sources).map(([path, text]) => `### ${path}\n\n${fenced("ts", text)}`).join("\n\n");
  const hunks = Object.entries(input.hunks).map(([label, diff]) => `### ${label}\n\n${fenced("diff", diff)}`).join("\n\n");
  return `# Draft a probe

Two changes, A and B, hold incompatible beliefs about the same subject. A relies on a premise; B's change has a derived
effect that contradicts it. Draft a probe that guards A's premise: a test that proves the disagreement by behaving
differently in the worlds below.

## Propositions

${fenced("json", JSON.stringify(input.propositions, null, 2))}

## Anchors

${fenced("json", JSON.stringify(input.anchors, null, 2))}

## Worlds and admission

The probe runs unchanged in four worlds. Each is the base tree with patches applied: **base** (neither patch), **A**
(A's patch only), **B** (B's patch only) and **A+B** (both). It is admitted as a guard only if it:

- passes in **A**, where the premise holds and its precondition exists;
- fails in **A+B**, where B's effect breaks the premise;
- reports n/a on **base** and in **B**, where the precondition is absent;
- gives the same outcome on each of 3 runs, each in a fresh isolate.

It must also fail if A's revoke step were made to do nothing, so it has to depend on the revoke actually taking effect.

## The n/a rule

The precondition is the revoke route that A adds: \`DELETE /repos/:owner/:repo/collaborators/:username\`. Where the
route is absent, a request to it is answered by Hono's default not-found response: status 404, content-type
\`text/plain\`, body exactly \`404 Not Found\`. That response, and only that response, means n/a. A 404 that a route
handler returns is \`application/problem+json\`, and is not absence.

${mode === "probe" ? CONTRACT : templatePrompt()}

## Source (base tree)

${sources}

## Patch hunks (src/ only)

${hunks}

## Output

${mode === "probe" ? OUTPUT_PROBE : "Reply with the slots as one JSON object, as described in the fallback section above."}`;
}

const OUTPUT_PROBE = 'Reply with one JSON object: `{"files": {"probe.test.ts": "<the complete file>"}, "rationale": "<one paragraph>"}`.';

export function repairPrompt(errors: string, mode: "probe" | "template" = "probe"): string {
  return `The probe could not be evaluated. This is the deterministic error output, verbatim:

${fenced("text", errors)}

${mode === "probe" ? "Fix the probe and reply with the complete corrected file, in the same JSON shape." : "Fix the slots and reply with the complete JSON object, in the same shape."}`;
}
