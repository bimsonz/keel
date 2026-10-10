# S17: Clef evaluation (Clef vs Clef-flash)

Run on 2026-10-10 against the live Workers AI binding from a deployed Worker, `keel-spike-17-clef`, which has since been deleted. The code is in `spikes/17-clef-eval/`, the dataset in `docs/spikes/s17-dataset.json`, and the raw outputs in `spikes/17-clef-eval/results/`.

## Question

How good are `@cf/cloudflare/clef` (27B) and `@cf/cloudflare/clef-flash` (9B) at Keel's one model task? The task: read structured facts about a diff and choose the effect's lattice value for a premise's subject and predicate, with `unclear` among the options. Keel's own code then compares that value with the premise on the lattice. The spike measures:

- recall and precision;
- the decoy false-positive rate;
- agreement under permuted options;
- truncation handling;
- latency;
- the rate limit.

**Pass:** recall ≥ 90% at the chosen threshold, permuted agreement ≥ 95%, and every truncation detected. The demo also needs a decoy FP rate ≤ 20%.
**Fallback:** deterministic extractors and lattices only; Clef ranks probes and nothing more.

## Answer

**GO for Clef (27B) as the opinion layer, with conditions. NO-GO for Clef-flash, so there is no Flash first pass.**

| | Clef | Clef-flash |
|---|---|---|
| Recall on contradictions, Keel rule t=0.5 (joint / separate) | **100% / 100%** (22/22) | 95.5% / 95.5% (21/22) |
| Precision at the same point | **100% / 100%** | 95.5% / 95.5% |
| Decoy FP rate (limit 20%) | **0% / 0%** | 10% / 10% (D02) |
| Permuted agreement: chosen value equal in all 3 orders | **95.0%** / 92.5% | 90.0% / 92.5% |
| Flip rate: pairwise chosen-value changes | 3.3% / 5.0% | 6.7% / 5.0% |
| Verdict agreement: same lattice verdict in all 3 orders | 97.5% / 100% | 97.5% / 95.0% |
| `unclear` share of answers | 0% / 0% | 4.2% / 3.3% |
| v0 value accuracy against the hand-derived effect | 95.0% / 92.5% | 87.5% / 87.5% |
| Latency, 1 question per call, p50 / p95 (in Worker) | 236 / 465 ms | 227 / 852 ms |
| Latency, 3 questions per call, p50 / p95 | 281 / 483 ms (94 / 161 ms per question) | 335 / 1,050 ms (112 / 350 ms per question) |
| Latency, 64 questions per call, p50 / p95 | 1,856 / 1,996 ms (29 / 31 ms per question) | 3,624 / 5,225 ms (57 / 82 ms per question) |
| Effective input cap (measured) | **64,000** tokens (docs: 65,536) | **24,000** tokens (docs: 24,576; changelog: 64K) |
| Truncation reported by the service | no; tail cut silently, `usage.input_tokens` = cap | no; same, plus error 5021 at about 2.8× the cap |
| Rate limit | not reached: 180 requests ramping to 10 rps, 0 × 429 | not reached: same |

"Joint" asks the three permuted variants as three questions in one call, which is how Keel would batch them. "Separate" asks each variant in its own call. The Keel rule ("keel-mass") was fixed before the run. It flags a contradiction only if **every** permutation puts at least t of its probability mass on lattice values that violate the premise, and it abstains on any `unclear`.

The permuted-agreement criterion is met **only by Clef in joint mode, and only exactly at the bar**: 38/40, Wilson 95% interval 83.5–98.6%. Clef in separate mode is 37/40, which is a **fail**. Flash fails in both modes. Every Clef disagreement is between adjacent values on the same side of the premise, apart from one, D02 in joint mode, which the Keel rule turns into an abstention. This is why the go comes with conditions (see Go/no-go).

## Setup

- **Worker.** `src/worker.ts` is an authenticated pass-through: a bearer secret set with `wrangler secret put`, and an `ai` binding `AI`. It times `env.AI.run` inside the Worker, so latency excludes the client's round trip. It was deployed with wrangler 4.149.0 and `compatibility_date` 2026-10-01, and `account_id` comes from the environment only.
- **Driver.** Node 22 scripts under `scripts/`, run with `node <script>.ts` (type stripping). The Worker URL and token come from `S17_URL` / `S17_TOKEN` and are never written to disk. The driver is paced to at most 2 concurrent calls with 300 ms spacing, and retries on 429; 0 retries happened.
- **Request shape**, built the way Keel would (`src/questions.ts`):
  - `state` is `{hunks: [{file, language, diff}], symbols: [...]}`;
  - one `choice` question with object `instructions` `{task, subject, predicate, scope}`;
  - `criteria` hold every lattice value plus `unclear`, each with a one-line meaning.
  - The premise **value** is never sent, so the model cannot anchor on it.
- **Permutations.** v0 is lattice order with `unclear` last; v1 and v2 are two distinct seeded shuffles. See finding 1 for why the shuffle is carried in the option **ids** (`a-per-call`, `c-per-session`, …) rather than in key order.
- **Calls.** 168 per model for the evaluation: 40 joint, 120 separate and 8 × 64-question. On top of that, 13 contract probes, 26 truncation probes and 360 burst calls.

```
$ node scripts/eval.ts
clef-flash: 168 calls in 71.4 s, 0 errors
clef: 168 calls in 55.9 s, 0 errors
```

## Dataset (`docs/spikes/s17-dataset.json`)

There are 40 items: **30 core** (22 contradictions and 8 compatible effects on the same subject) and **10 decoys**, all compatible. Of the decoys, 5 are a same-subject compatible value and 5 use the same vocabulary on a different subject. Primary languages: TypeScript 11, Python 12, Go 10, HCL 4, C 3; one Go item also carries a SQL migration.

| Predicate | Lattice (strong → weak) | Contra | Compat | Decoy |
|---|---|---|---|---|
| freshness | per-call < per-request < per-session < ttl < static | 4 | 1 | 3 |
| cardinality | exactly-one < at-most-one < many | 2 | 1 | 2 |
| ordering | fifo < per-key-fifo < unordered | 2 | 1 | 1 |
| consistency | strong < read-your-writes < eventual | 2 | 1 | 1 |
| presence | required < optional < absent | 3 | 1 | 0 |
| authority | owner < admin < maintainer < member < authenticated < anyone | 3 | 1 | 0 |
| purity | pure < idempotent < non-idempotent | 2 | 1 | 1 |
| bound | le-1 < le-10 < le-100 < le-1k < … < unbounded | 2 | 1 | 1 |
| shape | flat lattice compared with `=` (integer, number, string, boolean, array, object) | 2 | 0 | 1 |

- **Premise relation.** All premises use `≤` (the effect may be no weaker than the premise value), except `shape`, which uses `=`.
- **Labels.** Effects are derived by hand from each diff. The label is then **computed** with `compare()` in `src/lattice.ts`, and the build fails if it disagrees with the written label (see the can-fail demonstrations). No label came from a model.
- **Sources.** Diffs are `spikes/17-clef-eval/dataset/diffs/<id>.diff` and the metadata is `dataset/items.ts`. The build recomputes the `@@` hunk counts and indents Go with tabs.
- **forge-lite S-1 pair (C01).** Premise: `authz.permission-evaluation` freshness ≤ per-request. The change adds a module-level `permissionCache` keyed by `sessionId + "|" + repoId` and cleared only at logout. Effect: per-session, so the label is contradiction. Its near misses are D01, a per-request role memo created in middleware, and D06, a per-session cache of UI theme preferences next to an unchanged `canPerform` call.

## Request contract findings

`node scripts/model-field.ts` produces `results/model-field.json`, trimmed below:

```
clef-endpoint/model=clef            ok  model=clef  per-session {per-session:0.6689,...} input_tokens=359
clef-endpoint/model=clef (repeat)   ok  identical probabilities
clef-endpoint/model=clef-flash      AiError/InferenceUpstreamError "5012: ... Unsupported model 'clef-flash'. Use 'clef'."
flash-endpoint/model=clef           AiError/InferenceUpstreamError "5012: ... Unsupported model 'clef'. Use 'clef-flash'."
clef-endpoint/model omitted         ok  model=clef, identical probabilities
clef-endpoint/model=' clef '        ok  (whitespace allowed by the pattern)
clef-endpoint/model=bogus           "5006: Error: '/model' failed test ^\s*(clef|clef-flash)\s*$ patttern"
clef/criteria keys reversed         ok  identical probabilities (only the key order of the returned map follows the request)
flash/criteria keys reversed        ok  identical probabilities
clef|flash/state keys reordered     ok  identical probabilities
```

- `model` is redundant with the endpoint. When present it must match, or the call fails with 5012. When absent, the call works despite the schema saying "required".
- Output is **deterministic**: identical requests return identical probabilities.
- The service **canonicalises** requests. Reordering `criteria` keys or `state` keys changes nothing, which matches the published reference encoder: choice options are sorted by id and the state is `json.dumps(sort_keys=True)`.
- The response carries `usage.input_tokens`, with `output_tokens` always 0. There is no truncation field.
- Errors surface as a thrown `InferenceUpstreamError` (name `AiError`) with the message `"<code>: <detail>"`.

## Accuracy, thresholds and risk–coverage

`node scripts/analyze.ts` produces `results/eval-report.json`. The trimmed rows below come from joint mode, under the Keel rule, as R / P / decoy FP / coverage / risk. Coverage is the share of all 40 items given a non-abstaining verdict; risk is the error rate among those.

```
            clef-flash                                clef
t     R      P      dFP   cov   risk        R      P      dFP   cov    risk
0.3  100.0  95.7  10.0  95.0   2.6       100.0  95.7  10.0  100.0   2.5
0.4  100.0  95.7  10.0  95.0   2.6       100.0 100.0   0.0   97.5   0.0
0.5   95.5  95.5  10.0  95.0   5.3       100.0 100.0   0.0   97.5   0.0   <- chosen (pre-registered)
0.6   86.4  95.0  10.0  87.5   2.9        95.5 100.0   0.0   95.0   0.0
0.7   77.3 100.0   0.0  80.0   0.0        90.9 100.0   0.0   92.5   0.0
0.8   72.7 100.0   0.0  75.0   0.0        81.8 100.0   0.0   87.5   0.0
0.9   36.4 100.0   0.0  50.0   0.0        63.6 100.0   0.0   72.5   0.0
```

- **Separate mode** at t=0.5: Clef R100 / P100 / dFP0 / cov100. Flash R95.5 / P95.5 / dFP10 / cov95.
- **Argmax rule.** The argmax-with-agreement variant ("keel-argmax") is uniformly worse, because flips between adjacent values (exactly-one vs at-most-one) make it abstain. Clef joint at t=0.5 gives R95.5, P100, cov90.
- **Single ask.** Asking once without permutation ("single-mass", v0 only) gives Clef the same numbers as the Keel rule on this set.

Errors that decide the numbers:

- **Flash misses C24.** The idempotency key is removed from a payment capture. Flash chooses non-idempotent in joint mode but puts only 0.40–0.47 of its mass on violating values; in separate mode it says idempotent in two of three orders.
- **Flash false-flags decoy D02.** The cache is keyed by `(repo_id, version)` and the version is read from the primary on every call. Flash says read-your-writes with violating mass 0.61–0.93.
- **Clef gets D02 right**, choosing strong in 2/3 joint and 3/3 separate. Its only verdict flip is D02 joint v2, which the Keel rule turns into an abstention.
- **Unclear on different-subject decoys.** Flash answers `unclear` on D06 and D07, while Clef answers the untouched subject's real value (per-call). Both are compatible.
- **Systematic confusion, both models:** `exactly-one` vs `at-most-one` for single-instance facts (C08, D05, D09). It never changes the verdict, because both values sit on the same side of an at-most-one premise.

**Joint vs separate.** The same question gets a different choice depending on what else is in the call: in 7.5% of answers for Flash and 4.2% for Clef, with probability shifts of up to 0.45 and 0.47. The reference encoder decides "every field jointly", so questions in one call are not independent.

## Truncation

`node scripts/truncation.ts`, then `node scripts/truncation-report.ts`, produce `results/truncation.json` and `results/truncation-report.json`.

- **Probe.** The state is `{hunks: [N filler hunks..., the C01 permission-cache hunks]}`. The correct answer, per-session, exists **only at the end**.
- **Token counts.** Each filler hunk is exactly 119 tokens (measured: 809 tokens at N=0, 3,189 at N=20, 12,709 at N=100), so the true size of any probe is known exactly even when the service truncates it.
- **Control.** The same hunks with the decisive one **first**, at 81.8K tokens.

```
clef-flash (effective cap 24,000)
target  true    service                         answer       est(2.5)  flagged  post-call usage==cap
20480   20444   full (20444)                    per-session  24268     yes*     no
23552   23538   full (23538)                    per-session  27898     yes*     no
24576   24490   silently truncated to 24000     unclear      29014     yes      yes
25600   25561   silently truncated to 24000     unclear      30271     yes      yes
32768   32701   silently truncated to 24000     unclear      38647     yes      yes
51200   51146   silently truncated to 24000     unclear      60285     yes      yes
61440   61380   silently truncated to 24000     unclear      72290     yes      yes
64512   64474   silently truncated to 24000     unclear      75920     yes      yes
65536   65426   silently truncated to 24000     unclear      77037     yes      yes
67584   67568   5021: estimated input+max output (49599) exceeded context window (24576)     yes  n/a (error)
81920   81848   5021: ... (60069) exceeded ... (24576)                                        yes  n/a (error)

clef (effective cap 64,000)
51200   51146   full (51146)                    per-session  60285     no       no
61440   61380   full (61380)                    per-session  72290     yes*     no
64512   64474   silently truncated to 64000     unclear      75920     yes      yes
65536   65426   silently truncated to 64000     unclear      77037     yes      yes
67584   67568   silently truncated to 64000     unclear      79550     yes      yes
81920   81848   silently truncated to 64000     unclear      96302     yes      yes
control: decisive hunk first, 81848 true -> truncated to 64000, answer per-session (0.937)
(* false alarm: flagged while under the cap)
```

What the service does:

- **The answer is silent and wrong.** The tail of the state is cut and the call succeeds, answering `unclear` (P(per-session) 0.008 for Clef, 0.076 for Flash) instead of per-session. A contradiction is silently lost. The control shows the model is fine on whatever survives; the cut is from the tail.
- **No flag.** There is no truncation field. The only signal is `usage.input_tokens` sitting exactly at the cap, which is **64,000 / 24,000**, not the documented 65,536 / 24,576. The gap matches the 5021 message's "input and maximum output tokens".
- **The "63K" and "64K" points are already truncated on Clef.** An estimator that uses the documented window misses them, even with exact token counts.
- **Flash has a second regime.** The service's own pre-flight estimate (about bytes/4; it estimated 49,599 tokens for 67,568 real ones) rejects requests with 5021 once that estimate exceeds 24,576. Between 24,000 and roughly 67K real tokens the truncation is silent.

Keel's estimator (`src/estimator.ts`):

- **How it estimates.** It rebuilds the prompt text exactly as the reference encoder lays it out: system prompt, `STATE:`, rendered state, the schema fields and sorted options. It then divides the UTF-8 bytes by a floor of 2.5 bytes per token and flags the request when the estimate is ≥ the measured cap.
- **Calibration.** The minimum bytes/token measured was 3.26 over the 240 single-question dataset requests and 2.95 for the filler probe.
- **Result.** It detects **9/9** oversize cases on Flash and **4/4** on Clef, with false alarms at 20K and 23.5K (Flash) and 61K (Clef).
- **Hard bound.** A floor of 1 is guaranteed, because the byte-level BPE gives at least one byte per token. It also detects everything, but flags any request above roughly 17–22K real tokens, at the 2.95–3.78 bytes per token measured here.
- **Post-call backstop.** Abstaining when `usage.input_tokens >= cap` detects every silent truncation (7/7 and 4/4) with no false alarms.

## Rate limit

`node scripts/ratelimit.ts` produces `results/ratelimit.json`. The burst is open loop: 2, 4, 6, 8 and 10 requests/s for 6 s each, so at most 180 requests per model, with a stop rule of 3 rate-limited responses in 1 s or 5 in a row. The two models ran 60 s apart.

```
clef-flash  stopReason=null  2rps 12/12 ok p50 254ms | 4rps 24/24 341ms | 6rps 36/36 324ms | 8rps 48/48 266ms | 10rps 60/60 243ms  errors=[]
clef        stopReason=null  2rps 12/12 ok p50 141ms | 4rps 24/24 249ms | 6rps 36/36 219ms | 8rps 48/48 273ms | 10rps 60/60 282ms  errors=[]
```

- **No 429 was observed.** The limit is above 10 rps sustained for 6 s and above 180 requests in 30 s per model.
- This fits the documented default for text-generation models, 300 requests per minute per model: the burst stayed under 300 in any minute. The bounded probe was not escalated further.
- **429 error shape: not observed.** The binding's other errors are the `InferenceUpstreamError` shape shown above.

## Pass/fail per criterion

| Criterion | Clef | Clef-flash |
|---|---|---|
| Recall ≥ 90% at the chosen threshold (keel-mass, t=0.5) | **PASS**, 100% | **PASS**, 95.5% |
| Permuted agreement ≥ 95% (chosen value equal across all 3 orders) | **PASS at the bar** joint (95.0%, 38/40); **FAIL** separate (92.5%) | **FAIL** (90.0% / 92.5%) |
| Every truncation detected | **PASS** with Keel's estimator (4/4) and the post-call check (4/4). The service itself detects **nothing**. | **PASS** with the estimator (9/9); the post-call check catches 7/7 silent cases, and the 2 others fail loudly with 5021 |
| Demo: decoy FP ≤ 20% | **PASS**, 0% | **PASS**, 10% |

## Go/no-go

**GO: Clef (27B) chooses effect values; Keel's lattice code computes the verdict; the result is opinion and only routes work.** It holds under these conditions:

1. **Permute through option ids, not key order** (finding 1).
2. **Gate on the Keel rule (keel-mass) at t=0.5, with all three orders asked in one call.** That is the configuration that met all three criteria.
3. **Estimate before the call and abstain after it.** Run the pre-call estimator against the **measured** caps (64,000 / 24,000), and abstain whenever `usage.input_tokens >= cap`.
4. **Re-measure permuted agreement on a larger set (≥ 200 items) before trusting the agreement gate.** At n=40 the pass is exactly at the bar, and the separate-call mode fails it. If agreement comes in below 95%, take the fallback.

**NO-GO: Clef-flash as a first pass.**

- It fails permuted agreement.
- It misses a payment idempotency regression and false-flags a versioned cache.
- Its usable window is 24,000 tokens.
- It was **not faster** here: the 1-question p50 is 227 ms vs 236 ms for Clef, and at 64 questions Flash takes 3.6 s vs 1.9 s.
- Its only advantage is price: $0.038 vs $0.24 per M input tokens, about $0.00002 vs $0.00015 per median question.

**Fallback taken:** none for Clef. The Flash tier is dropped, and every question goes to Clef directly. The fallback (deterministic extractors and lattices only, with Clef ranking probes) stays armed behind condition 4.

## Can-fail demonstrations

1. **Estimator disabled.** The oversize case goes undetected. In the live sweep, every oversize request returned `ok` with a confident wrong answer (`unclear`) and no error: 0/9 detected (Flash) and 0/4 (Clef).
2. **Estimator mis-calibrated** (floor 4.0 instead of 2.5). The vitest suite goes red, then reverts green:
   ```
   × clef: flags every oversize request in the recorded 50K-80K sweep
   AssertionError: expected 47450 to be greater than or equal to 64000
   × clef-flash: flags every oversize request in the recorded 50K-80K sweep
   AssertionError: expected 18134 to be greater than or equal to 24000
   Tests  2 failed | 7 passed (9)      -> after revert: Tests  9 passed (9)
   ```
   On the live sweep the same mis-calibration detects 7/9 and 0/4.
3. **Documented window instead of the measured cap**, even with exact token counts: misses 2/4 on Clef (the 63K and 64K points) and 1/9 on Flash.
4. **Label check.** Mislabelling C01 as compatible makes the build and the test fail:
   ```
   Error: C01: lattice says contradiction, written label is compatible
   Tests  1 failed | 8 passed (9)      -> after revert: Tests  9 passed (9)
   ```
5. **Permutation check.** A permutation done by reordering `criteria` keys returns bit-identical probabilities (contract findings above). An agreement check built that way would report 100% and could never fail. The prefixed-id permutations do move the presented order; a test asserts that the three sorted orders are distinct. They did produce disagreements: 3.3–6.7% flips.

## Design-relevant findings

1. **Option order is canonicalised by the service.** The ids are sorted and so are the state's keys. Position bias can only be probed by changing ids, here with an ordering prefix `<letter>-<value>`. Keel must map ids back to lattice values in code.
2. **Answers depend on the rest of the batch.** In 4–7.5% of answers the choice changes when the same question shares a call with others, and probabilities move by up to 0.47.
   - Keel should fix batch composition: one change state with its premises, permutations in the same call.
   - It should never compare answers across different batch compositions, and it should use the whole request as the cache key.
   - Identical requests are deterministic, so re-asking adds nothing; only permutations add information.
3. **Use probability mass on violating values, not argmax.** Most flips are between adjacent values on the same side of the premise, and mass-based gating ignores them. Agreement should be measured on the **verdict**: 97.5–100% for Clef, while value agreement is 92.5–95%.
4. **Threshold.** For Clef, t between 0.4 and 0.6 gives 100% recall with 0 false conflicts on this set; t=0.5 was pre-registered and kept. Flash needs t ≤ 0.5 for ≥ 90% recall and keeps a 10% decoy FP rate.
5. **`unclear` is not an abstention mechanism for Clef.** Clef chose it 0 times on the 240 dataset answers but did choose it on truncated inputs. Abstention has to come from the permutation and threshold gate and from the token estimator.
6. **Measured caps beat documented ones.** The caps are 64,000 / 24,000. Truncation is silent and from the tail.
   - Put the facts that decide the answer early in `state` (diff hunks before context).
   - Split an oversize state by subject, or abstain.
   - Remember that the state is rendered with sorted keys, so "early" means array order, not object key order.
7. **Latency scales with input tokens.** At 612 tokens (one question), p50 is about 230 ms for both models. Large states are slow: Clef took 6.3 s at 51K tokens and about 7.5 s at 64K. Batching 64 questions costs 29 ms per question on Clef. The changelog's 38.8 ms median for Flash was not reproduced: through the binding from a Worker, Flash p50 was 227 ms.
8. **Contract notes:**
   - `model` is optional in practice and must match the endpoint.
   - The Flash context window is documented inconsistently (changelog 64K, model page 24,576); 24,000 was measured.
   - On the smaller probe in `model-field.ts`, Flash missed the S-1 pattern (per-request, 0.62) where Clef did not.

## Teardown

```
$ wrangler delete --name keel-spike-17-clef --force
Successfully deleted keel-spike-17-clef
$ curl -X POST https://<worker>.workers.dev/ ...
HTTP 404
$ wrangler deployments list --name keel-spike-17-clef
✘ [ERROR] A request to the Cloudflare API (/accounts/<id>/workers/scripts/keel-spike-17-clef/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
```

There are no other resources to remove; the AI binding needs none.

## Reproduce

```
cd spikes/17-clef-eval
pnpm install --ignore-workspace
node scripts/build-dataset.ts                 # writes docs/spikes/s17-dataset.json, checks labels
pnpm exec tsc --noEmit && pnpm run lint && pnpm exec vitest run
source "$CF_ENV" && pnpm exec wrangler deploy && echo "$TOKEN" | pnpm exec wrangler secret put SPIKE_TOKEN
export S17_URL=... S17_TOKEN=...
node scripts/model-field.ts && node scripts/eval.ts && node scripts/analyze.ts
node scripts/truncation.ts && node scripts/truncation-report.ts && node scripts/ratelimit.ts
pnpm exec wrangler delete --name keel-spike-17-clef --force
```
