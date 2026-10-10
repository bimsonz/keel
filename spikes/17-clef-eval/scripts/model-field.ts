// Experiments on the request contract: the `model` field, determinism, and
// whether option/key order reaches the model at all.
import { run, save, MODELS } from "./client.ts";

const state = {
  hunks: [
    {
      file: "src/authz/check.ts",
      diff: "@@ -10,6 +10,12 @@\n+const cache = new Map<string, boolean>();\n export async function canPerform(sessionId: string, repoId: string, action: string) {\n+  const key = sessionId + \":\" + repoId + \":\" + action;\n+  if (cache.has(key)) return cache.get(key)!;\n   const allowed = await evaluate(repoId, action);\n+  cache.set(key, allowed);\n   return allowed;\n }",
    },
  ],
  symbols: [{ name: "cache", kind: "const", status: "added" }],
};
const criteria = {
  "per-call": "Recomputed on every call.",
  "per-request": "Computed once per request.",
  "per-session": "Reused for a session.",
  ttl: "Cached until a TTL expires.",
  static: "Computed once at startup.",
  unclear: "Cannot tell.",
};
const reversed = Object.fromEntries(Object.entries(criteria).toReversed());
const q = (c: Record<string, string>) => ({
  f: { type: "choice", instructions: "What is the freshness of permission evaluation after this change?", criteria: c },
});
const stateReordered = { symbols: state.symbols, hunks: state.hunks };

const cases: { name: string; endpoint: string; input: Record<string, unknown> }[] = [
  { name: "clef-endpoint/model=clef", endpoint: MODELS.clef, input: { model: "clef", state, questions: q(criteria) } },
  { name: "clef-endpoint/model=clef (repeat)", endpoint: MODELS.clef, input: { model: "clef", state, questions: q(criteria) } },
  { name: "clef-endpoint/model=clef-flash", endpoint: MODELS.clef, input: { model: "clef-flash", state, questions: q(criteria) } },
  { name: "flash-endpoint/model=clef-flash", endpoint: MODELS["clef-flash"], input: { model: "clef-flash", state, questions: q(criteria) } },
  { name: "flash-endpoint/model=clef-flash (repeat)", endpoint: MODELS["clef-flash"], input: { model: "clef-flash", state, questions: q(criteria) } },
  { name: "flash-endpoint/model=clef", endpoint: MODELS["clef-flash"], input: { model: "clef", state, questions: q(criteria) } },
  { name: "clef-endpoint/model omitted", endpoint: MODELS.clef, input: { state, questions: q(criteria) } },
  { name: "clef-endpoint/model=' clef '", endpoint: MODELS.clef, input: { model: " clef ", state, questions: q(criteria) } },
  { name: "clef-endpoint/model=bogus", endpoint: MODELS.clef, input: { model: "clef-omni", state, questions: q(criteria) } },
  { name: "clef/criteria keys reversed", endpoint: MODELS.clef, input: { model: "clef", state, questions: q(reversed) } },
  { name: "flash/criteria keys reversed", endpoint: MODELS["clef-flash"], input: { model: "clef-flash", state, questions: q(reversed) } },
  { name: "clef/state keys reordered", endpoint: MODELS.clef, input: { model: "clef", state: stateReordered, questions: q(criteria) } },
  { name: "flash/state keys reordered", endpoint: MODELS["clef-flash"], input: { model: "clef-flash", state: stateReordered, questions: q(criteria) } },
];

const out = [];
for (const c of cases) {
  const r = await run(c.endpoint, c.input);
  const a = r.output?.answers.f as { choice: string; probabilities: Record<string, number>; confidence: number } | undefined;
  const row = {
    name: c.name,
    status: r.status,
    ok: r.ok,
    ms: r.ms,
    model: r.output?.model,
    choice: a?.choice,
    probabilities: a?.probabilities,
    probabilityKeyOrder: a ? Object.keys(a.probabilities) : undefined,
    confidence: a?.confidence,
    usage: r.output?.usage,
    error: r.error,
  };
  out.push(row);
  console.log(JSON.stringify(row));
}
save("model-field.json", out);
