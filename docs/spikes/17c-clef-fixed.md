# S17c: Clef with the three fixes, and a threshold sweep

Run on 2026-10-10 against the live Workers AI binding, from a deployed Worker, `keel-spike-17c-clef`, which has since been deleted. The code is in `spikes/17c-clef-fixed/`, the dataset in `docs/spikes/s17c-dataset.json`, and the raw outputs in `spikes/17c-clef-fixed/results/`. It builds on [S17b](17b-clef-scale.md): the lattice, questions, estimator, leak guard, Worker, client and dataset sources are copied, and S17b's directory is untouched.

## Question

S17b failed Clef (`@cf/cloudflare/clef`) as a decider. Relabelled agreement was 90.9% (Wilson 86.6–93.9%) against a bar of 95%, and S17b found three causes:
- (a) comments in the state carry answers;
- (b) disagreement tracks position: the first-inserted repeated ask is the odd one out;
- (c) most false flags are unanimous misattribution to a sibling symbol.

With a fix for each, on the same 242 items and S17b's method otherwise unchanged, does Clef reach the same bar?
- **Relabelled agreement ≥ 95%.**
- **Recall ≥ 90%** at the gate.

The fixes:
1. **Strip comments** from `state` (TypeScript, Python, Go, C, HCL, and SQL), and keep S17b's leak guard.
2. **Balance position.** Rotate which relabelled ask is inserted first, so each relabelling occupies each slot equally often.
3. **Anchors decide the subject.** Clef sees only the code of the premise's anchors, never a sibling symbol.

Also:
- What does each fix contribute on its own?
- How many of S17b's 9 false flags disappear?
- Is B′ (cache invalidated on revoke) still answered per-session?
- What violating-mass threshold should Keel use by default, per predicate? This is for a per-project configurable threshold below which Keel escalates.

**Fallback:** deterministic extractors and lattices decide; Clef only ranks probes.

## Answer

**FAIL, NO-GO for Clef as the decider. The fallback stays in force.**

- **Agreement still misses the bar:** 94.2%, Wilson interval 90.5–96.5%. The interval now spans 95%, but the point estimate is below it.
- **Recall passes:** 98.0%, interval 93.1–99.5%.
- **Where the gain comes from:** anchor scoping does almost all of the work. It removes 6 of S17b's 9 false flags and cuts decoy false positives from 14.3% to 6.3%. Comment stripping is neutral in aggregate. Position balance spreads the first-slot effect across the relabellings but does not remove it.
- **B′ is still answered per-session**, ×3, with 0.60–0.84 violating mass, exactly as in S17b.

| Metric (main run, all three fixes; S17b's gate: keel-mass, t = 0.5) | Value | Wilson 95% interval | Bar |
|---|---|---|---|
| **Relabelled agreement** (same value in all 3 asks) | **94.2%** (228/242) | **90.5–96.5%** | ≥ 95%: **FAIL** |
| **Recall** on contradictions | **98.0%** (99/101) | **93.1–99.5%** | ≥ 90%: **PASS** (lower bound clears) |
| Precision | 96.1% (99/103) | 90.4–98.5% | — |
| Decoy false-positive rate | 6.3% (4/63) | 2.5–15.2% | S17 demo bar ≤ 20%: **PASS**, upper bound included |
| False positives on compatible core items | 0.0% (0/78) | 0.0–4.7% | — |
| Silent misses (contradiction decided compatible) | 0 | — | — |
| Pairwise flip rate | 3.9% (28/726) | 2.7–5.5% | — |
| Verdict agreement (same lattice verdict in all 3) | 97.1% (235/242) | 94.2–98.6% | — |
| `unclear` share of answers | 2.8% (20/726) | 1.8–4.2% | — |
| Value accuracy, first variant / all three asks | 91.7% / 88.8% | 87.6–94.6 / 84.3–92.2% | — |
| Coverage (non-abstaining verdicts) | 95.0% (230/242) | 91.5–97.1% | — |
| Latency per call (3 questions), p50 / p95, in the Worker | 226 / 418 ms (max 570) | — | — |
| Truncation | 0 trips in 726 calls | max estimate 3,455 tokens against a 64,000 cap | — |

**The relabelled-agreement point estimate moved from 90.9% to 94.2%**: 14 items now agree and 6 now disagree. The change is not significant (exact McNemar p = 0.115).

**The dominant failure mode is gone.** Unanimous misattribution to a sibling fell from 6 false flags to 0. The one different-subject false flag left, S060, is now a misreading of the subject's own code. S17b's one silent miss (S066) now abstains.

**What is left is not reachable by these fixes:**
- two same-subject false flags, D02 and F03, whose anchor view is their whole diff;
- the first-inserted ask, still the odd one out in 12 of the 14 single-dissent items.

## Setup

- **Worker.** `src/worker.ts`, unchanged from S17 and S17b: an authenticated pass-through with an `ai` binding `AI`, deployed with wrangler 4.149.0 and `compatibility_date` 2026-10-01. `account_id` comes from the environment only.
- **Driver.** `scripts/eval.ts`.
  - The URL and token come from `S17C_URL` / `S17C_TOKEN` and are never written to disk.
  - Calls are paced at 2 concurrent with 300 ms spacing (≤ 3.4 rps), with retry on 429. No retry was needed.
- **Method kept from S17b:**
  - one item per call;
  - three relabelled asks per call, permuted by relabelling the option ids (`c-per-session`), never by reordering;
  - a fixed batch composition per question family: an item's three asks, and nothing else;
  - probabilities compared by option id;
  - the pre-call estimator (bytes / 2.5 against 64,000) and the post-call cap check;
  - the build that re-derives every label from the lattice;
  - the premise value is never sent.
- **Calls.**

  | Run | State sent | Ask order | Calls | Purpose |
  |---|---|---|---|---|
  | (S17b `main`) | S17b's state | v0, v1, v2 | — | No-fix baseline, read from `spikes/17b-clef-scale/results/`, not re-run |
  | `c1` | comments stripped | v0, v1, v2 | 242 | Fix 1 only |
  | `c2` | comments stripped | rotated | 242 | Fixes 1 + 2 |
  | `main` | anchor view, comments stripped | rotated | 242 | Fixes 1 + 2 + 3, scored |
  | **Total** | | | **726** (+1 smoke test) | 0 errors, 0 retries, 0 × 429 |

  The spec allowed up to three extra runs; `c1` and `c2` are two of them.
  - **Re-using S17b's run is sound.** Identical requests are deterministic: on the 214 items whose request fix 1 leaves unchanged, `c1` returns S17b's probabilities exactly (214/214). Likewise, `main` equals `c2` exactly on the 40 items whose anchor view equals the stripped state (40/40).

```
$ node scripts/eval.ts main c1 c2
main: 242 calls in 72.7 s, 0 errors/skips, 0 retries
c1: 242 calls in 72.5 s, 0 errors/skips, 0 retries
c2: 242 calls in 72.7 s, 0 errors/skips, 0 retries
$ node scripts/determinism.ts
fix 1 changes the request of 28/242 items; S17b vs c1 identical on the other 214/214
fix 2 changes the slot order of 161/242 items (rotation 1 or 2)
fix 3 changes the state of 202/242 items; c2 vs main identical on the other 40/40
```

## The fixes as built

### Fix 1: comment stripping (`src/strip.ts`)

**How it works:**
- Each hunk's `@@` sections are rebuilt as two streams:
  - **before:** context and `-` lines;
  - **after:** context and `+` lines.
- Each stream is tokenised in full, so block comments, docstrings and multi-line strings are tracked across lines. The syntax per language:
  - `//` and `/* */` for TypeScript, Go and C;
  - `#` and statement-position `"""` docstrings for Python;
  - `#`, `//` and `/* */` for HCL;
  - `--` and `/* */` for SQL.
- String literals are code and are kept.
- A line that held only a comment is dropped, and trailing whitespace is trimmed.
- A section with nothing to strip is emitted byte for byte.
- A section that changed is re-diffed from its two stripped streams. A `-`/`+` pair that differed only in a comment therefore becomes one context line.

**Results:**
- **28 of 242 items carried comments:** 12 TypeScript, 7 Go, 7 Python and 2 HCL, all from S17's 40 and forge-lite's 8. The synthetic templates have none.
- **The build fails if any comment survives in a sent state.** It checks with S17b's own comment extractor from `src/leak.ts`.
- **S17b's leak guard is kept unchanged and runs on every state that is sent**, both `stripped` and `scoped`.

### Fix 2: position balance (`src/questions.ts`, `slotOrder`)

- **The rotation.** An item with rotation r inserts v_r, v_{r+1}, v_{r+2}. Rotation 0 is S17b's order.
- **How it is assigned.** The build assigns r as a Latin square, predicate by predicate. Overall the three rotations take 81 / 81 / 80 items, so each relabelling sits in each slot 80–81 times. Within each predicate the split is within one, for example authority 14 / 13 / 13.
- **The ids.** The question ids stay the variant names (`v0`, `v1`, `v2`). Only the insertion order moves.
- **The check.** The build fails if the rotation is unbalanced by more than one.

### Fix 3: anchor scoping

**The rule.** Clef sees the complete code of the premise's anchors, before and after, as a diff, and nothing else. The symbol list is filtered to the anchors. An anchor the change leaves untouched is shown as context lines only, which is the code it already has.

**Synthetic items (194):** `dataset/synth/anchor.ts`. The renderer stands in for a correct anchor registry. A symbol is classed by whether its code depends on the subject's value, the sibling's value, both or neither, over the family's full subject × sibling grid.

| Class | What it is | In the view? |
|---|---|---|
| subject | the family's anchor, plus helpers, module-level caches, and the write route a read depends on | kept |
| sibling | code that depends on the sibling's value only | dropped |
| mixed | one block holding both, e.g. a struct with both fields | kept, minus every line that changes with the sibling's value |
| neutral | code that depends on neither | dropped |

The build re-renders S17b's diff from the same code and fails unless it is byte-identical to the one S17b sent: 194/194 are.

**Hand-written items (48):** `dataset/anchors.ts`. These were written as diffs, so there is no source to render. An item that is about its subject only keeps its whole diff (38 items). The other 10 are cut by hand, and each cut is checked mechanically:

| View | Items | Check |
|---|---|---|
| sub-diff: foreign symbols' lines removed | C05, D04, D05, D07, D09, D10 | the view must be a subsequence of the original diff |
| fixture: the untouched anchor `requirePermission` / `callerRole`, taken from `fixtures/forge-lite` as context lines | F07, F08 | every line must equal the file's line at that number |
| symbol-only: the anchor is untouched, not in the diff, and has no source | D06, D08 | — |

**Untouched anchors.** 41 items have an anchor the change leaves untouched. They are exactly the 41 different-subject decoys.

**Limitations.** Each is recorded by the build in `composition.anchorView`.
- **Mixed lines are dropped.** A single line that mixes subject and sibling code changes with the sibling, so it goes. On 15 synthetic items this drops a changed line:
  - 11 shape converter lines, such as `Setting{Value: <subject>, Default: <sibling>}`;
  - 4 import lines.

  None of these 15 is among main's errors, misses or disagreements.
- **Sibling names can survive.** An unsymbolled preamble line can still name a sibling's type. For example, S023 keeps `type countryNamesKey struct{}`.
- **Identical requests.** F07 and F08 become byte-identical requests: two different-subject changes collapse onto the same anchor code.

**Hand-check.** A seeded sample of 16 synthetic anchor views was read: `node scripts/sample.ts 16 2026`, covering S009, S013, S023, S030, S035, S044, S057, S060, S065, S076, S089, S120, S121, S129, S133 and S156.
- 16/16 carry only subject code, and the effect value can be read from the view.
- 6 more views from the mixed families were also read: S044, S092, S094, S171, S172 and S192.

```
$ node scripts/build-dataset.ts
{"total":242,"bySource":{"s17":40,"forge-lite":8,"synthetic":194},"core":179,"coreContradiction":101,"coreCompatible":78,
 "decoys":63,"decoySameSubjectCompatible":22,"decoyDifferentSubject":41,"byLanguage":{"typescript":72,"go":58,"python":64,"c":22,"hcl":26},
 "rotations":[81,81,80],"strip":{"itemsWithComments":28,...,"byLanguage":{"typescript":12,"go":7,"python":7,"hcl":2}},
 "anchorView":{"byKind":{"identity":38,"sub-diff":6,"symbol-only":2,"fixture":2,"renderer":194},"untouched":41,
   "untouchedByKind":{"decoy-different-subject":41},"noHunks":["D06","D08"],"touchedLosingChangedLines":[D04, D05 (by design), 15 synthetic],
   "scopedDuplicates":["F08=F07"]}}
$ pnpm exec tsc --noEmit && pnpm run lint && pnpm exec vitest run
tsc exit=0   lint exit=0
 Test Files  4 passed (4)
      Tests  27 passed (27)
```

The dataset is S17b's 242 items, with the same diffs, effects and labels. Labels never come from Clef. The unstripped state is S17b's own: the build reproduces it byte for byte, and `s17c-dataset.json` adds `rotation`, `anchors` and `states.{stripped, scoped}`. The 726 recorded requests rebuild from the committed dataset to the same prompt bytes and slot order, 726/726.

## Results

`node scripts/analyze.ts` writes `results/eval-report.json`, and `node scripts/tables.ts` renders the tables below. The intervals are Wilson 95%.

```
overall (mass gate)    n=242 R 98.0% [93.1-99.5] (99/101) | P 96.1% [90.4-98.5] (99/103) | dFP 6.3% [2.5-15.2] (4/63) | agree 94.2% [90.5-96.5] (228/242) | cov 95.0% [91.5-97.1] (230/242)
flip 3.9% [2.7-5.5] (28/726) | verdict-agree 97.1% [94.2-98.6] (235/242) | unclear 2.8% [1.8-4.2] (20/726) | v0 acc 91.7% [87.6-94.6] | compatFP 0.0% [0.0-4.7] (0/78)
misses: S041, S066 (both abstain; no silent miss)
false flags: D02, F03, S060, S062
```

### Each fix's effect

| Run | Agreement | Recall | Precision | Decoy FP | Coverage | False flags |
|---|---|---|---|---|---|---|
| no fix (S17b main) (`s17b`) | 90.9% (220/242) [86.6–93.9] | 97.0% (98/101) [91.6–99.0] | 91.6% (98/107) [84.8–95.5] | 14.3% (9/63) [7.7–25.0] | 90.5% (219/242) [86.1–93.6] | D02, F03, S021, S027, S059, S060, S146, S147, S148 |
| fix 1: comments stripped (`c1`) | 90.9% (220/242) [86.6–93.9] | 98.0% (99/101) [93.1–99.5] | 91.7% (99/108) [84.9–95.5] | 14.3% (9/63) [7.7–25.0] | 90.9% (220/242) [86.6–93.9] | D02, F03, S021, S027, S059, S060, S146, S147, S148 |
| fixes 1+2: + position balance (`c2`) | 92.2% (223/242) [88.1–94.9] | 98.0% (99/101) [93.1–99.5] | 90.8% (99/109) [83.9–94.9] | 15.9% (10/63) [8.9–26.8] | 91.3% (221/242) [87.1–94.3] | D02, F03, S021, S027, S059, S060, S062, S146, S147, S148 |
| fixes 1+2+3: + anchor scoping (`main`) | 94.2% (228/242) [90.5–96.5] | 98.0% (99/101) [93.1–99.5] | 96.1% (99/103) [90.4–98.5] | 6.3% (4/63) [2.5–15.2] | 95.0% (230/242) [91.5–97.1] | D02, F03, S060, S062 |

Item-level transitions, from `node scripts/determinism.ts`. "Now agree" means all three asks agree; the p-value is an exact McNemar test.

```
s17b -> c1:   now agree 1 [F07]                                       | now disagree 1 [D08]                          | net +0 | p = 1.000
c1 -> c2:     now agree 8 [D09 F06 S047 S062 S079 S095 S116 S170]     | now disagree 5 [F07 S041 S078 S096 S145]      | net +3 | p = 0.581
c2 -> main:   now agree 11 [D08 F07 S024 S025 S041 S058 S063 S096 S129 S130 S145] | now disagree 6 [S047 S059 S088 S115 S141 S167] | net +5 | p = 0.332
s17b -> main: now agree 14 | now disagree 6 | net +8 | p = 0.115
```

**Fix 1 (comments): agreement +0.0 pp, recall +1.0 pp, decoy FP ±0.**
- Only the 28 commented items can move.
- **F06 is now caught.** With its context doc comment on the dead `evict()` stripped, it moves from ttl / unclear / unclear (abstain) to ttl / per-session / per-session, all of which violate.
- **D08 now splits.** S17b's unanimous `fifo` rested on a context comment, `auditWriter.Start(ctx) // single goroutine: preserves append order`. S17b's leak guard missed it because the comment says "preserves append order", not "preserves order". This is finding (a) in its sharpest form: a verdict hung on a comment the guard did not catch.
- **F07** goes from abstain to compatible.
- **The S17 subset** dips from 95.0% to 92.5% because of D08.

**Fix 2 (position balance): agreement +1.3 pp (p = 0.58), decoy FP +1.6 pp.** It changes the ask order of 161 items, re-drawing their position noise: 8 gained and 5 lost. One new false flag appears, S062.

**Fix 3 (anchor scoping): agreement +2.0 pp (p = 0.33), decoy FP −9.6 pp, precision +5.3 pp.**
- Agreement on different-subject decoys rises from 75.6% to 92.7%.
- **It can cost agreement on touched items.** S088, S115, S141 and S167 split once the full anchor was shown. All four still decide correctly or abstain.

| Kind | n | S17b | c1 | c2 | main |
|---|---|---|---|---|---|
| core contradiction | 101 | 97.0% | 97.0% | 97.0% | 98.0% |
| core compatible | 78 | 92.3% | 92.3% | 94.9% | 89.7% |
| decoy, same subject | 22 | 90.9% | 90.9% | 90.9% | 95.5% |
| decoy, different subject | 41 | 73.2% | 73.2% | 75.6% | **92.7%** |

Relabelled agreement by predicate:

| Predicate | n | S17b | c1 | c2 | main |
|---|---|---|---|---|---|
| freshness | 45 | 88.9% | 91.1% | 91.1% | 97.8% |
| cardinality | 21 | 85.7% | 85.7% | 85.7% | 90.5% |
| ordering | 21 | 81.0% | 76.2% | 85.7% | 85.7% |
| consistency | 21 | 76.2% | 76.2% | 76.2% | 81.0% |
| presence | 21 | 95.2% | 95.2% | 95.2% | 95.2% |
| authority | 40 | 92.5% | 92.5% | 95.0% | 97.5% |
| purity | 21 | 100% | 100% | 95.2% | 95.2% |
| bound | 28 | 96.4% | 96.4% | 100% | 96.4% |
| shape | 24 | 100% | 100% | 100% | 100% |

### The S17 subset and forge-lite, reported separately

| Source | s17b | c1 | c2 | main |
|---|---|---|---|---|
| s17 | 95.0% (38/40) [83.5–98.6] / 100.0% / 10.0% | 92.5% (37/40) [80.1–97.4] / 100.0% / 10.0% | 95.0% (38/40) [83.5–98.6] / 100.0% / 10.0% | 97.5% (39/40) [87.1–99.6] / 100.0% / 10.0% |
| forge-lite | 75.0% (6/8) [40.9–92.8] / 75.0% / 25.0% | 87.5% (7/8) [52.9–97.8] / 100.0% / 25.0% | 87.5% (7/8) [52.9–97.8] / 100.0% / 25.0% | 100.0% (8/8) [67.6–100.0] / 100.0% / 25.0% |
| synthetic | 90.7% (176/194) [85.8–94.0] / 97.3% / 14.3% | 90.7% (176/194) [85.8–94.0] / 97.3% / 14.3% | 91.8% (178/194) [87.0–94.9] / 97.3% / 16.3% | 93.3% (181/194) [88.9–96.0] / 97.3% / 4.1% |

**The S17 subset in main** (40 items):
- agreement 97.5% (39/40), interval 87.1–99.6%;
- recall 100% (22/22), interval 85.1–100%;
- decoy FP 10.0% (1/10: D02);
- coverage 92.5%.

The point estimate clears 95% on this subset, but 40 items cannot distinguish 97.5% from 90%.

**forge-lite** (8 items): agreement 8/8, recall 4/4, decoy FP 1/4 (F03).

| Id | What | Label | S17b | main (all three fixes) | Violating mass, main |
|---|---|---|---|---|---|
| F01 | B: per-(session, repo) cache, no invalidation | contradiction | per-session ×3 | per-session ×3 → contradiction | 0.77–0.86 |
| F02 | careless "simplify" (S-2) | contradiction | per-session ×3 | per-session ×3 → contradiction | 0.67–0.83 |
| **F03** | **B′: invalidated on revoke** | **compatible** | per-session ×3 | **per-session ×3 → contradiction (wrong)** | **0.60–0.84** |
| F04 | 60 s TTL variant | contradiction | ttl ×3 | ttl ×3 → contradiction | 0.95–0.98 |
| F05 | per-request memo | compatible | per-request ×3 | per-request ×3 → compatible | 0.01–0.02 |
| F06 | subscription dropped, `evict()` dead | contradiction | ttl / unclear / unclear → abstain | per-session ×3 → contradiction | 0.67–0.82 |
| F07 | A: revoke route, subject untouched | compatible | unclear / per-call / unclear → abstain | per-call ×3 → compatible (fixture view) | 0.02–0.04 |
| F08 | per-session cache elsewhere | compatible | per-call ×3 | per-call ×3 → compatible (fixture view) | 0.03 |

**B′ is still answered per-session, and anchor scoping cannot change that.**
- **Why scoping is a no-op here.** Every symbol B′ touches belongs to the subject: the cache, its `evict()`, the `collaborator.removed` subscription, and `callerRole`. Its anchor view is therefore its whole diff, and main's request for F03 is byte-identical to c2's.
- **What Clef sees.** The subscription and eviction are visible to Clef, with comments stripped, and Clef still calls the cache per-session.
- **The upshot.** Clef gives B, B′ and both "simplify" regressions (F02, F06) the same answer. S17b's finding 3 stands: the S-2 contradiction needs a deterministic invalidation-edge extractor.

### Position (fix 2)

| Run | Accuracy by slot 1/2/3 | Slot agrees with majority 1/2/3 | Odd one out by slot 1/2/3 | Odd one out by relabelling v0/v1/v2 | Agreement by rotation group (v0 / v1 / v2 first) |
|---|---|---|---|---|---|
| `s17b` | 85.1% / 85.1% / 86.0% | 93.4% / 97.9% / 97.9% | 14 / 3 / 3 | 14 / 3 / 3 | 97.5% (79/81) [91.4–99.3] · 85.2% (69/81) [75.9–91.3] · 90.0% (72/80) [81.5–94.8] |
| `c1` | 85.1% / 85.5% / 86.4% | 93.4% / 97.9% / 97.9% | 14 / 3 / 3 | 14 / 3 / 3 | 96.3% (78/81) [89.7–98.7] · 85.2% (69/81) [75.9–91.3] · 91.3% (73/80) [83.0–95.7] |
| `c2` | 85.5% / 87.6% / 86.4% | 95.5% / 98.4% / 98.4% | 11 / 4 / 4 | 6 / 7 / 6 | 96.3% (78/81) [89.7–98.7] · 87.6% (71/81) [78.7–93.2] · 92.5% (74/80) [84.6–96.5] |
| `main` | 92.2% / 92.2% / 91.3% | 95.0% / 100.0% / 99.2% | 12 / 0 / 2 | 3 / 6 / 5 | 98.8% (80/81) [93.3–99.8] · 90.1% (73/81) [81.7–94.9] · 93.8% (75/80) [86.2–97.3] |

**Agreement per position.** "Slot agrees with majority" is each slot's agreement with the other two. In main:
- slot 1: 95.0%;
- slot 2: 100%;
- slot 3: 99.2%.

**The first-inserted ask is still the odd one out:** in 12 of the 14 items where exactly one ask differs.
- **Rotation moves the effect across relabellings without removing it.** In c2, the odd one out falls 6 / 7 / 6 on v0 / v1 / v2, against 14 / 3 / 3 in S17b, where v0 was always first. Slot 1 still takes 11 of 19.
- **The rotation-group column is item composition, not "which relabelling went first".** The same item subsets already differ without rotation: 97.5% / 85.2% / 90.0% in S17b, where v0 was first everywhere.

### S17b's 9 false flags, before and after

| Id | Kind | Truth | Before (S17b) | c1 | c2 | After (main) | Gone? |
|---|---|---|---|---|---|---|---|
| D02 | same subject (version-keyed cache) | strong | read-your-writes ×3 | same | same | read-your-writes ×3 → contradiction | **no**: the view is its whole diff |
| F03 | same subject (B′) | per-call | per-session ×3 | same | same | per-session ×3 → contradiction | **no**: the view is its whole diff |
| S021 | different subject (fr-ts) | per-request | per-session ×3 | same | same | per-request ×3 → compatible | **yes** |
| S027 | same subject, trap (fr-py) | per-request | ttl ×3 | same | same | per-request ×3 → compatible | **yes** |
| S059 | different subject (or-go) | fifo | per-key-fifo ×3 | same | same | fifo / fifo / unclear → abstain | **yes** (abstains) |
| S060 | different subject (or-py) | fifo | unordered ×3 | same | same | per-key-fifo ×3 → contradiction | **no**: now a misreading of the subject itself |
| S146 | different subject (pu-py) | idempotent | non-idempotent ×3 | same | same | idempotent ×3 → compatible | **yes** |
| S147 | different subject (pu-go) | pure | non-idempotent ×3 | same | same | pure ×3 → compatible | **yes** |
| S148 | different subject (pu-c) | pure | non-idempotent ×3 | same | same | pure ×3 → compatible | **yes** |

**6 of 9 disappear, all in main**, so all six are due to anchor scoping:
- 5 of the 6 different-subject flags;
- 1 of the 3 same-subject flags, S027: a per-request `TTLCache` trap.
  - Its view drops two things: the sibling's context, and the import line `from cachetools import TTLCache, cached`, which also serves the sibling.
  - S027 is one of the 15 lost-line items. Its fix may come from that dropped import rather than from scoping as such.

Fixes 1 and 2 remove none.

**One new false flag: S062,** the or-py near miss. It appeared with rotation in c2 and stays in main.
- S060 and S062 are both `relay_events`, which publishes rows sequentially with `key=row.aggregate_id`. With only that code in view, Clef reads the partition key as per-key ordering (per-key-fifo ×3, 0.52–0.66).
- The template labels this fifo. The label is arguable, since a keyed transport orders per key. Labels were fixed before the runs and were not changed.

**What Keel would do in production.** The 41 untouched anchors are decided in code, not by Clef. With that policy:
- decoy FP is 4.8% (3/63: D02, F03, S062), interval 1.6–13.1%;
- coverage is 97.1%.

Clef answered `unclear` ×3 on both symbol-only states (D06, D08), so both abstain.

### Threshold sweep

**The rule.** It was fixed in `scripts/analyze.ts` before the runs were read. Each ask votes:
- **contradiction** if its mass on premise-violating values is ≥ t;
- **compatible** if its mass on the other lattice values (not `unclear`) is ≥ t;
- otherwise it does not vote, and an ask whose top choice is `unclear` never votes.

"All 3" decides when all three votes agree; "2 of 3" when at least two agree. Anything else escalates. Recall counts an escalated contradiction as not flagged, and coverage is the share decided (1 − escalated).

At t = 0.50, "all 3" flags exactly what S17b's gate flags. Its coverage is 94.2% rather than 95.0%, because compatible mass excludes `unclear`.

**No silent misses at any threshold, rule or predicate.** Every decided error in the sweep is a false flag.

**Overall (242 items)**

| t | rule | Precision | Recall | Decoy FP | Coverage | Escalated | Errors (FP / silent) |
|---|---|---|---|---|---|---|---|
| 0.50 | all 3 | 96.1% (99/103) [90.4–98.5] | 98.0% (99/101) [93.1–99.5] | 6.3% (4/63) [2.5–15.2] | 94.2% (228/242) [90.5–96.5] | 5.8% | 4 (4 / 0) |
| 0.50 | 2 of 3 | 95.2% (100/105) [89.3–98.0] | 99.0% (100/101) [94.6–99.8] | 6.3% (4/63) [2.5–15.2] | 96.7% (234/242) [93.6–98.3] | 3.3% | 5 (5 / 0) |
| 0.55 | all 3 | 96.1% (98/102) [90.3–98.5] | 97.0% (98/101) [91.6–99.0] | 6.3% (4/63) [2.5–15.2] | 93.0% (225/242) [89.0–95.6] | 7.0% | 4 (4 / 0) |
| 0.55 | 2 of 3 | 96.2% (100/104) [90.5–98.5] | 99.0% (100/101) [94.6–99.8] | 6.3% (4/63) [2.5–15.2] | 95.9% (232/242) [92.6–97.7] | 4.1% | 4 (4 / 0) |
| 0.60 | all 3 | 96.9% (95/98) [91.4–99.0] | 94.1% (95/101) [87.6–97.3] | 4.8% (3/63) [1.6–13.1] | 90.5% (219/242) [86.1–93.6] | 9.5% | 3 (3 / 0) |
| 0.60 | 2 of 3 | 96.2% (100/104) [90.5–98.5] | 99.0% (100/101) [94.6–99.8] | 6.3% (4/63) [2.5–15.2] | 95.0% (230/242) [91.5–97.1] | 5.0% | 4 (4 / 0) |
| 0.65 | all 3 | 97.9% (92/94) [92.6–99.4] | 91.1% (92/101) [83.9–95.2] | 3.2% (2/63) [0.9–10.9] | 86.8% (210/242) [81.9–90.5] | 13.2% | 2 (2 / 0) |
| 0.65 | 2 of 3 | 97.1% (100/103) [91.8–99.0] | 99.0% (100/101) [94.6–99.8] | 4.8% (3/63) [1.6–13.1] | 94.2% (228/242) [90.5–96.5] | 5.8% | 3 (3 / 0) |
| 0.70 | all 3 | 98.9% (87/88) [93.8–99.8] | 86.1% (87/101) [78.1–91.6] | 1.6% (1/63) [0.3–8.5] | 81.8% (198/242) [76.5–86.2] | 18.2% | 1 (1 / 0) |
| 0.70 | 2 of 3 | 98.0% (98/100) [93.0–99.5] | 97.0% (98/101) [91.6–99.0] | 3.2% (2/63) [0.9–10.9] | 91.3% (221/242) [87.1–94.3] | 8.7% | 2 (2 / 0) |
| 0.75 | all 3 | 100.0% (83/83) [95.6–100.0] | 82.2% (83/101) [73.6–88.4] | 0.0% (0/63) [0.0–5.8] | 77.7% (188/242) [72.0–82.5] | 22.3% | 0 (0 / 0) |
| 0.75 | 2 of 3 | 97.9% (94/96) [92.7–99.4] | 93.1% (94/101) [86.4–96.6] | 3.2% (2/63) [0.9–10.9] | 89.3% (216/242) [84.7–92.6] | 10.7% | 2 (2 / 0) |
| 0.80 | all 3 | 100.0% (78/78) [95.3–100.0] | 77.2% (78/101) [68.1–84.3] | 0.0% (0/63) [0.0–5.8] | 74.0% (179/242) [68.1–79.1] | 26.0% | 0 (0 / 0) |
| 0.80 | 2 of 3 | 98.9% (89/90) [94.0–99.8] | 88.1% (89/101) [80.4–93.1] | 1.6% (1/63) [0.3–8.5] | 83.1% (201/242) [77.8–87.3] | 16.9% | 1 (1 / 0) |
| 0.85 | all 3 | 100.0% (73/73) [95.0–100.0] | 72.3% (73/101) [62.8–80.1] | 0.0% (0/63) [0.0–5.8] | 69.0% (167/242) [62.9–74.5] | 31.0% | 0 (0 / 0) |
| 0.85 | 2 of 3 | 100.0% (84/84) [95.6–100.0] | 83.2% (84/101) [74.7–89.2] | 0.0% (0/63) [0.0–5.8] | 78.9% (191/242) [73.4–83.6] | 21.1% | 0 (0 / 0) |
| 0.90 | all 3 | 100.0% (60/60) [94.0–100.0] | 59.4% (60/101) [49.6–68.5] | 0.0% (0/63) [0.0–5.8] | 56.2% (136/242) [49.9–62.3] | 43.8% | 0 (0 / 0) |
| 0.90 | 2 of 3 | 100.0% (73/73) [95.0–100.0] | 72.3% (73/101) [62.8–80.1] | 0.0% (0/63) [0.0–5.8] | 71.5% (173/242) [65.5–76.8] | 28.5% | 0 (0 / 0) |
| 0.95 | all 3 | 100.0% (42/42) [91.6–100.0] | 41.6% (42/101) [32.5–51.3] | 0.0% (0/63) [0.0–5.8] | 34.7% (84/242) [29.0–40.9] | 65.3% | 0 (0 / 0) |
| 0.95 | 2 of 3 | 100.0% (58/58) [93.8–100.0] | 57.4% (58/101) [47.7–66.6] | 0.0% (0/63) [0.0–5.8] | 51.6% (125/242) [45.4–57.9] | 48.4% | 0 (0 / 0) |

**For comparison, S17b with no fix.** Under "all 3", errors remain until t = 0.95. Under "2 of 3", one error remains even at 0.95.
- At "all 3" ≥ 0.80, S17b still had 2 false flags, at a coverage of 70.7%.
- Main is error-free from 0.75 ("all 3") or 0.85 ("2 of 3").

**S17b's run, no fix, overall**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 97.0% / 14.3% / 87.6%, **9** | 94.1% / 12.7% / 85.1%, **8** | 92.1% / 12.7% / 84.3%, **8** | 90.1% / 11.1% / 81.8%, **7** | 89.1% / 11.1% / 79.8%, **7** | 85.2% / 7.9% / 76.0%, **5** | 81.2% / 3.2% / 70.7%, **2** | 71.3% / 3.2% / 63.2%, **2** | 61.4% / 3.2% / 53.3%, **2** | 44.5% / 0.0% / 35.5% |
| 2 of 3 | 97.0% / 19.1% / 92.2%, **12** | 97.0% / 17.5% / 91.7%, **11** | 97.0% / 14.3% / 90.5%, **9** | 95.0% / 12.7% / 88.4%, **8** | 93.1% / 11.1% / 85.5%, **7** | 91.1% / 11.1% / 84.3%, **7** | 87.1% / 9.5% / 82.2%, **6** | 81.2% / 6.3% / 76.0%, **4** | 70.3% / 4.8% / 67.4%, **3** | 56.4% / 1.6% / 50.0%, **1** |

**The weak predicates.** Each has n = 21, so a single item moves a rate by about 5 points.

**consistency (21 items)**

| t | rule | Precision | Recall | Decoy FP | Coverage | Escalated | Errors (FP / silent) |
|---|---|---|---|---|---|---|---|
| 0.50 | all 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 71.4% (15/21) [50.0–86.2] | 28.6% | 1 (1 / 0) |
| 0.50 | 2 of 3 | 77.8% (7/9) [45.3–93.7] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 76.2% (16/21) [54.9–89.4] | 23.8% | 2 (2 / 0) |
| 0.55 | all 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 71.4% (15/21) [50.0–86.2] | 28.6% | 1 (1 / 0) |
| 0.55 | 2 of 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 71.4% (15/21) [50.0–86.2] | 28.6% | 1 (1 / 0) |
| 0.60 | all 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 66.7% (14/21) [45.4–82.8] | 33.3% | 1 (1 / 0) |
| 0.60 | 2 of 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 66.7% (14/21) [45.4–82.8] | 33.3% | 1 (1 / 0) |
| 0.65 | all 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 66.7% (14/21) [45.4–82.8] | 33.3% | 1 (1 / 0) |
| 0.65 | 2 of 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 66.7% (14/21) [45.4–82.8] | 33.3% | 1 (1 / 0) |
| 0.70 | all 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 61.9% (13/21) [40.9–79.3] | 38.1% | 1 (1 / 0) |
| 0.70 | 2 of 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 66.7% (14/21) [45.4–82.8] | 33.3% | 1 (1 / 0) |
| 0.75 | all 3 | 100.0% (6/6) [61.0–100.0] | 75.0% (6/8) [40.9–92.8] | 0.0% (0/6) [0.0–39.0] | 47.6% (10/21) [28.3–67.6] | 52.4% | 0 (0 / 0) |
| 0.75 | 2 of 3 | 87.5% (7/8) [52.9–97.8] | 87.5% (7/8) [52.9–97.8] | 16.7% (1/6) [3.0–56.4] | 66.7% (14/21) [45.4–82.8] | 33.3% | 1 (1 / 0) |
| 0.80 | all 3 | 100.0% (4/4) [51.0–100.0] | 50.0% (4/8) [21.5–78.5] | 0.0% (0/6) [0.0–39.0] | 38.1% (8/21) [20.8–59.1] | 61.9% | 0 (0 / 0) |
| 0.80 | 2 of 3 | 100.0% (6/6) [61.0–100.0] | 75.0% (6/8) [40.9–92.8] | 0.0% (0/6) [0.0–39.0] | 47.6% (10/21) [28.3–67.6] | 52.4% | 0 (0 / 0) |
| 0.85 | all 3 | 100.0% (1/1) [20.6–100.0] | 12.5% (1/8) [2.2–47.1] | 0.0% (0/6) [0.0–39.0] | 19.1% (4/21) [7.7–40.0] | 81.0% | 0 (0 / 0) |
| 0.85 | 2 of 3 | 100.0% (5/5) [56.5–100.0] | 62.5% (5/8) [30.6–86.3] | 0.0% (0/6) [0.0–39.0] | 42.9% (9/21) [24.5–63.4] | 57.1% | 0 (0 / 0) |
| 0.90 | all 3 | 100.0% (1/1) [20.6–100.0] | 12.5% (1/8) [2.2–47.1] | 0.0% (0/6) [0.0–39.0] | 9.5% (2/21) [2.6–28.9] | 90.5% | 0 (0 / 0) |
| 0.90 | 2 of 3 | 100.0% (2/2) [34.2–100.0] | 25.0% (2/8) [7.1–59.1] | 0.0% (0/6) [0.0–39.0] | 19.1% (4/21) [7.7–40.0] | 81.0% | 0 (0 / 0) |
| 0.95 | all 3 | — (0/0) | 0.0% (0/8) [0.0–32.4] | 0.0% (0/6) [0.0–39.0] | 0.0% (0/21) [0.0–15.5] | 100.0% | 0 (0 / 0) |
| 0.95 | 2 of 3 | — (0/0) | 0.0% (0/8) [0.0–32.4] | 0.0% (0/6) [0.0–39.0] | 4.8% (1/21) [0.9–22.7] | 95.2% | 0 (0 / 0) |

**ordering (21 items)**

| t | rule | Precision | Recall | Decoy FP | Coverage | Escalated | Errors (FP / silent) |
|---|---|---|---|---|---|---|---|
| 0.50 | all 3 | 80.0% (8/10) [49.0–94.3] | 100.0% (8/8) [67.6–100.0] | 33.3% (2/6) [9.7–70.0] | 81.0% (17/21) [60.0–92.3] | 19.1% | 2 (2 / 0) |
| 0.50 | 2 of 3 | 80.0% (8/10) [49.0–94.3] | 100.0% (8/8) [67.6–100.0] | 33.3% (2/6) [9.7–70.0] | 95.2% (20/21) [77.3–99.2] | 4.8% | 2 (2 / 0) |
| 0.55 | all 3 | 80.0% (8/10) [49.0–94.3] | 100.0% (8/8) [67.6–100.0] | 33.3% (2/6) [9.7–70.0] | 81.0% (17/21) [60.0–92.3] | 19.1% | 2 (2 / 0) |
| 0.55 | 2 of 3 | 80.0% (8/10) [49.0–94.3] | 100.0% (8/8) [67.6–100.0] | 33.3% (2/6) [9.7–70.0] | 90.5% (19/21) [71.1–97.4] | 9.5% | 2 (2 / 0) |
| 0.60 | all 3 | 88.9% (8/9) [56.5–98.0] | 100.0% (8/8) [67.6–100.0] | 16.7% (1/6) [3.0–56.4] | 76.2% (16/21) [54.9–89.4] | 23.8% | 1 (1 / 0) |
| 0.60 | 2 of 3 | 80.0% (8/10) [49.0–94.3] | 100.0% (8/8) [67.6–100.0] | 33.3% (2/6) [9.7–70.0] | 90.5% (19/21) [71.1–97.4] | 9.5% | 2 (2 / 0) |
| 0.65 | all 3 | 88.9% (8/9) [56.5–98.0] | 100.0% (8/8) [67.6–100.0] | 16.7% (1/6) [3.0–56.4] | 71.4% (15/21) [50.0–86.2] | 28.6% | 1 (1 / 0) |
| 0.65 | 2 of 3 | 88.9% (8/9) [56.5–98.0] | 100.0% (8/8) [67.6–100.0] | 16.7% (1/6) [3.0–56.4] | 81.0% (17/21) [60.0–92.3] | 19.1% | 1 (1 / 0) |
| 0.70 | all 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 66.7% (14/21) [45.4–82.8] | 33.3% | 0 (0 / 0) |
| 0.70 | 2 of 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 76.2% (16/21) [54.9–89.4] | 23.8% | 0 (0 / 0) |
| 0.75 | all 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 57.1% (12/21) [36.5–75.5] | 42.9% | 0 (0 / 0) |
| 0.75 | 2 of 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 76.2% (16/21) [54.9–89.4] | 23.8% | 0 (0 / 0) |
| 0.80 | all 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 57.1% (12/21) [36.5–75.5] | 42.9% | 0 (0 / 0) |
| 0.80 | 2 of 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 66.7% (14/21) [45.4–82.8] | 33.3% | 0 (0 / 0) |
| 0.85 | all 3 | 100.0% (7/7) [64.6–100.0] | 87.5% (7/8) [52.9–97.8] | 0.0% (0/6) [0.0–39.0] | 52.4% (11/21) [32.4–71.7] | 47.6% | 0 (0 / 0) |
| 0.85 | 2 of 3 | 100.0% (7/7) [64.6–100.0] | 87.5% (7/8) [52.9–97.8] | 0.0% (0/6) [0.0–39.0] | 57.1% (12/21) [36.5–75.5] | 42.9% | 0 (0 / 0) |
| 0.90 | all 3 | 100.0% (3/3) [43.9–100.0] | 37.5% (3/8) [13.7–69.4] | 0.0% (0/6) [0.0–39.0] | 23.8% (5/21) [10.6–45.1] | 76.2% | 0 (0 / 0) |
| 0.90 | 2 of 3 | 100.0% (5/5) [56.5–100.0] | 62.5% (5/8) [30.6–86.3] | 0.0% (0/6) [0.0–39.0] | 47.6% (10/21) [28.3–67.6] | 52.4% | 0 (0 / 0) |
| 0.95 | all 3 | — (0/0) | 0.0% (0/8) [0.0–32.4] | 0.0% (0/6) [0.0–39.0] | 0.0% (0/21) [0.0–15.5] | 100.0% | 0 (0 / 0) |
| 0.95 | 2 of 3 | 100.0% (3/3) [43.9–100.0] | 37.5% (3/8) [13.7–69.4] | 0.0% (0/6) [0.0–39.0] | 19.1% (4/21) [7.7–40.0] | 81.0% | 0 (0 / 0) |

**cardinality (21 items)**

| t | rule | Precision | Recall | Decoy FP | Coverage | Escalated | Errors (FP / silent) |
|---|---|---|---|---|---|---|---|
| 0.50 | all 3 | 100.0% (7/7) [64.6–100.0] | 87.5% (7/8) [52.9–97.8] | 0.0% (0/6) [0.0–39.0] | 95.2% (20/21) [77.3–99.2] | 4.8% | 0 (0 / 0) |
| 0.50 | 2 of 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 100.0% (21/21) [84.5–100.0] | 0.0% | 0 (0 / 0) |
| 0.55 | all 3 | 100.0% (6/6) [61.0–100.0] | 75.0% (6/8) [40.9–92.8] | 0.0% (0/6) [0.0–39.0] | 90.5% (19/21) [71.1–97.4] | 9.5% | 0 (0 / 0) |
| 0.55 | 2 of 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 100.0% (21/21) [84.5–100.0] | 0.0% | 0 (0 / 0) |
| 0.60 | all 3 | 100.0% (5/5) [56.5–100.0] | 62.5% (5/8) [30.6–86.3] | 0.0% (0/6) [0.0–39.0] | 85.7% (18/21) [65.4–95.0] | 14.3% | 0 (0 / 0) |
| 0.60 | 2 of 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 100.0% (21/21) [84.5–100.0] | 0.0% | 0 (0 / 0) |
| 0.65 | all 3 | 100.0% (3/3) [43.9–100.0] | 37.5% (3/8) [13.7–69.4] | 0.0% (0/6) [0.0–39.0] | 71.4% (15/21) [50.0–86.2] | 28.6% | 0 (0 / 0) |
| 0.65 | 2 of 3 | 100.0% (8/8) [67.6–100.0] | 100.0% (8/8) [67.6–100.0] | 0.0% (0/6) [0.0–39.0] | 100.0% (21/21) [84.5–100.0] | 0.0% | 0 (0 / 0) |
| 0.70 | all 3 | 100.0% (1/1) [20.6–100.0] | 12.5% (1/8) [2.2–47.1] | 0.0% (0/6) [0.0–39.0] | 57.1% (12/21) [36.5–75.5] | 42.9% | 0 (0 / 0) |
| 0.70 | 2 of 3 | 100.0% (6/6) [61.0–100.0] | 75.0% (6/8) [40.9–92.8] | 0.0% (0/6) [0.0–39.0] | 90.5% (19/21) [71.1–97.4] | 9.5% | 0 (0 / 0) |
| 0.75 | all 3 | 100.0% (1/1) [20.6–100.0] | 12.5% (1/8) [2.2–47.1] | 0.0% (0/6) [0.0–39.0] | 57.1% (12/21) [36.5–75.5] | 42.9% | 0 (0 / 0) |
| 0.75 | 2 of 3 | 100.0% (4/4) [51.0–100.0] | 50.0% (4/8) [21.5–78.5] | 0.0% (0/6) [0.0–39.0] | 81.0% (17/21) [60.0–92.3] | 19.1% | 0 (0 / 0) |
| 0.80 | all 3 | — (0/0) | 0.0% (0/8) [0.0–32.4] | 0.0% (0/6) [0.0–39.0] | 52.4% (11/21) [32.4–71.7] | 47.6% | 0 (0 / 0) |
| 0.80 | 2 of 3 | 100.0% (3/3) [43.9–100.0] | 37.5% (3/8) [13.7–69.4] | 0.0% (0/6) [0.0–39.0] | 76.2% (16/21) [54.9–89.4] | 23.8% | 0 (0 / 0) |
| 0.85 | all 3 | — (0/0) | 0.0% (0/8) [0.0–32.4] | 0.0% (0/6) [0.0–39.0] | 47.6% (10/21) [28.3–67.6] | 52.4% | 0 (0 / 0) |
| 0.85 | 2 of 3 | 100.0% (3/3) [43.9–100.0] | 37.5% (3/8) [13.7–69.4] | 0.0% (0/6) [0.0–39.0] | 71.4% (15/21) [50.0–86.2] | 28.6% | 0 (0 / 0) |
| 0.90 | all 3 | — (0/0) | 0.0% (0/8) [0.0–32.4] | 0.0% (0/6) [0.0–39.0] | 28.6% (6/21) [13.8–50.0] | 71.4% | 0 (0 / 0) |
| 0.90 | 2 of 3 | 100.0% (2/2) [34.2–100.0] | 25.0% (2/8) [7.1–59.1] | 0.0% (0/6) [0.0–39.0] | 61.9% (13/21) [40.9–79.3] | 38.1% | 0 (0 / 0) |
| 0.95 | all 3 | — (0/0) | 0.0% (0/8) [0.0–32.4] | 0.0% (0/6) [0.0–39.0] | 4.8% (1/21) [0.9–22.7] | 95.2% | 0 (0 / 0) |
| 0.95 | 2 of 3 | — (0/0) | 0.0% (0/8) [0.0–32.4] | 0.0% (0/6) [0.0–39.0] | 19.1% (4/21) [7.7–40.0] | 81.0% | 0 (0 / 0) |

**Why each one is weak:**
- **Cardinality's contradictions carry modest violating mass in at least one ask.** Under "all 3", recall collapses from 87.5% at 0.50 to 12.5% at 0.70. "2 of 3" holds 100% recall to 0.65.
- **Ordering's two false flags are S060 and S062.** They disappear at 0.70 under both rules.
- **Consistency's false flag is D02.** It disappears at 0.75 under "all 3", where coverage falls to 47.6%.

**The other predicates, compactly.** Each cell is recall / decoy FP / coverage; a bold number is the count of decided errors. The full rows, with Wilson intervals for every cell under both rules, are in `results/eval-report.json` under `sweep.byPredicate`, `sweep.bySource` and `sweep.touchedOnly`.

**freshness (45 items)**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 100.0% / 6.3% / 95.6%, **1** | 100.0% / 6.3% / 93.3%, **1** | 100.0% / 6.3% / 93.3%, **1** | 100.0% / 0.0% / 88.9% | 88.9% / 0.0% / 82.2% | 88.9% / 0.0% / 80.0% | 83.3% / 0.0% / 75.6% | 83.3% / 0.0% / 73.3% | 61.1% / 0.0% / 62.2% | 44.4% / 0.0% / 46.7% |
| 2 of 3 | 100.0% / 6.3% / 95.6%, **1** | 100.0% / 6.3% / 95.6%, **1** | 100.0% / 6.3% / 95.6%, **1** | 100.0% / 6.3% / 95.6%, **1** | 100.0% / 6.3% / 91.1%, **1** | 94.4% / 6.3% / 88.9%, **1** | 88.9% / 6.3% / 86.7%, **1** | 83.3% / 0.0% / 77.8% | 83.3% / 0.0% / 73.3% | 66.7% / 0.0% / 60.0% |

**presence (21 items)**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 95.2% | 100.0% / 0.0% / 95.2% | 100.0% / 0.0% / 90.5% | 100.0% / 0.0% / 90.5% | 100.0% / 0.0% / 90.5% | 88.9% / 0.0% / 81.0% | 88.9% / 0.0% / 71.4% | 66.7% / 0.0% / 47.6% |
| 2 of 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 95.2% | 100.0% / 0.0% / 95.2% | 100.0% / 0.0% / 95.2% | 100.0% / 0.0% / 95.2% | 100.0% / 0.0% / 90.5% | 100.0% / 0.0% / 90.5% | 100.0% / 0.0% / 85.7% | 77.8% / 0.0% / 61.9% |

**authority (40 items)**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 97.5% | 100.0% / 0.0% / 95.0% | 100.0% / 0.0% / 95.0% | 100.0% / 0.0% / 92.5% | 100.0% / 0.0% / 87.5% | 72.2% / 0.0% / 70.0% | 61.1% / 0.0% / 55.0% |
| 2 of 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 97.5% | 100.0% / 0.0% / 95.0% | 100.0% / 0.0% / 95.0% | 88.9% / 0.0% / 90.0% | 72.2% / 0.0% / 70.0% |

**purity (21 items)**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 100.0% / 0.0% / 95.2% | 100.0% / 0.0% / 95.2% | 75.0% / 0.0% / 85.7% | 75.0% / 0.0% / 81.0% | 75.0% / 0.0% / 76.2% | 62.5% / 0.0% / 71.4% | 50.0% / 0.0% / 57.1% | 50.0% / 0.0% / 52.4% | 50.0% / 0.0% / 47.6% | 12.5% / 0.0% / 14.3% |
| 2 of 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 95.2% | 87.5% / 0.0% / 90.5% | 75.0% / 0.0% / 71.4% | 62.5% / 0.0% / 66.7% | 50.0% / 0.0% / 57.1% | 50.0% / 0.0% / 38.1% |

**bound (28 items)**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 96.4% | 100.0% / 0.0% / 96.4% | 90.9% / 0.0% / 92.9% | 81.8% / 0.0% / 89.3% | 63.6% / 0.0% / 78.6% | 63.6% / 0.0% / 78.6% | 63.6% / 0.0% / 78.6% | 63.6% / 0.0% / 67.9% | 36.4% / 0.0% / 42.9% |
| 2 of 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 96.4% | 100.0% / 0.0% / 96.4% | 90.9% / 0.0% / 92.9% | 81.8% / 0.0% / 89.3% | 63.6% / 0.0% / 82.1% | 54.5% / 0.0% / 75.0% |

**shape (24 items)**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 95.8% | 92.3% / 0.0% / 62.5% |
| 2 of 3 | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 100.0% | 100.0% / 0.0% / 79.2% |

**Touched anchors only (201 items)**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 98.0% / 13.6% / 95.5%, **3** | 97.0% / 13.6% / 94.0%, **3** | 94.1% / 13.6% / 91.5%, **3** | 91.1% / 9.1% / 88.6%, **2** | 86.1% / 4.5% / 84.6%, **1** | 82.2% / 0.0% / 80.6% | 77.2% / 0.0% / 76.1% | 72.3% / 0.0% / 70.7% | 59.4% / 0.0% / 58.2% | 41.6% / 0.0% / 39.3% |
| 2 of 3 | 99.0% / 13.6% / 98.0%, **4** | 99.0% / 13.6% / 97.5%, **3** | 99.0% / 13.6% / 96.5%, **3** | 99.0% / 13.6% / 96.0%, **3** | 97.0% / 9.1% / 93.0%, **2** | 93.1% / 9.1% / 91.0%, **2** | 88.1% / 4.5% / 85.6%, **1** | 83.2% / 0.0% / 82.1% | 72.3% / 0.0% / 73.6% | 57.4% / 0.0% / 55.2% |

**source s17**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 100.0% / 10.0% / 92.5%, **1** | 95.5% / 10.0% / 90.0%, **1** | 90.9% / 10.0% / 87.5%, **1** | 90.9% / 10.0% / 87.5%, **1** | 90.9% / 10.0% / 87.5%, **1** | 86.4% / 0.0% / 82.5% | 77.3% / 0.0% / 75.0% | 72.7% / 0.0% / 72.5% | 54.5% / 0.0% / 50.0% | 45.5% / 0.0% / 40.0% |
| 2 of 3 | 100.0% / 10.0% / 92.5%, **1** | 100.0% / 10.0% / 92.5%, **1** | 100.0% / 10.0% / 92.5%, **1** | 100.0% / 10.0% / 92.5%, **1** | 95.5% / 10.0% / 90.0%, **1** | 95.5% / 10.0% / 90.0%, **1** | 90.9% / 0.0% / 82.5% | 77.3% / 0.0% / 75.0% | 68.2% / 0.0% / 67.5% | 59.1% / 0.0% / 52.5% |

**source forge-lite**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 100.0% / 25.0% / 100.0%, **1** | 100.0% / 25.0% / 100.0%, **1** | 100.0% / 25.0% / 100.0%, **1** | 100.0% / 0.0% / 87.5% | 50.0% / 0.0% / 62.5% | 50.0% / 0.0% / 62.5% | 25.0% / 0.0% / 50.0% | 25.0% / 0.0% / 50.0% | 25.0% / 0.0% / 50.0% | 25.0% / 0.0% / 25.0% |
| 2 of 3 | 100.0% / 25.0% / 100.0%, **1** | 100.0% / 25.0% / 100.0%, **1** | 100.0% / 25.0% / 100.0%, **1** | 100.0% / 25.0% / 100.0%, **1** | 100.0% / 25.0% / 100.0%, **1** | 75.0% / 25.0% / 87.5%, **1** | 50.0% / 25.0% / 75.0%, **1** | 25.0% / 0.0% / 50.0% | 25.0% / 0.0% / 50.0% | 25.0% / 0.0% / 25.0% |

**source synthetic**

| rule | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 |
|---|---|---|---|---|---|---|---|---|---|---|
| all 3 | 97.3% / 4.1% / 94.3%, **2** | 97.3% / 4.1% / 93.3%, **2** | 94.7% / 2.0% / 90.7%, **1** | 90.7% / 2.0% / 86.6%, **1** | 86.7% / 0.0% / 81.4% | 82.7% / 0.0% / 77.3% | 80.0% / 0.0% / 74.7% | 74.7% / 0.0% / 69.1% | 62.7% / 0.0% / 57.7% | 41.3% / 0.0% / 34.0% |
| 2 of 3 | 98.7% / 4.1% / 97.4%, **3** | 98.7% / 4.1% / 96.4%, **2** | 98.7% / 4.1% / 95.4%, **2** | 98.7% / 2.0% / 94.3%, **1** | 97.3% / 0.0% / 91.2% | 93.3% / 0.0% / 89.2% | 89.3% / 0.0% / 83.5% | 88.0% / 0.0% / 80.9% | 76.0% / 0.0% / 73.2% | 58.7% / 0.0% / 52.6% |

### Recommended default thresholds

**How the recommendation was chosen.** The criterion was fixed before the runs were read.
1. For each rule, take the lowest t whose decided verdicts contain no error: no false flag and no silent miss. Decided sets only shrink as t rises, so this is the highest-coverage error-free setting.
2. Of the two rules, take the one with more coverage. A tie goes to "all 3".

The last column is the Wilson upper bound on the error rate of the decided verdicts. It shows how little "0 errors in n" proves.

| Scope | Lowest error-free t, all 3 (coverage) | Lowest error-free t, 2 of 3 (coverage) | Recommended | Coverage | Recall | Decided-error upper bound |
|---|---|---|---|---|---|---|
| overall | 0.75 (77.7%) | 0.85 (78.9%) | **2 of 3 ≥ 0.85** | 78.9% (191/242) [73.4–83.6] | 83.2% (84/101) [74.7–89.2] | 2.0% |
| touchedOnly | 0.75 (80.6%) | 0.85 (82.1%) | **2 of 3 ≥ 0.85** | 82.1% (165/201) [76.2–86.8] | 83.2% (84/101) [74.7–89.2] | 2.3% |
| freshness | 0.65 (88.9%) | 0.85 (77.8%) | **all 3 ≥ 0.65** | 88.9% (40/45) [76.5–95.2] | 100.0% (18/18) [82.4–100.0] | 8.8% |
| cardinality | 0.50 (95.2%) | 0.50 (100.0%) | **2 of 3 ≥ 0.50** | 100.0% (21/21) [84.5–100.0] | 100.0% (8/8) [67.6–100.0] | 15.5% |
| ordering | 0.70 (66.7%) | 0.70 (76.2%) | **2 of 3 ≥ 0.70** | 76.2% (16/21) [54.9–89.4] | 100.0% (8/8) [67.6–100.0] | 19.4% |
| consistency | 0.75 (47.6%) | 0.80 (47.6%) | **all 3 ≥ 0.75** | 47.6% (10/21) [28.3–67.6] | 75.0% (6/8) [40.9–92.8] | 27.8% |
| presence | 0.50 (100.0%) | 0.50 (100.0%) | **all 3 ≥ 0.50** | 100.0% (21/21) [84.5–100.0] | 100.0% (9/9) [70.1–100.0] | 15.5% |
| authority | 0.50 (100.0%) | 0.50 (100.0%) | **all 3 ≥ 0.50** | 100.0% (40/40) [91.2–100.0] | 100.0% (18/18) [82.4–100.0] | 8.8% |
| purity | 0.50 (95.2%) | 0.50 (100.0%) | **2 of 3 ≥ 0.50** | 100.0% (21/21) [84.5–100.0] | 100.0% (8/8) [67.6–100.0] | 15.5% |
| bound | 0.50 (100.0%) | 0.50 (100.0%) | **all 3 ≥ 0.50** | 100.0% (28/28) [87.9–100.0] | 100.0% (11/11) [74.1–100.0] | 12.1% |
| shape | 0.50 (100.0%) | 0.50 (100.0%) | **all 3 ≥ 0.50** | 100.0% (24/24) [86.2–100.0] | 100.0% (13/13) [77.2–100.0] | 13.8% |

```
Violating-mass threshold per predicate; Keel escalates below it.
  default (no per-predicate setting)  2 of 3 >= 0.85   coverage 78.9%, recall 83.2%, 0 errors in 191 decided
  shape         all 3  >= 0.50   no error at any threshold; coverage 100%
  presence      all 3  >= 0.50   no error at any threshold; coverage 100%
  authority     all 3  >= 0.50   no error at any threshold; coverage 100%
  bound         all 3  >= 0.50   no error at any threshold; coverage 100%
  purity        2 of 3 >= 0.50   no error at any threshold; coverage 100% ("all 3" loses recall from 0.60)
  cardinality   2 of 3 >= 0.50   no error at any threshold; coverage 100% ("all 3": recall 87.5% at 0.50, 12.5% at 0.70)
  freshness     all 3  >= 0.65   coverage 88.9%, recall 100%; B' (F03, min mass 0.60) sits just below
  ordering      2 of 3 >= 0.70   coverage 76.2%, recall 100%
  consistency   all 3  >= 0.75   coverage 47.6%, recall 75%: mostly escalates
```

**Caveats:**
- **The thresholds are chosen in-sample.** They are fitted on the same 242 items they are reported on.
- **The per-predicate sets are small** (n = 21–45). "0 errors" corresponds to decided-error upper bounds of 8.8–27.8%.
- **Freshness's 0.65 is fragile.** It excludes B′ only because one of B′'s three asks has 0.603 violating mass.
- **These are defaults, not proofs.** The sweep says where a configurable threshold should start. A held-out set has to confirm it before any of it carries a verdict.

## Truncation and latency

```
truncation {"cap":64000,"estimatorMaxTokens":3455,"estimatorOversize":[],"postCallAtCap":[],"minBytesPerToken":3.137}
latency {"callP50":226,"callP95":418,"callMax":570,"perQuestionP50":75.3,"perQuestionP95":139.3,"clientP50":256,"inputTokensP50":1054,"inputTokensMax":2062}
```

- Neither the estimator nor the post-call check tripped in any of the 726 calls.
- The lowest measured bytes per token was 3.14, which stays above the 2.5 floor.
- The anchor view did not raise the token count: p50 is 1,054 input tokens, against 1,074 in S17b.

## Pass/fail per criterion

| Criterion | Result | Interval | Verdict |
|---|---|---|---|
| Relabelled agreement ≥ 95% (main) | 94.2% (228/242) | 90.5–96.5% | **FAIL** (point below the bar; the interval spans it) |
| Recall ≥ 90% at the gate (keel-mass, t = 0.5) | 98.0% (99/101) | 93.1–99.5% | **PASS** (the lower bound clears the bar) |
| No truncation trips | 0 / 726 | — | **PASS** |
| S17 demo bar: decoy FP ≤ 20% | 6.3% (4/63) | 2.5–15.2% | **PASS** (the upper bound clears it too) |
| S17 subset (40), agreement / recall | 97.5% / 100% | 87.1–99.6 / 85.1–100% | point passes; too small to decide |
| B′ (F03) no longer answered per-session | per-session ×3 | — | **FAIL** |

## Go/no-go

**NO-GO for Clef deciding contradictions.** The pre-registered agreement bar fails for the second time, and S17b's fallback stays in force.

**Adopted in Keel's Clef adapter, for the ranking role it keeps:**
- **All three fixes.** Strip comments; rotate the ask order; send only the anchors' code, and decide untouched anchors in code without a call. Together they halve decoy false positives (14.3% → 6.3%) and lift precision from 91.6% to 96.1% at no cost in recall or latency.
- **The threshold defaults above** set the per-project escalation threshold that orders and gates which suspected conflicts get a probe first. The global default is "2 of 3 ≥ 0.85", with the per-predicate values as overrides.

**Clef-as-decider is not re-opened by this run.** Re-opening it would need two things:
- a held-out set that confirms the zero-error thresholds;
- a stability measure that is not capped by the first-slot effect (finding 2).

## Fallback

Unchanged from S17b:
- **Deterministic extractors and lattices decide.** They work from cache keys and invalidation edges, lock and constraint presence, concurrency constructs, guard calls, clamps and wire types.
- **Clef only ranks probes**, by violating mass. Its mass ordering is now cleaner: 0 compatible core items reach 0.5 violating mass in all three asks (0/78), and 4 of 63 decoys do, down from 9.
- **Whether a change touches a subject is decided in code, from anchors.** This run measures what that buys: all 41 different-subject decoys are recognised as untouched.

## Can-fail demonstrations

Each plant was made, the build run, and the file restored. The restored file's hash was checked against the original every time, and the dataset hash is unchanged afterwards (`56c9b6ba…` before and after; the later composition-only field moved it to `03030c96…`, and the requests rebuild 726/726).

1. **A mislabelled item fails the build.** C01 was relabelled `compatible`:
   ```
   Error: dataset check failed:
     C01: lattice says contradiction, written label is compatible
   build exit=1            restored: identical
   ```
2. **The leak guard still fails on a planted leak, and comment stripping stops the comment form.**
   - **The comment form.** `// Per-session cache of evaluated collaborator roles.` was added to F01's real hunk. The only failure is the S17b-reproduction check, which rejects any change to a base item. The leak guard reports nothing on the sent states, because the comment is no longer there:
     ```
     Error: dataset check failed:
       F01: does not reproduce S17b's item
     build exit=1
     ```
   - **The identifier form.** `RoleCache` was renamed `PerSessionRoleCache`, which survives stripping. The guard fails on both sent states:
     ```
     Error: dataset check failed:
       F01: does not reproduce S17b's item
       F01: state contains the ground-truth value "per-session" [stripped]
       F01: state contains the ground-truth value "per-session" [scoped]
     build exit=1            restored: identical
     ```
   - **The unit tests.** `test/strip.test.ts` plants the comment in a unit test, where it leaks before stripping and is clean after. The identifier form still leaks.
   - **A built-in tripwire.** The F07/F08 fixture view includes `requirePermission`'s doc comment, "…read from the store on every request". That phrase is a per-call synonym. If stripping ever failed, the guard would fail the build on F07 and F08.
3. **The stripper itself can fail.** Python comment handling was switched off:
   ```
   Error: dataset check failed:
     C03: a comment survives in billing/limits.py [stripped]
     C03: a comment survives in billing/limits.py [scoped]
     C07: a comment survives in migrations/versions/0042_relax_primary_email.py [stripped]
     ...
   build exit=1            restored: identical
   ```
4. **An anchor view that adds code fails.** A line was appended to D07's hand-cut view, and a fixture line in F07's view was edited:
   ```
   D07: anchor view line not in the original diff, in order: "+    _cache.clear()"     build exit=1
   F07: fixture line 25 differs: "     const role = cachedRole(c, repo);"                  build exit=1
   ```
5. **Removing the rotation fails the build and the tests:**
   ```
   Error: dataset check failed:
     rotation unbalanced: 242/0/0
    FAIL  test/lattice.test.ts          restored: identical; Test Files 4 passed (4), Tests 27 passed (27)
   ```
6. **The synthetic anchor views rest on S17b's diffs.** The build fails unless the re-rendered S17b diff is byte-identical, 194/194.
7. **The agreement bar fails again**, so it is not vacuous. The sweep's zero-error criterion also fails at low thresholds: overall it has 4 errors at "all 3" ≥ 0.50, and consistency still has 1 error at 0.70.

## Design-relevant findings

1. **Scope Clef to anchors.** It is the only fix that moved the numbers.
   - 5 of 6 unanimous sibling misattributions are gone, and decoy FP fell from 14.3% to 6.3%.
   - Agreement on different-subject decoys rose from 73% to 93%.
   - It cannot touch same-subject errors (D02, F03): their anchor view is their whole diff.
   - Showing a whole anchor can also unsettle answers that were stable: 4 touched items split.
   - In production the untouched case does not reach Clef at all: all 41 are decided in code.
2. **Within-call agreement is capped by the first-inserted ask, and rotation cannot lift the cap.**
   - After rotation, slot 1 is still the odd one out in 12 of 14 single-dissent items.
   - Slots 2 and 3 agree on 240/242, but S17b showed they are correlated, not independent.
   - Verdict agreement (97.1%) and the "2 of 3" rule tolerate this. The ≥ 95% value-agreement bar, as defined, is mostly a measure of slot 1.
   - Rotation is still worth keeping. It stops one relabelling from always taking the first-slot penalty: in S17b, v0 was the odd one out 14 times, and in c2 it is 6 / 7 / 6.
3. **Strip comments.**
   - **The aggregate is neutral, but a hidden dependency is real.** D08's S17b answer rested on a comment ("single goroutine: preserves append order") that the synonym-based leak guard missed, and F06 was masked by one.
   - **Stripping is the robust control.** The guard stays as a check on identifiers, strings and the question.
4. **Every remaining decided error is a confident false flag; there are no silent misses at any threshold.**
   - Raising the threshold trades coverage for precision cleanly.
   - With the fixes, errors vanish at "all 3" ≥ 0.75 or "2 of 3" ≥ 0.85, with about 78% coverage.
   - Without the fixes, errors remain to 0.90–0.95.
   - "2 of 3" beats "all 3" on coverage at equal error for most predicates, because it absorbs the slot-1 dissent.
5. **Predicate defaults diverge enough to be per-predicate.**
   - Shape, presence, authority and bound are error-free at 0.50.
   - Consistency needs 0.75 and still decides only 48%.
   - A single global threshold either over-escalates the easy predicates or under-protects consistency and ordering.
6. **Invalidation and versioning stay invisible.**
   - B′ (invalidated on revoke) and D02 (a cache keyed by a version read from the primary) are both read as a weaker lattice value, unanimously, with every relevant line in view and no comments.
   - These are mechanisms, not facts on the page, so they belong to the deterministic extractor that S17b already called for. The freshness lattice still needs "cached, but invalidated on event E".
7. **Label check: a partition key reads as per-key ordering.** On `relay_events`, `publish(..., key=row.aggregate_id)` reads to Clef as per-key-fifo (S060, S062). The template's fifo label is arguable. It was not changed after the fact, and the template should be revisited before any re-run.
8. **Anchor views collapse requests.** F07 and F08 send identical requests once scoped. A cache keyed on (anchor content hash, premise) would reuse Clef's answer across every change that leaves the anchor alone.
9. **Cost and latency are unchanged:**
   - 226 ms p50 per 3-question call, at about 1.05K input tokens;
   - no 429s at ≤ 3.4 rps across 727 calls;
   - every request far below the cap (max 2,062 tokens).

## Teardown

```
$ wrangler deployments list --name keel-spike-17c-clef      (before)
Created:     2026-10-10T21:19:37.994Z    Source: Upload         Version(s): (100%) effc56b4-…
Created:     2026-10-10T21:19:49.239Z    Source: Secret Change
$ wrangler delete --name keel-spike-17c-clef --force
Successfully deleted keel-spike-17c-clef
$ wrangler deployments list --name keel-spike-17c-clef      (after)
✘ [ERROR] A request to the Cloudflare API (/accounts/<id>/workers/scripts/keel-spike-17c-clef/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
$ curl -X POST https://<worker>.workers.dev/ (with token)
HTTP 404
```

Nothing else needs removing: the AI binding has no resources of its own. The bearer token and the Worker URL lived only in scratch files outside the repository, and both have been deleted.

## Reproduce

```
cd spikes/17c-clef-fixed
npm_config_userconfig=/dev/null pnpm install --ignore-workspace
node scripts/build-dataset.ts            # writes docs/spikes/s17c-dataset.json; every check above
pnpm exec tsc --noEmit && pnpm run lint && pnpm exec vitest run
node scripts/sample.ts 16 2026           # the anchor-view hand-check sample
source "$CF_ENV" && pnpm exec wrangler deploy && echo "$TOKEN" | pnpm exec wrangler secret put SPIKE_TOKEN
export S17C_URL=... S17C_TOKEN=...
node scripts/eval.ts main c1 c2          # S17b's main run is read from spikes/17b-clef-scale/results
node scripts/analyze.ts && node scripts/determinism.ts && node scripts/tables.ts
pnpm exec wrangler delete --name keel-spike-17c-clef --force
```
