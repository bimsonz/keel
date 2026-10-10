# S26: Probe drafting

Run on 2026-10-10 against the live edge (Workers AI and Dynamic Workers). Code is in [`spikes/26-probe-drafting/`](../../spikes/26-probe-drafting/). Raw per-draft records, including every drafted probe, are in `spikes/26-probe-drafting/results/`.

## Answer

**PASS, at the bar, for `@cf/moonshotai/kimi-k2.7-code`: 8 of 10 drafts admitted, none vacuous. GO, with a template-first design and a non-synchronous model call.**

- **Kimi K2.7 Code passes.**
  - **8/10 drafts admitted** (95% Wilson 0.49–0.94). All 8 were first-shot, with no repair attempt used, and all 8 fail against mutant A, so none is vacuous.
  - **2 losses.** One draft was lost to the platform: three `AiError: 3046: Request timeout` at about 235 s each, with no draft produced. One draft mishandled n/a: it used the revoke route in its warm-up, before its n/a guard.
  - **The platform timeout dominates latency.** 7 of the 10 drafts hit at least one timeout, so draft p50 is 430 s even though a single successful generation takes about 110–225 s.
- **Qwen 2.5 Coder 32B: 0/10** (95% 0.00–0.28).
  - **Runtime errors.** 7 drafts crash with a `TypeError` inside the test, such as `clock.advance` on the system clock, or a malformed `Request` init. The contract scores that as `fail` in every world, so it is never fed back.
  - **Repairs.** The repair loop cleared 3 of 7 bundle errors and 3 of 4 load errors.
- **GLM-5.3 and DeepSeek V4 Flash 0731 never answered.** All 15 calls (3 for GLM, 12 for DeepSeek) ended in `3046: Request timeout` at about 235 s. They are unmeasured, not failed.
- **The freshness template** was built and measured even though Kimi met the bar. In it the model fills only actors, setup, the call, the revoke and the call-again.
  - **Kimi: 10/10**, all non-vacuous, with a model p50 of 60 s and no timeouts.
  - **Qwen: 9/10** with template v2, against 0/10 free-form. Template v1 managed 2/10, because the model re-created the users that the template already creates. One deterministic slot rule fixed it, and its schema error was repaired in 9 of 9 cases.
- **The vacuity gate is necessary.** A hand-written probe that tests "no caching" instead of revocation passes the world matrix (n/a, pass, n/a, fail) and is caught only by mutant A, where it passes 3 out of 3 times. No model draft was vacuous.
- **Cost per draft** for Kimi free-form is about $0.046 for the model, with tokens priced uncached, plus $0.027 in Tier 1 unique-isolate charges. With the template it is $0.029 plus $0.030.

**Fallback taken:** none was required, because Kimi met the bar. The template is implemented and measured anyway, and the recommendation is **template-first**: use a predicate template wherever one exists (freshness does), and free-form drafting only for predicates without one. Both go through the same matrix, admission rule and mutant gate.

## Question

Can a pinned Workers AI code model, reached through `PlatformFunction` (single-shot and schema-constrained), draft forge-lite's S-1 probe? Its inputs are the two propositions, the anchors and the relevant source. It gets at most 3 repair attempts, each driven by deterministic error text.

The drafted probe:
- runs in Tier 1, on a fresh isolate id, across base, A, B and A+B;
- follows the probe exit-code contract: 0 pass, 1 fail, 3 n/a, 2 harness error, plus exactly one JSON line `{"outcome":…,"reason":…}`.

Compare at least 2 pinned models, with 10 independent drafts each.

**Pass:** at least 8 of 10 drafts are **admitted**, and **no admitted draft passes vacuously**. Admitted means:
- pass in A;
- fail in A+B;
- `n/a` on base and in B;
- stable over 3 runs in each world.

**Fallback:** a predicate-specific freshness template (call, then revoke, then call again) whose slots the model fills.

## Setup

**Host Worker `keel-spike-26-probe`** ([`src/index.ts`](../../spikes/26-probe-drafting/src/index.ts)). It has these bindings:
- `AI`, for Workers AI;
- `LOADER`, for Dynamic Workers;
- `VerifierDO`, a SQLite Durable Object.

Endpoints:
- `/setup` stores the worlds and the drafting input in a registry DO.
- `/draft` runs the whole draft-and-repair loop for one draft and streams the result as NDJSON, with a heartbeat every 10 s, because one draft can take minutes.
- `/evaluate` runs a given probe over the worlds; it is used for the can-fail probes.

Each draft gets its own evaluator DO, which spreads CPU, since one DO is one CPU (S14). Requests need a per-spike token header. A second Worker, `keel-spike-26-probe-tpl`, ran the same code in template mode. It was kept separate so that redeploying it couldn't reset the DOs of jobs in flight.

**`draftProbe`** ([`src/draft.ts`](../../spikes/26-probe-drafting/src/draft.ts)) mirrors the `PlatformFunction` port in `packages/core`.
- **One call.** Each attempt is one `env.AI.run(model, …)` with `response_format: {type: "json_schema", json_schema: {name, schema, strict: true}}`. Qwen 2.5 Coder uses the older `{type: "json_schema", json_schema: <schema>}` form.
- **The output schema** is `{files: {"probe.test.ts": string}, rationale: string}`, with `additionalProperties: false`.
- **Abstaining.** A reply that doesn't parse, or doesn't validate against the schema, abstains; it is never patched up.
- **Platform failures** (a thrown `AiError`) are retried twice with back-off. They don't count as attempts.

**The model ids are exact catalogue ids.** They were taken from `wrangler ai models list --json` on the day, with no `auto`, AI Gateway or route in between. Where the catalogue offers a date-versioned id (DeepSeek) the versioned form was used. The other ids have no dated variant in the catalogue: their version is in the name.

| Model id (exact, pinned) | Role | Call shape | Settings | Draft runs (UTC, 2026-10-10) |
|---|---|---|---|---|
| `@cf/moonshotai/kimi-k2.7-code` | free-form, 10 drafts | chat-completions, `json_schema` strict; reasoning always on | temperature 0.6, `max_completion_tokens` 32000, no seed | started 20:36:31–20:47:42 |
| `@cf/moonshotai/kimi-k2.7-code` | template v2, 10 drafts | same, template schema | same | started 20:52:32–20:54:17 |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | free-form, 10 drafts | legacy `{response}`, `json_schema` | temperature 0.6, `max_tokens` 4096, no seed | started 20:36:31–20:38:28 |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | template v1, then v2, 10 drafts each | same, template schema | same | v1 20:41:07–20:41:37; v2 20:47:45–20:48:21 |
| `@cf/deepseek-ai/deepseek-v4-flash-0731` | free-form, stopped after 4 drafts | chat-completions, `json_schema` strict | temperature 0.6, `max_completion_tokens` 32000 | started 20:38:08–20:38:09, stopped 20:51:10 |
| `@cf/zai-org/glm-5.3` | smoke, 1 draft | chat-completions, `json_schema` strict | temperature 0.6, 16000 | 20:25:33 |

Every Kimi response's `model` field was exactly the pinned id, `@cf/moonshotai/kimi-k2.7-code`. The legacy Qwen shape doesn't report one, and DeepSeek and GLM never answered. Catalogue prices, in USD per million input/output tokens: Kimi 0.95/4.00 (cached input 0.19), DeepSeek V4 Flash 0.44/1.32, Qwen 2.5 Coder 0.66/1.00, GLM-5.3 1.40/4.40.

**The prompt** ([`src/prompt.ts`](../../spikes/26-probe-drafting/src/prompt.ts)) is a system line plus one user message, 67,402 characters (about 16.8k tokens by Kimi's count). Its sections, in order:
1. the task;
2. the propositions, as JSON (A's premise `{subject: "authz.permission-evaluation", predicate: "freshness", relation: "<=", value: "per-request"}`, and B's derived effect, freshness = per-session);
3. the anchors, as JSON (`requirePermission` in `src/authz/require-permission.ts`, and A's revoke route);
4. **the worlds and the admission rule**, including "it must also fail if A's revoke step were made to do nothing";
5. the n/a rule (Hono's default 404: `text/plain`, `404 Not Found`; a handler's problem+json 404 is not absence);
6. the probe contract;
7. every base `src/` file except `src/index.ts` (25 files, 53,363 characters);
8. the `src/` hunks of `a.patch` and `b.patch` (8,900 characters), without their prose headers or test files.

The hand-written probe `scenarios/s1/probe.test.ts`, `run-probe.mjs` and the scenarios README are never part of the prompt. [`scripts/worlds.ts`](../../spikes/26-probe-drafting/scripts/worlds.ts) builds it.

**The repair loop** ([`src/loop.ts`](../../spikes/26-probe-drafting/src/loop.ts)) makes one call, then up to 3 repairs. Each repair appends the model's previous reply and a user message containing the deterministic error text verbatim, deduplicated and **without world names**.

Fed back:
- esbuild bundle errors;
- runner harness errors (exit 2);
- a missing or invalid JSON line;
- an abstention's schema error.

Not fed back: a wrong outcome in any world. The loop stops as soon as an evaluation yields no deterministic error.

**The Tier 1 runner** ([`src/child/runner.js`](../../spikes/26-probe-drafting/src/child/runner.js)) is `run-probe.mjs` ported into the isolate. It runs on the S14 vitest shim, copied unchanged: real `@vitest/expect` 5.
- **Inputs.** It runs the one probe file and collects the `[probe] …` console lines as observations.
- **Output.** It prints them, then exactly one JSON line, with exit 0, 1, 3 or 2.
- **n/a** is a single failing test whose error matches `^Error: probe not applicable: (.+)$`.
- **Harness errors** (exit 2): the file fails to load; there isn't exactly one test; the test was skipped; it passed without an observation.

The host ([`src/outcome.ts`](../../spikes/26-probe-drafting/src/outcome.ts)) then checks the JSON line. It must be the last line and the only line that parses as a JSON object, with exactly `outcome` and `reason`, and it must agree with the exit code. If not, the run is a harness error: `missing JSON line` or `invalid JSON line`. A child that throws, times out after 30 s or answers non-200 is also `missing JSON line`.

**Bundling.** [`src/bundle.ts`](../../spikes/26-probe-drafting/src/bundle.ts) uses `@cloudflare/worker-bundler` 0.2.6. `installDependencies` (hono plus the shim's deps) runs once per host isolate and is reused. After that, one `createWorker` per world takes the world's `src/`, the probe at `probe/probe.test.ts` and the runner as entry. The bundle is about 466 KB.

Every run is `LOADER.get(<fresh uuid id>)` with:
- `globalOutbound: null`;
- `limits: {cpuMs: 30000, subRequests: 5}`;
- at most 4 runs in flight per DO.

**Worlds.** [`scripts/worlds.ts`](../../spikes/26-probe-drafting/scripts/worlds.ts) copies the fixture into scratch and applies the patches there with `git apply`:
- `base`;
- `A` = `a.patch`;
- `B` = `b.patch`;
- `AB` = `a.patch` + `b.patch`;
- `mutantA`.

In **`mutantA`**, A's revoke handler keeps its route, its checks and its `204`, but `store.removeCollaborator(...)` is replaced by a no-op. Locally, the fixture's own `run-probe.mjs` gives the expected `n/a / pass / n/a / fail` on the first four, and `fail` on `mutantA`.

**Admission** ([`src/admission.ts`](../../spikes/26-probe-drafting/src/admission.ts)) applies the rule above over 3 runs per world. Any bundle or harness error rejects the draft.

**The vacuity check** has two parts:
1. **The gate.** The final draft runs 3 times against `mutantA` and must fail every time. Passing there means it passes with the revoke step removed.
2. **The flag.** [`scripts/static-check.ts`](../../spikes/26-probe-drafting/scripts/static-check.ts), on the TypeScript AST, flags any DELETE request whose response is never referenced inside an `expect(...)`.

**The fallback template** ([`src/template.ts`](../../spikes/26-probe-drafting/src/template.ts)) has the model fill only these slots:
- `owner` and `subject`;
- `setup` steps;
- `call`, `revoke` and `callAgain`, each `{actor, method, path, body, expectedStatus}`.

The probe is rendered deterministically from the slots. The template creates and signs in both actors, does each actor's requests on one session, and decides n/a itself. The world matrix and admission are unchanged.

Tooling: wrangler 4.149.0, `@cloudflare/worker-bundler` 0.2.6, `@cloudflare/workers-types` 5.20261008.1, TypeScript 6.0.3, vitest 5.0.3, oxlint 1.87.0. The compatibility date is `2026-10-01`.

```sh
pnpm install --ignore-workspace
node scripts/worlds.ts ../../fixtures/forge-lite <scratch>
pnpm exec wrangler deploy && printf %s "$TOKEN" | pnpm exec wrangler secret put SPIKE_TOKEN
BASE=https://keel-spike-26-probe.<subdomain>.workers.dev TOKEN=... node scripts/drive.ts setup <scratch>
node scripts/drive.ts draft kimi @cf/moonshotai/kimi-k2.7-code openai 10 5 results/drafts/kimi-k2.7-code 0.6 32000
node scripts/drive.ts eval probes/vacuous.test.ts results/canfail/vacuous.json
node scripts/report.ts results/drafts --reeval
```

## Results: drafts per model

Produced by `node scripts/report.ts results/drafts` (full output in `results/report.txt`). "Admitted" means the final draft meets the admission rule. "Vacuous" means it does not fail 3 out of 3 times against mutant A. Intervals are 95% Wilson.

| Model | Mode | Admitted | 95% CI | Admitted and non-vacuous | Attempts used (1/2/3/4) | Failure modes of the rest | Model time per draft, p50 (max) | Tokens per draft, in / out (mean) | Model cost per draft | Tier 1 cost per draft |
|---|---|---|---|---|---|---|---|---|---|---|
| **kimi-k2.7-code** | free-form | **8/10** | 0.49–0.94 | **8** | 10/0/0/0 | 1 platform timeout (3×3046), 1 n/a mishandled | 430 s (720 s) | 15,125 / 7,910 | $0.046 | $0.027 |
| qwen2.5-coder-32b-instruct | free-form | 0/10 | 0.00–0.28 | 0 | 4/2/3/1 | 7 runtime error in every world, 2 setup assertion in every world, 1 compile error after 3 repairs | 56 s (129 s) | 37,103 / 1,909 | $0.026 | $0.056 |
| deepseek-v4-flash-0731 | free-form | 0/4 completed | — | — | — | 4 platform timeouts (12×3046); run stopped | 720 s | 0 / 0 | $0 | $0 |
| glm-5.3 | smoke | 0/1 completed | — | — | — | 1 platform timeout (3×3046) | 721 s | 0 / 0 | $0 | $0 |
| **kimi-k2.7-code** | template v2 | **10/10** | 0.72–1.00 | **10** | 9/1/0/0 | — | 60 s (105 s) | 18,343 / 2,794 | $0.029 | $0.030 |
| qwen2.5-coder-32b-instruct | template v2 | **9/10** | 0.60–0.98 | **9** | 1/9/0/0 | 1 setup assertion in every world | 26 s (29 s) | 32,171 / 741 | $0.022 | $0.030 |
| qwen2.5-coder-32b-instruct | template v1 | 2/10 | 0.06–0.51 | 2 | 10/0/0/0 | 8 setup assertion in every world (`409` re-creating users) | 20 s (24 s) | 16,717 / 507 | $0.012 | $0.030 |

Notes on the table:

- **Prompt tokens** are summed over every attempt, because each repair re-sends the conversation. That is why Qwen's free-form figure is 37k.
- **Model cost** uses uncached input prices. Kimi reported 16,768 cached prompt tokens on later drafts, so its real cost is lower. Whether calls that timed out are billed is not known.
- **Tier 1 cost** is 12 fresh isolate ids per evaluation plus 3 for mutant A, at $0.002 each (S14, finding 10).
- **Kimi latency is mostly the platform timeout.**
  - The three calls that never timed out took 109, 225 and 223 s.
  - Every other Kimi draft carries 1 or 2 timeouts of about 235 s each (12 in total, across 7 drafts). For example: `kimi-05` 446 s with 1 retry, `kimi-10` 714 s with 2.
  - A single Kimi generation used 5.2k–10.5k completion tokens, including 17k–40k characters of reasoning.

**The Kimi free-form drafts** (`results/drafts/kimi-k2.7-code/`):

```
kimi-01.json: infra-error att=1      AiError: 3046: Request timeout ×3, 720 s
kimi-02.json: admitted att=1 base=n/a/n/a/n/a A=pass/pass/pass B=n/a/n/a/n/a AB=fail/fail/fail vacuous=false
  ... kimi-03 … kimi-08 and kimi-10: the same row
kimi-09.json: rejected att=1 base=fail/fail/fail A=pass/pass/pass B=fail/fail/fail AB=fail/fail/fail vacuous=false
```

All 8 admitted drafts follow the same scenario, which the model found on its own:
1. an owner, a private (or admin-gated) repository, and an admin collaborator;
2. the collaborator's session makes a request first, which warms B's cache;
3. the owner revokes, with the Hono-default-404 check placed straight after;
4. `expect(revoke.status).toBe(204)`;
5. the same session tries again, and must be refused.

What each admitted draft observed against mutant A, its run 1:

```
collab GET /repos/owner/repo/collaborators -> 200 (expected 404)
target GET /repos/owner/repo -> 200 (expected 404)
target PUT /repos/owner/repo/collaborators/third -> 201 (expected 404)
target GET /repos/owner/secretrepo/collaborators -> 200 (expected 404)
target GET /repos/owner/probe -> 200 (expected 404)
bob GET /repos/alice/test-repo -> 200 (expected 404)
target GET /repos/owner/repo -> 200 (expected 404)
```

`kimi-09` was rejected for **mishandling n/a**. Its warm-up step was `target DELETE /repos/owner/repo/collaborators/victim`, which is itself the revoke route, followed by `expect(204)`. That came *before* its n/a guard. On base and B the warm-up therefore fails on Hono's 404 and never reaches the guard: `fail` × 3 in both worlds, not `n/a`.

**Qwen free-form**: each final draft and the error it hits in world A (from the `--reeval` re-run of every rejected draft):

```
qwen-01  TypeError: deps.clock.advance is not a function
qwen-02  Error: login failed
qwen-03  TypeError: app.request(...).json is not a function
qwen-04  AssertionError: expected 404 to be 200         (GET /repos/repo_1/read)
qwen-05  bundle: ERROR: Expected ")" but found "DELETE"  (after 3 repairs)
qwen-06  TypeError: Failed to construct 'Request': constructor parameter 2 is not of type 'RequestInitializerDict or Request'.
qwen-07  TypeError: clock.advance is not a function
qwen-08  TypeError: Failed to construct 'Request': ...
qwen-09  TypeError: Cannot destructure property 'token' of '(intermediate value)' as it is undefined.
qwen-10  AssertionError: expected 401 to be 201
```

Each of these fails the same way in all four worlds: the probe never reaches its measurement.

**Smoke run (first prompt shape).** Before the measured runs, one draft per model ran on a 55,001-character prompt holding 17 hand-picked source files (`results/smoke/`).

- **Kimi** drafted a structurally correct probe, which failed in every world with `owner POST /users -> 422 (expected 201)`. The password rule (`MIN_PASSWORD_LENGTH = 10`, in `src/domain/names.ts`) wasn't among the files it was given.
- **The fix.** The measured prompt carries all of `src/` except `src/index.ts`.
- **GLM-5.3** timed out 3 times, taking 720 s.

## Results: the fallback template

The template renders a probe from the slots ([`src/template.ts`](../../spikes/26-probe-drafting/src/template.ts)). Example slots from `kimi-tpl-01`:

```
setup:     owner POST /repos {"name":"probe-repo","visibility":"private"} 201
           owner PUT /repos/owner/probe-repo/collaborators/subject {"role":"admin"} 201
call:      subject GET /repos/owner/probe-repo 200
revoke:    owner DELETE /repos/owner/probe-repo/collaborators/subject 204
callAgain: subject GET /repos/owner/probe-repo 404
```

**Template v1 → v2.**
- **The v1 failure.** In 8 of 10 v1 drafts, Qwen also put `POST /users` and `POST /sessions` in `setup`, so every world failed on `expected 409 to be 201`. The scenario itself was right: a private repository, `GET` before the revoke and `404` after.
- **The v2 fix.** v2 adds one deterministic slot rule: "setup[i] calls /users: the template already creates both users and signs each in; setup must not". The schema error abstains, and the loop feeds it back.
- **The result.** Qwen went from 2/10 to 9/10, and the error was cleared in 9 of 9 cases. Kimi on v2 broke a different slot rule once, "owner and subject must differ", and cleared it on the next attempt.

**Rollout race.** The first v2 batch started within seconds of the redeploy finishing. Its first four drafts were evaluated by the previous version: their `setup` carried `/users` and was not refused. That batch was discarded whole and rerun; the discarded records were kept out of `results/`.

## Results: the repair loop

| Error class fed back | Example (verbatim) | Fed back | Cleared on the next attempt |
|---|---|---|---|
| Bundle (esbuild) | `bundling probe/probe.test.ts failed: Build failed with 1 error: virtual:probe/probe.test.ts:6:9: ERROR: No matching export in "virtual:src/domain/visibility.ts" for import "RepoVisibility"` | 7 (Qwen) | 3 |
| Load error (exit 2) | `{"outcome":"fail","reason":"probe harness error: expected exactly one probe test, found 0: TypeError: deps.clock.advance is not a function"}` | 4 (Qwen) | 3 |
| Schema (abstain) | `the reply does not match the output schema: setup[0] calls /users: the template already creates both users and signs each in; setup must not` | 10 (template) | 10 |
| Missing or invalid JSON line, test count, skipped, no observation | — | 0 from models | — |

**The same `TypeError` is repairable or not depending on where it is thrown.**
- Thrown at module scope, it is a load error: exit 2, fed back.
- Thrown inside the test, it is a test failure: `fail`, not fed back.

7 of Qwen's 10 final drafts sit in the second case.

Kimi needed no repair in free-form mode. Its drafts never hit a bundle, harness or JSON-line error.

## Pass/fail

| Criterion | Result | Evidence |
|---|---|---|
| ≥ 8/10 drafts admitted for the best model | **PASS (8/10), with no margin** | Kimi K2.7 Code; 95% CI 0.49–0.94. One of the two misses is a platform timeout, not a bad draft. |
| No admitted draft passes vacuously | **PASS** | 8/8 Kimi free-form, 10/10 Kimi template and 9/9 Qwen template admitted drafts fail 3/3 against mutant A. The static flag fires on no admitted draft. |
| ≥ 2 pinned models compared, 10 drafts each | **PASS for 2** | Kimi and Qwen, 10 each. DeepSeek (4 drafts) and GLM (1) could not be measured because of platform timeouts. |
| Fallback measured if the best model is < 8/10 | **Not required**; measured anyway | Template v2: Kimi 10/10, Qwen 9/10. |

## Go/no-go

**GO for probe drafting**, with three conditions:

1. **Template-first.** Where a predicate template exists, the model fills slots:
   - Kimi 10/10, and even Qwen 9/10;
   - about 7× faster for Kimi (p50 60 s against 430 s);
   - cheaper;
   - n/a handled by construction.

   Free-form drafting (Kimi 8/10) is for predicates without a template. Admission and the mutant gate are the same for both.
2. **Don't drive reasoning models through a synchronous `env.AI.run`.** The platform cuts the request at about 235 s (`3046`):
   - it lost 1 Kimi draft;
   - it added 12 timeouts across 7 of the 10 Kimi drafts;
   - it made GLM-5.3 and DeepSeek V4 Flash unusable here.

   The `PlatformFunction` adapter needs a streaming or asynchronous transport, or a time budget per call and a retry policy. **Streaming is untested.**
3. **Pin Kimi K2.7 Code** (`@cf/moonshotai/kimi-k2.7-code`) for free-form drafting. Qwen 2.5 Coder is not good enough without a template.

## Fallback

The freshness template (call, revoke, call again on the same session) is implemented in [`src/template.ts`](../../spikes/26-probe-drafting/src/template.ts) and served by the same `/draft` endpoint with `mode: "template"`. It was measured on both models (table above). It is the recommended primary path for freshness, not just a fallback.

## Design-relevant findings

1. **The synchronous Workers AI call times out at about 235 s.** `AiError: 3046: Request timeout`:
   - Kimi: 12 times, across 7 of 10 drafts;
   - DeepSeek V4 Flash 0731: 12 of 12 calls;
   - GLM-5.3: 3 of 3 calls.

   A successful Kimi generation takes 109–225 s, right at the limit. Retrying after a timeout works, but costs 4–12 minutes of wall time per draft.

   Untested ways round it: `stream: true`, `reasoning_effort: "low"` for GLM and DeepSeek, and an async or queued path. Keel's drafter needs one of these, plus a wall-clock budget per draft.
2. **Prompt shape: give all the source, and the whole admission rule.**
   - **A curated excerpt broke setup.** It left out the input-validation rules, and the draft failed at its own setup in every world (`422`).
   - **All of `src/` fits.** 53 KB, about 15k tokens, fits even a 32k-context model.
   - **Spelling out the rule worked.** The prompt states the worlds' expected outcomes, the exact n/a signal, the observation format, and "it must also fail if A's revoke step were made to do nothing". Kimi's drafts all asserted the revoke's `204` and then made a decisive call on the warm session after it.
   - **No hand-written probe was shown.** Neither the reference probe nor the scenario write-up was in the prompt.
3. **What is repairable.**
   - **Schema errors:** 10 of 10.
   - **Load errors:** 3 of 4.
   - **esbuild errors:** 3 of 7.
   - **Runtime errors inside the test can't be repaired under the `run-probe` contract.** They score as `fail`, which is "evidence" and so is never fed back. That was 7 of Qwen's 10 final drafts.
   - **Two remedies, both untested:**
     - (a) make "compile" include a typecheck. S14 measured TypeScript in an isolate at about 3 s, and it would have caught `clock.advance` on `Clock`, `app.request("DELETE", …)` and `.json()` on a promise.
     - (b) feed back a failure that is **identical in all four worlds**. It carries no evidence that tells worlds apart, because every world fails at the same step.
4. **n/a mishandling has one shape:** the precondition was used before the n/a guard (`kimi-09`). The template rules it out by construction. For free-form drafting, a static rule ("the first request to the precondition route is followed by the n/a guard") would catch it. That rule is untested.
5. **The vacuity gate has to be mutant A; the matrix alone is not enough.** `probes/lookup-count.test.ts` counts the store's collaborator lookups. It uses the revoke route only to decide n/a, and it never tests revocation. The matrix admits it; mutant A rejects it. No model draft was vacuous, but the gate is what lets that be claimed.
6. **The static "no expect on the DELETE outcome" flag is a heuristic.**
   - **Two false positives, both fixed:**
     - a logging helper `log("owner", "DELETE", …)`;
     - a response variable reassigned with `res = await …`.
   - **It is blind to template probes**, whose method comes from data. They assert the revoke status by construction anyway.
   - **Keep it as a flag.** The mutant run is the gate.
7. **A template must refuse, deterministically, any slots that duplicate its own steps.** One such rule took Qwen from 2/10 to 9/10.
8. **Results need the evaluator's code version.** A redeploy took seconds to reach every request, and four drafts were judged by the old validator. Keel should stamp each verdict with the verifier version that produced it.
9. **Capable models don't use the repair loop for free-form probes.** Kimi used 0 repairs in 10 drafts. The loop's value showed with the weaker model and with the template's schema rule.

## Can-fail demonstrations

Every row runs through the deployed Worker's `/evaluate`: Tier 1 on the edge, fresh isolates, 3 runs per world. Raw output is in `results/canfail/`.

| Check | Probe | Result on the edge |
|---|---|---|
| Reference probe admitted | fixture `scenarios/s1/probe.test.ts` (imports rewritten `../../src/` → `../src/`) | base n/a×3, A pass×3, B n/a×3, A+B fail×3 (`bob DELETE /repos/alice/forge -> 204 (expected 403)`), mutant A fail×3. **admitted, non-vacuous**, static flag clean |
| Vacuous probe rejected | `probes/vacuous.test.ts`: `expect(true).toBe(true)` | pass×3 in every world. **Rejected** (`n/a-mishandled, wrong-world-behaviour`); mutant A passes, so it is vacuous |
| Ignoring the n/a rule is rejected on base and B | `probes/ignores-na.test.ts` | base and B: `fail`×3, `alice DELETE …/collaborators/bob -> 404 (expected 204)`. **Rejected** (`n/a-mishandled`) |
| Flaky probe rejected | `probes/flaky.test.ts`: the right scenario plus `expect(Math.random() < 0.5).toBe(true)` | A: `fail/pass/pass` (`AssertionError: seeded random failure`). **Rejected** (`flaky`) |
| The matrix can admit a vacuous probe; mutant A catches it | `probes/lookup-count.test.ts` | base n/a, A pass, B n/a, A+B fail (`1 lookups (expected 2)`), so **the matrix admits it**. Mutant A: pass×3, **vacuous** |
| Static flag | `probes/no-revoke-expect.test.ts` (the revoke response is never asserted) | flag fires (`line 44: call("DELETE", ".../collaborators/bob", alice)`); still non-vacuous, since mutant A fails |
| JSON-line check | `probes/json-observation.test.ts` (logs `[probe] {"status":403}`) | exit 2 in every run: `invalid JSON line: expected exactly one JSON line, found 2: {"status":403} \| {"outcome":"pass",…}` |
| Harness error | `probes/two-tests.test.ts` | exit 2: `expected exactly one probe test, found 2` |
| Admission unit tests | `admit()` forced to `admitted: true` | 4 of 14 vitest tests fail (`rejects a probe that passes everywhere`, `…ignores the n/a rule…`, `…flaky…`, `…fewer than three runs…`). Reverted: 14/14 pass |
| Lint | the first version of the spike | `oxlint` gave 5 errors (`consistent-function-scoping` ×4, `prefer-string-starts-ends-with`). Fixed: exit 0. `tsc --noEmit` exit 0 |

The repair loop's own evidence that it can fail: it cleared 3 of 7 bundle errors and 3 of 4 load errors, not all of them, and `qwen-05` used all 4 attempts and still ended on `Expected ")" but found "DELETE"`.

## Untested

- **Other transports:** `stream: true`, async/queued inference, and `reasoning_effort` settings, any of which might avoid the 235 s timeout for Kimi, GLM-5.3 and DeepSeek.
- **Other models:** the remaining catalogue models (DeepSeek V4 Pro 0813, Qwen 3.8 27B, GLM-5.3 Flash, gpt-oss-120b).
- **Typecheck as part of "compile"**, and feeding back world-invariant failures (finding 3).
- **Other scenarios:** whether the drafts generalise to S-2 (`careless.patch`, the A+B+B′ worlds) or to other predicates. Only S-1 was drafted.
- **Billing:** whether timed-out Workers AI calls are billed.
- **Seeds:** none was set, so the drafts are independent samples and can't be replayed byte for byte.

## Teardown

Both Workers were deleted, and their Durable Object namespaces with them. The spike created no R2, KV, D1 or queue resources, and Workers AI keeps none. The local `.wrangler/` state was removed. The account ID and the workers.dev subdomain are redacted below.

```
$ wrangler delete --name keel-spike-26-probe --force      -> Successfully deleted keel-spike-26-probe
$ wrangler delete --name keel-spike-26-probe-tpl --force  -> Successfully deleted keel-spike-26-probe-tpl

$ wrangler deployments list --name keel-spike-26-probe
✘ [ERROR] A request to the Cloudflare API (/accounts/<account>/workers/scripts/keel-spike-26-probe/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
$ wrangler deployments list --name keel-spike-26-probe-tpl
✘ [ERROR] ... This Worker does not exist on your account. [code: 10007]
curl https://keel-spike-26-probe.<subdomain>.workers.dev/prompt      -> HTTP 404
curl https://keel-spike-26-probe-tpl.<subdomain>.workers.dev/prompt  -> HTTP 404
GET /accounts/<account>/workers/scripts                              -> 250 scripts, 0 matching keel-spike-26
GET /accounts/<account>/workers/durable_objects/namespaces           -> 197 namespaces, 0 for keel-spike-26
```

No `keel-spike-26-*` resources remain.

