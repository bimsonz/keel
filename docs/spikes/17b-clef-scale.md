# S17b: Clef agreement at scale

Run on 2026-10-10 against the live Workers AI binding, from a deployed Worker, `keel-spike-17b-clef`, which has since been deleted. The code is in `spikes/17b-clef-scale/`, the dataset in `docs/spikes/s17b-dataset.json`, and the raw outputs in `spikes/17b-clef-scale/results/`. It extends [S17](17-clef-eval.md) and reuses its method and code unchanged: lattice, questions, estimator, Worker and client are copied, and S17's directory is untouched.

## Question

S17 left Clef (`@cf/cloudflare/clef`) on a conditional go. Its permuted agreement passed exactly at the bar on 40 items (95.0%, Wilson interval 83.5–98.6%), and S17 asked for a re-measure on at least 200 items. On about 240 labelled premise/effect items, using S17's method exactly, does Clef reach:

- **relabelled agreement ≥ 95%**: the same chosen value in all three relabelled asks;
- **recall ≥ 90%** at the probability-mass gate?

The method:
- Clef only.
- Three asks per item in one call, each permuted by relabelling the option ids.
- A fixed batch composition: one item's three asks per call, with nothing else.
- The gate flags a contradiction only if all three asks put ≥ 0.5 of their mass on premise-violating values.

**Fallback:** deterministic extractors and lattices decide; Clef only ranks probes.

## Answer

**FAIL, NO-GO for Clef as the decider. The fallback is taken.**

- **Recall passes:** 97.0%, interval 91.6–99.0%.
- **Relabelled agreement fails:** 90.9%, interval 86.6–93.9%. Even the upper bound is below 95%.

| Metric (gate: keel-mass, t = 0.5) | Value | Wilson 95% interval | Bar |
|---|---|---|---|
| **Relabelled agreement** (same value in all 3 asks) | **90.9%** (220/242) | **86.6–93.9%** | ≥ 95%: **FAIL** (lower bound 86.6%) |
| **Recall** on contradictions | **97.0%** (98/101) | **91.6–99.0%** | ≥ 90%: **PASS** (lower bound 91.6%) |
| Precision | 91.6% (98/107) | 84.8–95.5% | — |
| Decoy false-positive rate | 14.3% (9/63) | 7.7–25.0% | S17 demo bar ≤ 20%: point passes, upper bound does not |
| False positives on compatible core items | 0.0% (0/78) | 0.0–4.7% | — |
| Pairwise flip rate | 6.3% (46/726) | 4.8–8.3% | — |
| Verdict agreement (same lattice verdict in all 3) | 92.6% (224/242) | 88.5–95.2% | — |
| `unclear` share of answers | 5.9% (43/726) | 4.4–7.9% | — |
| Value accuracy, first ask / all three asks | 85.1% / 82.6% | 80.1–89.1 / 77.4–86.9% | — |
| Coverage (non-abstaining verdicts) | 90.5% (219/242) | 86.1–93.6% | — |
| Latency per call (3 questions), p50 / p95, in the Worker | 235 / 445 ms (max 725) | — | — |
| Latency per question, p50 / p95 | 78 / 148 ms | — | — |
| Truncation | 0 items tripped the estimator or the post-call check | max estimate 3,602 tokens against a 64,000 cap | — |

**The S17 subset reproduces S17's 40-item result.** It gives 95.0% agreement (38/40) and 100% recall. That pass came from a set too small to detect a 91% agreement rate. Most of the instability comes from where an ask sits in the joint call, not from its labels (finding 1).

## Setup

- **Worker.** `src/worker.ts` is S17's authenticated pass-through: an `ai` binding `AI` and a bearer secret, with latency timed around `env.AI.run` inside the Worker. It was deployed with wrangler 4.149.0 and `compatibility_date` 2026-10-01; `account_id` comes from the environment only.
- **Driver.** Node 22 scripts under `scripts/`. The URL and token come from `S17B_URL` / `S17B_TOKEN` and are never written to disk. Calls are paced at 2 concurrent with 300 ms spacing (≤ 3.4 rps), with retry on 429. No retry was needed.
- **Request.** As in S17 (`src/questions.ts`, unchanged):
  - `state` is `{hunks: [{file, language, diff}], symbols: [{name, kind, file, status}]}`.
  - Each question is a `choice` with object instructions `{task, subject, predicate, scope}`, and criteria for every lattice value plus `unclear`.
  - The premise value is never sent.
  - v0 is in lattice order; v1 and v2 are seeded shuffles carried in the option ids (`c-per-session`).
- **What Clef sees.** The state is what a production adapter would send: diff hunks and code facts (symbols with status). It never contains pre-normalised lattice values, and never wording that names the answer. The dataset build enforces this (the leak check, below).
- **Calls.**

  | Run | Calls | Purpose |
  |---|---|---|
  | `main` | 242 | Scored |
  | `reorder` | 242 | Control |
  | `s17orig` | 40 | Control |
  | `warmup` | 242 | Exploratory |
  | slot probe | 76 | Diagnosis |
  | **Total** | **842** | 0 errors, 0 retries, 0 × 429 |

```
$ node scripts/eval.ts main reorder s17orig
main: 242 calls in 72.6 s, 0 errors/skips, 0 retries
reorder: 242 calls in 72.8 s, 0 errors/skips, 0 retries
s17orig: 40 calls in 12.0 s, 0 errors/skips, 0 retries
$ node scripts/eval.ts warmup
warmup: 242 calls in 72.6 s, 0 errors/skips, 0 retries
```

## Dataset (`docs/spikes/s17b-dataset.json`)

**242 items**, from three sources:
- **S17's 40**, held out as a subset;
- **8 forge-lite** S-1/S-2 items;
- **194 synthetic** items from 40 template families.

| | Total | Contradiction | Compatible (core) | Decoy |
|---|---|---|---|---|
| All | 242 | 101 | 78 | 63 (**26%**) |
| s17 | 40 | 22 | 8 | 10 |
| forge-lite | 8 | 4 | 0 | 4 |
| synthetic | 194 | 75 | 70 | 49 |

Decoys come in two kinds:
- **22 same-subject-compatible.** These are near misses that look like a violation: a TTLCache created per request, a `sync.Once` on a per-request struct, `Promise.all` used only to warm connections, an `INSERT ... ON CONFLICT DO NOTHING` added, a clamp raised within its bucket, and similar.
- **41 different-subject.** The same mechanism is applied to a sibling symbol, and the subject is untouched.

| Predicate | Items | Contra / compat / decoy | Premise→effect pairs covered | Languages (ts / go / py / c / hcl) |
|---|---|---|---|---|
| freshness | 45 | 18 / 11 / 16 | 20 of 20 | 18 / 8 / 10 / 7 / 2 |
| cardinality | 21 | 8 / 7 / 6 | 6 of 6 | 5 / 5 / 6 / 1 / 4 |
| ordering | 21 | 8 / 7 / 6 | 6 of 6 | 6 / 6 / 6 / 2 / 1 |
| consistency | 21 | 8 / 7 / 6 | 6 of 6 | 8 / 5 / 8 / 0 / 0 |
| presence | 21 | 9 / 7 / 5 | 6 of 6 | 5 / 5 / 5 / 3 / 3 |
| authority | 40 | 18 / 16 / 6 | 30 of 30 | 11 / 9 / 11 / 0 / 9 |
| purity | 21 | 8 / 7 / 6 | 6 of 6 | 5 / 6 / 6 / 4 / 0 |
| bound | 28 | 11 / 11 / 6 | 20 of 56 (sampled) | 8 / 5 / 5 / 5 / 5 |
| shape | 24 | 13 / 5 / 6 | 17 of 36 (sampled) | 6 / 9 / 7 / 0 / 2 |

- **Totals.** Primary languages: TypeScript 72, Python 64, Go 58, HCL 26, C 22. Every lattice value occurs as an effect.
- **Pairs.** A pair is premise value → effect value; for `≤` lattices the top value is excluded as a premise. Bound and shape pairs are sampled, because a premise of le-1 against an effect of le-1m adds nothing.
- **Diff shapes.** 203 single-hunk, 13 multi-hunk and 26 multi-file. Synthetic diffs use 3 or 5 lines of context, seeded.
- **Labels never come from Clef.** Each item stores the effect value derived from its diff and a `reason`. The build computes the label with `compare()` from the lattice and fails if any written label disagrees. That covers S17's and forge-lite's hand-written labels, and synthetic decoys, which are compatible by construction.

### The leak check (`src/leak.ts`)

The build fails if an item's state, or the subject and scope in its question, contains that item's own ground-truth lattice value or an obvious synonym of it.
- **Normalisation.** Text is normalised first, so `perSessionCache`, `PER_SESSION` and `per-session` all read "per session".
- **Lattice ids and prose synonyms** are matched everywhere: code, comments, string literals, symbol names and paths. Examples: "until the session ends", "read after write", "safe to retry", "any order", "unlimited".
- **Code-native words** are matched only in comments, symbol kinds and the question. In code they are the fact itself, and production would send them. Examples: Go `string`, zod `.optional()`, a role literal `"admin"`, TTLCache's `ttl=`, C `static`.
- **Bounds.** For `bound`, a comment that states a number in the answer's bucket ("at most 1,000") is a leak.
- **Duplicates.** The build also fails if two items would send Clef an identical request.

**S17's own items leaked: 9 of 40.** They were sanitised in the copy under `dataset/s17/`. S17's files are unchanged.

| Item | Leak | Change |
|---|---|---|
| C01 | comment "resolved role per (session, repo) until the session ends" | sentence removed |
| C11 | comment "one worker per partition…"; scope "(per aggregate)" | comment removed; scope `service:outbox` |
| C15 | comment "…always sees its own writes"; scope "(read after write)" | comment removed; scope `worker:orders` |
| C20 | comment "Org admins can now…" | removed |
| C21 | subject `org.invite-member` (answer: member) | subject `org.send-invitation` |
| C23 | comment "only admins (and owners) may do it now" | second line removed |
| D01 | comment "once per request… dies with it" | removed |
| D02 | comment "reads the primary… latest committed version" | removed |
| D03 | comment "reuses the caller's idempotency key" | removed |

The 9 S17 items were first identified by running `src/leak.ts` over `s17-dataset.json`:
```
C01: state contains the ground-truth value "per-session"
C01: state contains "until the session ends", a synonym of per-session
C15: state contains "read after write", a synonym of read-your-writes
...
9/40 S17 items leak
```

### forge-lite S-1 / S-2 items

The subject is `authz.permission-evaluation`, the premise is freshness ≤ per-request, and the scope is `service:forge-lite`.

| Id | What | Source | Effect → label |
|---|---|---|---|
| F01 | B: per-(session, repo) role cache, no invalidation | `scenarios/s1/b.patch`, real hunks | per-session → contradiction |
| F02 | the "simplify" change: subscription and `evict()` removed | `scenarios/s2/careless.patch`, real hunks | per-session → contradiction |
| F03 | B′: cache invalidated on revoke (`collaborator.removed`) | `scenarios/s1/b-revised.patch`, real hunks | per-call → compatible (decoy) |
| F04 | TTL variant: per-(user, repo), 60 s expiry | hand-written on B's code | ttl → contradiction |
| F05 | per-request memo on the Hono context | hand-written | per-request → compatible (decoy) |
| F06 | a second "simplify": subscription dropped, `evict()` left dead | hand-written on B′ | per-session → contradiction |
| F07 | A: revoke route; `requirePermission` untouched | `scenarios/s1/a.patch`, real hunks | per-call → compatible (decoy) |
| F08 | per-session cache of the owner's user record for the repo view | hand-written on `routes/repos.ts` | per-call → compatible (decoy) |

- **Real hunks.** These are source files only; test files are excluded because their names describe the behaviour. Doc comments that state the cache's lifetime were removed, as the leak check requires: "Per-session cache of…", "cached per session", "warm session or not", and A's "evaluates… on every request".
- **F03's label is a judgement.** Removal is the only write that lowers a role, and a cached role that falls short is looked up again, so every decision equals a fresh evaluation. Its observable freshness is therefore per-call. S17's lattice text describes mechanism, and a cache invalidated on the only access-lowering write has no value of its own (finding 3).

### Synthetic generation and hand-check

**Generation.** `dataset/synth/` holds 40 families: subject × predicate × language, each with a sibling subject in the same file.
- Each family draws code for any lattice value it supports: TypeScript, Python, Go, C and HCL.
- An item is the diff between two renders:
  - **core:** the subject moves from a before value to the effect;
  - **different-subject decoy:** only the sibling moves, to a value that would violate the premise;
  - **trap:** a near-miss variant.
- Every choice is seeded (`0x17b`), and the diff is generated by a small LCS differ.

**Hand-check.** A seeded random sample of 32 synthetic items (`node scripts/sample.ts 32 2026`): S001, S009, S013, S016, S023, S030, S035, S040, S044, S054, S055, S056, S057, S059, S060, S065, S076, S079, S081, S089, S110, S120, S121, S129, S133, S149, S151, S156, S164, S179, S183, S185. Each diff was read and the effect re-derived by hand. All 15 trap items were also read.

- **Effect values and labels:** 32/32 correct as generated. No label was changed.
- **Correction 1, S040** (C, cardinality). A `\n` in a C string literal was cooked into a real newline by the template, which broke the rendered `main`. The template was fixed; the label is unchanged.
- **Correction 2, diff output.** All items printed `+` lines before `-` lines in replaced runs. This was valid, but not what git emits, so the differ now emits deletions first.
- **Known hardness.** In some different-subject decoys the subject's code is outside the hunk context (Go `or-go` puts the sibling in another file). There, the only fact about the subject is a symbol entry with status `unchanged`, which is what a 3-line-context adapter would also send. These decoys are hard by design.

```
$ node scripts/build-dataset.ts
{ "total": 242, "bySource": { "s17": 40, "forge-lite": 8, "synthetic": 194 }, "core": 179,
  "coreContradiction": 101, "coreCompatible": 78, "decoys": 63, "decoyShare": 0.26,
  "decoySameSubjectCompatible": 22, "decoyDifferentSubject": 41,
  "byLanguage": { "typescript": 72, "go": 58, "python": 64, "c": 22, "hcl": 26 },
  "byDiffShape": { "multi-file": 26, "single-hunk": 203, "multi-hunk": 13 } }
$ pnpm exec tsc --noEmit && pnpm run lint && pnpm exec vitest run
Test Files  3 passed (3)
     Tests  17 passed (17)
```

## Results

`node scripts/analyze.ts` produces `results/eval-report.json`. The intervals are Wilson 95%. Rows are recall / precision / decoy FP / agreement / coverage at the gate.

```
calls=242 errors=0 retries=0
overall (mass gate)    n=242 R 97.0% [91.6-99.0] (98/101) | P 91.6% [84.8-95.5] (98/107) | dFP 14.3% [7.7-25.0] (9/63) | agree 90.9% [86.6-93.9] (220/242) | cov 90.5% [86.1-93.6] (219/242)
overall (top choice)   n=242 R 97.0% [91.6-99.0] (98/101) | P 91.6% [84.8-95.5] (98/107) | dFP 14.3% [7.7-25.0] (9/63) | cov 89.3% [84.7-92.6] (216/242)
flip 6.3% [4.8-8.3] (46/726) | verdict-agree 92.6% [88.5-95.2] (224/242) | unclear 5.9% [4.4-7.9] (43/726) | v0 acc 85.1% [80.1-89.1] | compatFP 0.0% [0.0-4.7] (0/78)
misses: F06, S035, S066
false flags: D02, F03, S021, S027, S059, S060, S146, S147, S148
```

### By source: the S17 subset

| Source | n | Recall | Precision | Decoy FP | Agreement | Coverage |
|---|---|---|---|---|---|---|
| **S17 subset** (sanitised) | 40 | 100% (22/22) [85.1–100] | 95.7% [79.0–99.2] | 10.0% (1/10) [1.8–40.4] | **95.0%** (38/40) [83.5–98.6] | 100% |
| S17 original, unsanitised, this run | 40 | 100% (22/22) | 100% | 0% (0/10) | **95.0%** (38/40) [83.5–98.6] | 100% |
| S17 as reported (joint) | 40 | 100% | 100% | 0% | 95.0% | 97.5% |
| forge-lite | 8 | 75.0% (3/4) | 75.0% | 25.0% (1/4) | 75.0% (6/8) | 75.0% |
| synthetic | 194 | 97.3% (73/75) [90.8–99.3] | 91.3% [83.0–95.7] | 14.3% (7/49) [7.1–26.7] | 90.7% (176/194) [85.8–94.0] | 89.2% |

**S17's numbers reproduce exactly.** Identical requests are deterministic, and the 40 unsanitised items give 95.0% / 100% / 0% again. Sanitising changed two answers:
- **C15.** Without "…sees its own writes" the asks split read-your-writes / eventual / eventual, so C15 joins the disagreeing items.
- **D02.** Without the docstring about reading the primary, all three asks say read-your-writes, so D02 becomes a false flag.

The subset's agreement stays at 95.0% only because D02 moved the other way: from split to unanimous but wrong.

### By predicate

| Predicate | n | Recall | Precision | Decoy FP | Agreement [interval] | Coverage |
|---|---|---|---|---|---|---|
| freshness | 45 | 94.4% (17/18) | 85.0% | 18.8% (3/16) | 88.9% [76.5–95.2] | 88.9% |
| cardinality | 21 | 87.5% (7/8) | 100% | 0% (0/6) | 85.7% [65.4–95.0] | 90.5% |
| ordering | 21 | 100% (8/8) | 80.0% | 33.3% (2/6) | 81.0% [60.0–92.3] | 85.7% |
| consistency | 21 | 87.5% (7/8) | 87.5% | 16.7% (1/6) | 76.2% [54.9–89.4] | 71.4% |
| presence | 21 | 100% (9/9) | 100% | 0% (0/5) | 95.2% [77.3–99.2] | 95.2% |
| authority | 40 | 100% (18/18) | 100% | 0% (0/6) | 92.5% [80.1–97.4] | 90.0% |
| purity | 21 | 100% (8/8) | 72.7% | 50.0% (3/6) | 100% [84.5–100] | 100% |
| bound | 28 | 100% (11/11) | 100% | 0% (0/6) | 96.4% [82.3–99.4] | 92.9% |
| shape | 24 | 100% (13/13) | 100% | 0% (0/6) | 100% [86.2–100] | 100% |

**By language, agreement:** Go 94.8%, Python 92.2%, C 90.9%, TypeScript 88.9%, HCL 84.6%. **Decoy FP:** HCL 0/7, TypeScript 2/21, Go 2/15, Python 4/17, C 1/3.

### Decoys and core items

| Kind | n | Agreement | Flagged as contradiction |
|---|---|---|---|
| core contradiction | 101 | 97.0% | 98 (recall) |
| core compatible | 78 | 92.3% | 0 |
| decoy, same subject, compatible | 22 | 90.9% | 3 (13.6%): D02, F03, S027 |
| decoy, different subject | 41 | **73.2%** | 6 (14.6%): S021, S059, S060, S146, S147, S148 |

- **All six different-subject false flags are unanimous.** All three asks agree on the sibling's value: per-session, per-key-fifo, unordered, and non-idempotent three times. The agreement gate cannot catch them.
- **The misses:**
  - F06 (ttl / unclear / unclear) abstains;
  - S035, where the NOT NULL foreign key is replaced by an unindexed boolean (at-most-one / unclear / unclear), abstains;
  - S066, D1 sessions with a bookmark (read-your-writes / strong / eventual), is a **silent miss**. The mass gate decides it *compatible*, because each ask puts 0.455–0.47 on violating values, just under 0.5.

### Gates and thresholds

**Top choice vs mass.** Gating on each ask's top choice instead of its mass gives the same recall, precision and decoy FP on this set. It changes only coverage: 216 decided items vs 219. The difference is three items whose top choices straddle the premise while every ask's violating mass stays below 0.5:
- the mass gate decides C15 and S052 correctly as compatible;
- it decides S066 wrongly as compatible.

The top-choice gate abstains on all three.

The mass threshold does move recall:
```
keel-mass: t=0.3 R98.0 P90.8 dFP15.9 cov90.9 | t=0.4 R98.0 P91.7 dFP14.3 cov90.5 | t=0.5 R97.0 P91.6 dFP14.3 cov90.5
         | t=0.6 R92.1 P92.1 dFP12.7 cov86.4 | t=0.7 R89.1 P92.8 dFP11.1 cov83.5 | t=0.8 R81.2 P97.6 dFP3.2 cov74.8 | t=0.9 R61.4 P96.9 dFP3.2 cov61.2
```
Recall stays ≥ 90% only for t ≤ 0.6. With recall ≥ 90%, the lowest decoy FP rate is 12.7%, at t = 0.6; reaching 3.2% takes t = 0.8, where recall is 81.2%.

### The S-1 / S-2 items

```
F01 B (no invalidation)        chosen per-session ×3   pViolate 0.75-0.91  -> contradiction  (correct)
F02 careless "simplify"        chosen per-session ×3   pViolate 0.76-0.86  -> contradiction  (correct)
F03 B' (invalidated on revoke) chosen per-session ×3   pViolate 0.79-0.85  -> contradiction  (WRONG: compatible)
F04 ttl variant                chosen ttl ×3           pViolate 0.97-0.98  -> contradiction  (correct)
F05 per-request memo           chosen per-request ×3   pViolate 0.01-0.02  -> compatible     (correct)
F06 subscription dropped       ttl / unclear / unclear                     -> abstain        (miss)
F07 A, subject untouched       unclear / per-call / unclear                -> abstain
F08 per-session cache elsewhere per-call ×3                                -> compatible     (correct)
```

**Clef gives B, B′ and the careless "simplify" the same answer**, with the same confidence. It cannot see invalidation, so it cannot tell S-2's regression from the state it regresses.

## Controls and diagnosis

### Reorder-only asks do *not* give 100% (expectation refuted)

The spec expected three asks that share v0's option ids, differing only in criteria key order, to agree trivially, because the service sorts option ids. They do not:

```
control reorder-only: agree 92.2% [88.1-94.9] (223/242)  flip 5.2% [3.8-7.1] (38/726)
                      calls whose three identical asks got identical probabilities: 0/242
```

The slot probe (`node scripts/probe-slots.ts`, 76 calls on the 19 items that disagreed) separates the causes:

```
items=19 single-question key order bit-identical: 19/19;
identical questions disagree within a call: 15/19;
reversed insertion: odd slot is q0 (sorted first) in 1, q2 (inserted first) in 11
```

- **Key order is still a no-op**, as S17 found: one question sent with its keys in lattice order and reversed returns identical probabilities in 19/19 cases. Only the response map's key order follows the request, which is why a JSON-text comparison wrongly reported 0/19 the first time (finding 7).
- **Three byte-identical questions in one call disagree** in 15/19 of these items. The odd answer follows the **first-inserted** field (11 cases), not the id that sorts first (1 case). Fields are taken in insertion order, and the first one is answered differently.

### Where the disagreement sits

`node scripts/slots.ts`:

```
main:    acc slot1 0.851 slot2 0.851 slot3 0.860 | disagree 1-2 19  1-3 19  2-3 8  of 242 | odd one out by slot 14/3/3
reorder: acc slot1 0.860 slot2 0.855 slot3 0.851 | disagree 1-2 17  1-3 18  2-3 3  of 242 | odd one out by slot 16/1/2
warmup:  acc slot1 0.843 slot2 0.843 slot3 0.855 | disagree 1-2 22  1-3 25  2-3 12 of 242 | odd one out by slot 17/4/7
```

- **The first ask is the odd one.** In the main run, the first ask is the odd one out in 14 of the 20 items where exactly one ask differs.
- **Asks 2 and 3 are correlated.** They disagree in only 8/242 items (3/242 when their options are identical).
- **Accuracy is flat across slots** at about 85%. The first ask is not worse, just different. Asks 2 and 3 are not independent samples.

### Exploratory: a warm-up first field does not help

This run is not the pre-registered method. A fixed yes/no question went into slot 1, with the three relabelled asks behind it:

```
exploratory warm-up    n=242 R 92.1% [85.1-95.9] (93/101) | P 92.1% | dFP 12.7% [6.6-23.1] (8/63) | agree 88.0% [83.3-91.5] (213/242) | cov 85.5%
```

The first *relabelled* ask is still the odd one out (17 of 28 items where exactly one ask differs), and agreement and recall both fall. The effect belongs to the first ask of a repeated question, not to slot 1 as such.

## Truncation

S17's pre-call estimator (bytes / 2.5 against the measured cap of 64,000) and post-call check (`usage.input_tokens` ≥ 64,000) ran on every request. Neither tripped, so no item abstained for truncation.

```
truncation {"cap":64000,"estimatorMaxTokens":3602,"estimatorOversize":[],"postCallAtCap":[],"minBytesPerToken":3.149}
latency {"callP50":235,"callP95":445,"callMax":725,"perQuestionP50":78.3,"perQuestionP95":148.3,"clientP50":277,"inputTokensP50":1074,"inputTokensMax":2361}
```

- The largest request was 2,361 real input tokens.
- The lowest measured bytes per token was 3.15, which stays above the 2.5 floor.
- S17's estimator unit tests still pass against S17's recorded sweep. That sweep is read-only, from `spikes/17-clef-eval/results/truncation.json`.

## Pass/fail per criterion

| Criterion | Result | Interval | Verdict |
|---|---|---|---|
| Relabelled agreement ≥ 95% | 90.9% (220/242) | 86.6–93.9% | **FAIL** (the upper bound is below the bar too) |
| Recall ≥ 90% at the gate (keel-mass, t = 0.5) | 97.0% (98/101) | 91.6–99.0% | **PASS** (the lower bound clears the bar) |
| No truncation trips | 0 / 242 | — | **PASS** |
| S17 demo bar: decoy FP ≤ 20% | 14.3% (9/63) | 7.7–25.0% | point **PASS**; upper bound above the bar |

## Go/no-go

**NO-GO for Clef deciding contradictions.** The pre-registered agreement bar fails, and the failure is outside the confidence interval. S17's conditional go (its condition 4) resolves to the fallback.

**Fallback taken: deterministic extractors and lattices decide; Clef only ranks probes.**
- Contradictions that block or route work come from deterministic extractors feeding the lattices: cache keys and invalidation edges, lock and constraint presence, concurrency constructs, guard calls, clamps, wire types.
- Clef's mass on violating values orders which premises get a probe first. As a ranking signal it is useful: 97% of contradictions get at least 0.5 violating mass in all three asks, and no compatible core item does (0/78).
- Clef never decides a verdict on its own.

## Can-fail demonstrations

1. **A mislabelled item fails the build.** C01 was relabelled `compatible` in `dataset/s17/items.ts`, then reverted:
   ```
   $ node scripts/build-dataset.ts
   Error: dataset check failed:
     C01: lattice says contradiction, written label is compatible
   build exit=1
   $ pnpm exec vitest run
    FAIL  test/lattice.test.ts
   Error: dataset check failed:
     C01: lattice says contradiction, written label is compatible
    Test Files  1 failed | 2 passed (3)            vitest exit=1
   after revert: build exit=0; Test Files 3 passed (3), Tests 17 passed (17)
   ```
2. **A planted leak fails the build.** The comment `// Per-session cache of evaluated collaborator roles.` was added to F01's real hunk, then reverted:
   ```
   $ node scripts/build-dataset.ts
   Error: dataset check failed:
     F01: state contains the ground-truth value "per-session"
     F01: state contains "session cache", a synonym of per-session
   build exit=1            after revert: build exit=0, dataset byte-identical to the evaluated one
   ```
   `test/leak.test.ts` plants more leaks:
   - a comment naming the answer;
   - `perSessionRoles` and `PER_SESSION_ROLES` as identifiers;
   - "(until logout)" in the scope;
   - "now a string" in a Go comment, while the bare `string` type is allowed;
   - "at most 1,000" against le-1k.
3. **Top-choice gate vs mass gate.** Both are reported above. On this set they differ only in coverage (216 vs 219 decided). Moving the mass threshold to 0.7 drops recall below the bar (89.1%), so the gate itself can fail.
4. **Ask without relabelling (reorder only).** The expected trivial 100% did **not** occur: 92.2%. The trivially-agreeing case exists only *across calls*. One question re-sent with reordered keys is identical in 19/19 cases, which is why S17 relabels: reordering keys alone changes nothing the model sees. Within a joint call, slot position adds disagreement of its own.
5. **The agreement bar itself fails here**, so the agreement check is not vacuous.

## Design-relevant findings

1. **In a joint call, relabelled agreement mostly measures position, not label robustness.**
   - Identical questions in one call disagree (92.2% agreement), and no call returns identical probabilities for its three identical asks (0/242).
   - The first-inserted ask of a repeated question is the odd one out; asks 2 and 3 are strongly correlated.
   - Three asks in one call are therefore not three independent samples, and the agreement gate cannot reach 95% on this mix. A warm-up field does not fix it (88.0%).
   - S17 already found separate calls worse (92.5% on 40 items).
2. **Unanimous wrong attribution is the main false-positive mode.** In 6 of the 9 false flags, all three asks agree on the value of a *different* symbol changed in the same diff. Agreement and mass gates pass these through. Whether the diff touches the subject at all must be decided in code, for example from symbol ownership or the call graph. If the subject is untouched, its prior value stands and Clef is not asked.
3. **Clef cannot see invalidation, so it cannot catch S-2.** B, B′ and the careless "simplify" all get per-session with 0.76–0.85 violating mass.
   - The S-2 contradiction has to come from a deterministic extractor: an invalidation or subscription edge removed from a cache whose key outlives the request.
   - The freshness lattice also needs a way to express "cached, but invalidated by every write that can lower the answer". Its values describe mechanism.
4. **Comments carry answers, in both directions.** 9 of S17's 40 items named their own answer. Removing those comments changed two answers and moved the S17 subset's decoy FP from 0% to 10%. A production adapter sends real comments, which can be stale or wrong. Keel should not let a verdict hinge on one.
5. **Predicate difficulty is uneven.**
   - Agreement: consistency 76.2%, ordering 81.0%, cardinality 85.7% and freshness 88.9% are the weak predicates, against shape 100%, purity 100%, bound 96.4% and presence 95.2%.
   - Purity's decoy FP rate is 50% (3/6), all different-subject.
   - If any predicate is later handed back to Clef as a decider, shape, bound and presence are the candidates.
6. **Thresholds.** The mass and top-choice gates give the same recall, precision and decoy FP here. The mass gate decides three more items: two right and one silent miss (S066). Recall holds ≥ 90% only for t ≤ 0.6, and with recall ≥ 90% the decoy FP rate never goes below 12.7%.
7. **Compare probabilities by option id, never as JSON text.** The response map follows the request's key order. This spike's first probe misreported S17's canonicalisation finding because of it.
8. **Cost and latency are unchanged from S17.**
   - 235 ms p50 per 3-question call at about 1.1K input tokens, which is 78 ms per question.
   - No 429s at ≤ 3.4 rps across 842 calls.
   - Every request was far below the 64,000-token cap (max 2,361).

## Teardown

```
$ wrangler delete --name keel-spike-17b-clef --force
Successfully deleted keel-spike-17b-clef
$ curl -X POST https://<worker>.workers.dev/ (with token)
HTTP 404
$ wrangler deployments list --name keel-spike-17b-clef
✘ [ERROR] A request to the Cloudflare API (/accounts/<id>/workers/scripts/keel-spike-17b-clef/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
```

There are no other resources to remove: the AI binding needs none. The bearer token existed only in a scratch file outside the repository, which has been deleted.

## Reproduce

```
cd spikes/17b-clef-scale
npm_config_userconfig=/dev/null pnpm install --ignore-workspace
node scripts/build-dataset.ts            # writes docs/spikes/s17b-dataset.json; label, leak and duplicate checks
pnpm exec tsc --noEmit && pnpm run lint && pnpm exec vitest run
node scripts/sample.ts 32 2026           # the hand-check sample
source "$CF_ENV" && pnpm exec wrangler deploy && echo "$TOKEN" | pnpm exec wrangler secret put SPIKE_TOKEN
export S17B_URL=... S17B_TOKEN=...
node scripts/eval.ts main reorder s17orig && node scripts/analyze.ts
node scripts/probe-slots.ts && node scripts/eval.ts warmup && node scripts/analyze.ts && node scripts/slots.ts
pnpm exec wrangler delete --name keel-spike-17b-clef --force
```
