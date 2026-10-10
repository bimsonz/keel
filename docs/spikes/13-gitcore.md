# Spike 13: GitCore feasibility

Status: **done**. Result: **GO** for GitCore as the Tier 0 composer, with two conditions (placement and the refusal path). Fallback not taken.

Code: [`spikes/13-gitcore/`](../../spikes/13-gitcore/). All edge numbers come from the deployed Worker `keel-spike-13-gitcore` on 2026-10-10. None come from local workerd. The Worker and every repo have since been deleted (see [Teardown](#teardown)).

## Question

Can a small clean-room TypeScript git engine ("GitCore"), running inside a Durable Object, do Tier 0 integration safely? Tier 0 means composing a merge candidate from several changes, writing the commit, and pushing it to an Artifacts repo. If it cannot, MergeBox (real git in a container) composes, and GitCore only diffs.

Pass criteria from the design:

| # | Criterion |
|---|---|
| 1 | 100% identical-or-refused in a differential test against real git |
| 2 | Binding reads p95 < 50 ms |
| 3 | A composed push is accepted |
| 4 | A stale-SHA push is refused, or caught by read-back |

Check 5 (pako pack replay on the edge) supports a later read path and has no pass bar of its own.

## Results at a glance

| Check | Result | Key number |
|---|---|---|
| 1 Differential vs `git merge-tree` | **PASS** | 10,000 distinct generated histories (two seeds), **0** wrong trees. Every one of git's conflicts was refused. Both seeded bugs were caught. |
| 2 Binding read latency | **PASS when the DO is co-located with the namespace backend; FAIL otherwise** | p95 25–45 ms from a co-located DO. p95 140 ms from a DO across the Atlantic. |
| 2b Rate-limit bucket | **No over-limit error could be produced** (shape **untested**) | Up to ~4,600 binding reads per 10 s and ~3,900 git requests per 10 s with zero errors. The cap is per-repo throughput. |
| 3 Compose and push 3 changes | **PASS** | compose 734 ms (43 binding reads, 22 ms CPU). receive-pack 130 ms. `fsck` clean. Tree equals `git merge-tree`. |
| 4 Stale-SHA push | **PASS** | `ng refs/heads/main stale ref` for all 3 stale kinds. Exactly one winner in 40 of 40 concurrent races. |
| 5 pako replay on the edge | **PASS** | 378 of 378 objects, 33 deltas, every id re-hashed and reference-checked. `DecompressionStream` throws on the same pack. |

## Setup

- **Tools.** Node 22.22.3, git 2.50.1, pnpm 11.18.0. Package versions are pinned by the lockfile: wrangler 4.149.0, vitest 5.0.3, fast-check 4.10.2, pako 3.0.2, typescript 7.0.2, oxlint 1.87.0.
- **Worker config.** Compatibility date 2026-10-01. One SQLite-backed Durable Object class (`SpikeDO`).
- **Bindings.** Three Artifacts bindings: `keel-spike-13`, `keel-spike-13-eu` and `keel-spike-13-w`. The last two were for the placement check.
- **Access.** Every route sits behind a bearer key held as a Worker secret. Routes are addressed as `https://<worker>/<route>?do=<object name>[&hint=<locationHint>]`.
- **Install and checks:**
  ```
  pnpm install --ignore-workspace
  pnpm typecheck    # wrangler types (generates the git-ignored worker-configuration.d.ts), then tsc --noEmit
  pnpm lint         # oxlint -c oxlint.config.json src test scripts
  pnpm test         # vitest; S13_RUNS / S13_SEED set the differential size and seed (default 3000 / 1310)
  ```
  - The lint run has been shown to fail. A seeded `x == NaN` in `src/` gave `error eslint(use-isnan)`. The file was then removed.
  - The repo root's `.oxlintrc.json` ignores `spikes/**`, so the spike has its own `oxlint.config.json`. It is not a nested `.oxlintrc.json`.
- **Seed repo.** 300 text files in 20 packages (41 trees at head), plus 3 small follow-up commits so that fetched packs contain deltas. It was pushed from a local git client with `http.extraHeader="Authorization: Bearer $T"`.
- **Placement.** The Worker was called from London. Every default-placement DO that was checked ran in **LHR**, as `cdn-cgi/trace` showed from inside the DO. That includes the `main` DO used for check 2a.

### GitCore-lite (`spikes/13-gitcore/src/gitcore/`)

The engine was written from git's own format and protocol documentation only: `gitformat-pack`, `gitprotocol-http`, `gitprotocol-pack`, `gitprotocol-common`, and the object format. About 1,000 lines. It is throwaway.

| File | What it does |
|---|---|
| `objects.ts` | Object framing and SHA-1 (`"<type> <len>\0"`). Tree encode and decode with canonical sorting (a tree entry sorts as `name/`). A commit writer with trailers and a fixed committer time. |
| `merge.ts` | Merge-base search (all best common ancestors). A file-level tree diff that skips unchanged subtrees by SHA. The path-level 3-way merge and its guards (below). `CachingReader`, and `OverlayReader` for intermediate trees that exist only in memory. |
| `pack-write.ts` | Pack v2 writer. Whole objects only, zlib via `CompressionStream('deflate')`. |
| `pack-read.ts` | Pack v2 reader using pako's streaming `Inflate`. The `ZStream` captured in `onStart` gives `next_in`, the number of input bytes each object consumed, which locates the next object. Handles OFS_DELTA and REF_DELTA. |
| `smart-http.ts` | pkt-line framing, ref advertisement, a receive-pack v1 push with `report-status` parsing (including `ERR` lines), and a v1 upload-pack fetch with side-band-64k. |

**Merge rules.**
- One side unchanged: take the other.
- Both sides have the same mode and id (or both deleted): take it.
- Every present entry is a tree: recurse.
- Anything else refuses:
  - `both-modified`;
  - `add-add`;
  - `modify-delete`;
  - `dir-file`.

**Guards checked before or after the merge.** Each one refuses the whole merge:
- `criss-cross`: more than one merge base. `no-merge-base`: none.
- `dir-file`: a file became a directory, or a directory became a file, on either side.
- `mode-change`: any mode change on a changed path.
- `symlink` and `gitlink`: any changed path that is a symlink or a submodule.
- `binary`: a NUL byte in the first 8,000 bytes of any changed blob.
- `rename-exact` and `rename-similar`: a path is deleted on one side, and a blob is added on either side that is identical or similar to it.
  - Similarity is the shared bytes of 64-byte or newline chunks, divided by the larger blob size.
  - The threshold is **0.3**, below git's 50% rename threshold, which makes the guard deliberately conservative.

## Check 1: differential test (Node + real git)

**Harness.** `test/differential.test.ts`, `test/gen.ts` and `test/git-harness.ts`.
- fast-check generates histories over a small path vocabulary (`x y z w` under `"" a a/c b`, plus clash paths `a`, `a/c`, `b`), so collisions are common.
- Edits:
  - add, modify;
  - small in-place edit, delete;
  - exact rename, near rename (one line changed);
  - chmod, symlink, binary, gitlink;
  - dir/file clashes from the clash paths.
- Every case also gets shared edits, applied to both sides, which produce same-SHA results.
- One case in ten is a criss-cross: `ours` and `theirs` are cross-merges of two branches off the base, so there are two merge bases.
- Three history flavours: collision-heavy text, sparse text, and everything.
- Each case is written to a real bare repo with `git fast-import`. The test then compares:
  - GitCore's `mergeCommits(ours, theirs)`, which reads objects through a pipelined `git cat-file --batch`;
  - `git merge-tree --write-tree ours theirs`.

**Pass rule.** Each case must end in one of two ways:
- the trees are identical;
- GitCore refused.

Two outcomes fail the case:
- a different tree;
- a tree from GitCore where git reported a conflict.

```
$ S13_RUNS=5000 S13_SEED=1310 pnpm vitest run test/differential.test.ts
DIFFERENTIAL {"seed":1310,"cases":5000,"identical":1134,"refused":3866,
  "byReason":{"modify-delete":681,"rename-similar":509,"criss-cross":524,"both-modified":383,
              "rename-exact":376,"dir-file":345,"gitlink":248,"symlink":231,"add-add":207,
              "mode-change":199,"binary":163},
  "gitConflicts":2346,"gitConflictsRefused":2346,"crissCross":524,"cleanButRefused":1520,
  "ms":284416,"failed":false,"catReads":63810}
SEEDED ours-wins: failed=true afterRuns=35 shrinks=27
SEEDED no-rename-guard: failed=true afterRuns=8 shrinks=20
 Tests  3 passed (3)
```

The first run used the code as it stood mid-spike. Later edits added `OverlayReader` and changed TypeScript narrowing only, so the run was repeated on the final code with the same seed and with a second seed. The generator is deterministic for a given seed, so the two seed-1310 runs cover the same histories. In all, **10,000 distinct histories** were tested.

```
$ S13_RUNS=5000 S13_SEED=1310 pnpm vitest run            # final code, all tests
DIFFERENTIAL {"seed":1310,"cases":5000,"identical":1134,"refused":3866,...,"gitConflicts":2346,"gitConflictsRefused":2346,"cleanButRefused":1520,"failed":false}
SEEDED ours-wins: failed=true afterRuns=35 shrinks=27
SEEDED no-rename-guard: failed=true afterRuns=8 shrinks=20
 Test Files  2 passed (2)
      Tests  6 passed (6)
$ S13_RUNS=5000 S13_SEED=20261010 pnpm vitest run test/differential.test.ts -t identical
DIFFERENTIAL {"seed":20261010,"cases":5000,"identical":1174,"refused":3826,
  "byReason":{"modify-delete":655,"rename-similar":524,"criss-cross":486,"rename-exact":370,"both-modified":368,
              "dir-file":329,"gitlink":254,"symlink":247,"add-add":233,"mode-change":210,"binary":150},
  "gitConflicts":2319,"gitConflictsRefused":2319,"cleanButRefused":1507,"failed":false}
```

| | seed 1310 | seed 1310 (final code) | seed 20261010 (final code) |
|---|---|---|---|
| cases | 5,000 | 5,000 | 5,000 |
| identical tree | 1,134 | 1,134 | 1,174 |
| refused | 3,866 | 3,866 | 3,826 |
| **different tree / tree where git conflicted** | **0** | **0** | **0** |
| git reported conflicts (all refused) | 2,346 | 2,346 | 2,319 |
| git merged cleanly but GitCore refused | 1,520 | 1,520 | 1,507 |

**Result: PASS.** No case produced a wrong tree.

Every conflict git reported was refused, but the guards cost coverage:
- Of the cases git merged cleanly, GitCore matched 43% and refused 57%.
- This mix is adversarial on purpose; the refusals are mostly collisions on the same path, or rename and mode suspicion.
- Refusals go to MergeBox.

**Shown to fail.** fast-check found a counterexample, and shrank it, for each seeded bug.

- `ours-wins` takes ours when both sides changed a blob. It failed after 35 runs:
  ```
  {"base":[{"path":"x","lines":[0,0,0,0]}],"ours":[{"k":"edit","pick":0,"at":0,"line":0}],
   "theirs":[{"k":"edit","pick":0,"at":0,"line":1}],"crissCross":null}
  -> git reported conflicts but GitCore produced 8252b53d...
  ```
- `no-rename-guard` switches the rename refusal off. It failed after 8 runs. Ours renames `y` to `x`, and theirs near-renames the same file to `a/c/y`:
  ```
  {"base":[{"path":"y",...},{"path":"x",...}],"ours":[{"k":"rename","pick":3,"to":"x"}],
   "theirs":[{"k":"nearRename","pick":3,"to":"a/c/y","at":0,"line":0}],"crissCross":null}
  -> git reported conflicts but GitCore produced 80d7af2c...
  ```

The unit tests (`test/objects.test.ts`) also pass:
- blob, tree and commit ids match `git hash-object`, `git mktree` and `git commit-tree`, including the canonical order of `a.b`, `a/` and `a0`;
- the pack writer's output passes `git index-pack --strict`;
- the reader re-hashes every object of a pack that `git pack-objects` built with deltas.

## Check 2: binding read rates

### 2a. 1,000 sequential reads from the DO

`GET /bench?repo=keel-spike-13-seed&n=1000`:
- The DO first walks the head tree: 41 trees, 300 blobs, 42 calls.
- It then alternates `readTree` and `readBlob`, consuming each blob with `arrayBuffer()`.
- Each call is timed with `performance.now()`, which advances across I/O.
- The DO ran in LHR. The namespace backend is near London (see [Placement](#placement)).

| run | p50 | p95 | p99 | max | errors |
|---|---|---|---|---|---|
| 1 (cold DO) | 20 ms | **45 ms** | 86 ms | 201 ms | 0 |
| 2 | 19 ms | **26 ms** | 34 ms | 80 ms | 0 |
| 3 | 18 ms | **25 ms** | 42 ms | 255 ms | 0 |

`readTree` and `readBlob` are indistinguishable: p50 18–20 ms for both.

Single-call latency at concurrency 1 (`/burst?...&n=100&conc=1`), p50 / p95:

| call | p50 | p95 |
|---|---|---|
| `get()` | 12 ms | 18 ms |
| `info()` | 10 ms | 27 ms |
| `readBlob` | 18 ms | 24 ms |
| `readTree` | 16 ms | 22 ms |

**Result: PASS (p95 25–45 ms < 50 ms) from a co-located DO.** The same harness from a DO in DEN reading the same London-backed repo gives p50 128 ms and p95 140 ms, which **fails**. See [Placement](#placement).

**Shown to fail.** `?delayMs=40` injects 40 ms after each read. The same 50 ms check then goes red:

```
{'injectedDelayMs': 40, 'all': {'n': 200, 'p50': 59, 'p95': 67, 'p99': 74}, 'criterion': {'p95BelowMs': 50, 'pass': False}}
```

### 2b. Bursts past 2,000 per 10 s, and which bucket the reads hit

- **Binding bursts:** `/burst` in the DO, `n` calls at concurrency `conc` against one or more repos.
- **Git bursts:** from the local machine, `scripts/git-burst.mjs`, which sends GET `info/refs?service=git-upload-pack`, the first request of every fetch. Full fetches were 40 real `git clone`s.

| # | experiment (10 s quiet gap before each) | calls | wall | per 10 s | errors |
|---|---|---|---|---|---|
| E1 | git info/refs only, seed2, conc 128 | 2,600 | 7.1 s | 3,650 | **0** (all 200) |
| E1b | git info/refs only, seed2, conc 256 | 5,000 | 12.7 s | 3,940 | **0** |
| E2 | binding `readBlob` only, seed2, conc 64 | 3,000 | 10.4 s | 2,870 | **0** (p50 200 ms, queueing) |
| E3 | binding `readBlob` 3,000 **plus** git info/refs 3,000, both on seed2 | 6,000 | 12.4 s (binding) / 15.8 s (git) | ~4,300 combined | **0 / 0** |
| E3b | binding `readBlob` 3,000 **plus** 40 full `git clone --bare`, seed2 | 3,040 | 16.3 s / 6 s | 1,850 + clones | **0**; 40 of 40 clones ok |
| E4 | binding `readBlob` split over **two** repos (seed, seed2) | 4,000 | 8.7 s | 4,620 | **0** |
| E5a | `ARTIFACTS.get()` only, conc 64 | 2,500 | 16.8 s | 1,480 | **0** (p50 399 ms) |
| E5b | `repo.info()` only, conc 64 | 2,500 | 6.5 s | 3,860 | **0** |
| E5c | `get()` over 2 repos, conc 256 | 4,000 | 23.5 s | 1,700 | **0** (p50 1.3 s) |

**What the numbers show:**
- **No over-limit error was ever returned.** Its shape is **untested**: it could not be triggered.
  - This held at 1.4–2.3× the documented 2,000 per 10 s per repo (git) and 2,000 per 10 s per namespace (control plane).
- **The real limit is per-repo throughput.** It shows up as queueing latency, not errors.
  - One repo saturates at roughly 190–400 operations per second, whether those are binding reads or git requests: binding reads went from p50 18 ms unloaded to 200–320 ms at concurrency 64.
  - Two repos gave about 1.6× the throughput (E4).
- **Binding reads and git HTTP share that per-repo capacity.** In E3, git throughput halved (365 to 190 per second) and the first git response took 5.7 s while the binding burst ran. Binding throughput fell from 287 to 242 per second.
  - So binding reads count against **the per-repo bucket**, as contention rather than as rejection.
  - Splitting load across repos raises the ceiling. That is the per-repo signature, not the per-namespace one.
- **`get()` is the expensive call.** It caps at about 150–170 per second (E5a, E5c), with latency growing at any concurrency.
  - Keep repo handles open; do not call `get()` per operation.
  - Its 2,000-per-10 s namespace limit was unreachable, because `get()` itself never went faster than about 1,700 per 10 s.
- **DO CPU from `wrangler tail`:** 205–725 ms of CPU per 3,000-read burst, about 0.1–0.25 ms per call.

**Shown to fail.** The burst harness does count errors. The first E2 attempt picked an empty blob id from a root tree that holds only directories. It recorded `{"ArtifactsError[INVALID_INPUT]: Invalid hash: hash required.": {"count": 3000}}`. The blob selection was then fixed.

## Check 3: compose and push a 3-change candidate from the DO

**Inputs.** Pushed from local git to `keel-spike-13-compose2`, as `main` (base) and three branches:

| change | content |
|---|---|
| `change-1` | edits `src/a.ts` |
| `change-2` | adds `docs/guide.md`; sets `shared/config.json` to `version: 2` |
| `change-3` | edits `lib/util/x.ts`; sets `shared/config.json` to **the same blob** (`77fb19b1...`), the same-SHA case |

**In the DO** (`/compose`):
1. Read head through `log({ref:'main', limit:1})`.
2. Merge each change onto the running tree against the base, with `mergeTrees` through `OverlayReader`.
3. Write a commit:
   - author and committer `Keel Composer`;
   - fixed time `1760000000 +0000`;
   - one `Change-Id: I<change sha>` trailer per change.
4. Pack only the new trees reachable from the result that `readTree` reports missing on the server, plus the commit.
5. Mint `createToken('write', 600)`.
6. Push with receive-pack v1, using the advertised head as the old value.

```
$ curl .../compose?repo=keel-spike-13-compose2&changes=5583cc0,417fcc2,a612110
"tree": "d04f5d99456ac78b53da64afb7d67781e8663703", "commit": "1e901e07c993c51642c6e671e2d5fc6797082874",
"reachableNewTrees": 1, "missingTrees": 1, "packedObjects": 2, "packBytes": 406,
"composeMs": 734, "readsDuringCompose": 43, "receivePackMs": 130, "tokenAdvertisePackPushMs": 392,
"push": {"status": 200, "unpack": "ok", "refs": {"refs/heads/main": {"ok": true}}, "raw": "unpack ok\nok refs/heads/main"},
"headAfter": "1e901e07c993c51642c6e671e2d5fc6797082874"
```

Local verification (`verify-compose.sh`):
- `git clone`, then `git fsck --full`;
- `git merge-tree --write-tree --merge-base base c1 c2`;
- `commit-tree`;
- `merge-tree` again with c3;
- compare the result with the pushed tree.

```
== git fsck --full
fsck exit=0
== pushed head:   1e901e07c993c51642c6e671e2d5fc6797082874
== pushed tree:   d04f5d99456ac78b53da64afb7d67781e8663703
== merge-tree:    d04f5d99456ac78b53da64afb7d67781e8663703
TREE MATCH
== trailers
Change-Id: I5583cc08ea583455d1bd2b06b2b642caaec483d6
Change-Id: I417fcc2702b22a22508e4aec3a40a6930ad07a5e
Change-Id: Ia6121100b3745174992e4cc608fb882413fdb642
```

**Latency and cost:**

| step | time |
|---|---|
| compose (43 sequential binding reads) | 734 ms |
| receive-pack round trip | 130 ms |
| token + `info` + advertise + pack + push | 392 ms |

- DO CPU from `wrangler tail`: **22 ms** for the whole compose-and-push request.
- DO memory is not observable from inside a Worker or through tail: **untested**.
- An earlier run of the same inputs on a separate repo produced the same commit id, `1e901e07`. Composition is deterministic across replays.

**Result: PASS.**

**Shown to fail.** Both demonstrations used fresh repos holding the same inputs:
- **Wrong composition.** `skip=2` drops change-3. The push is accepted, but local verification goes red: `pushed tree aac79346... / merge-tree d04f5d99... TREE MISMATCH`.
- **Incomplete pack.** `dropTree=1` leaves the root tree out of the pack. The server **refuses**:
  ```
  "push": {"status": 200, "unpack": "reachable object is missing",
           "refs": {"refs/heads/main": {"ok": false, "reason": "missing object"}}}, "headAfter": "7d504486..." (unchanged)
  ```
  Artifacts checks connectivity on receive, so a broken GitCore pack cannot corrupt a ref.
- **First bug found and fixed.** The first build packed an unreachable intermediate root tree from step 2, which was harmless but wasteful. It now packs only reachable new objects.

## Check 4: stale-SHA push and concurrent pushes

`/stale` builds a fast-forward commit on the **current** head each time. Only the claimed old-SHA varies, so any refusal is the compare-and-swap at work, not a fast-forward check.

| claimed old-SHA | reply | accepted | head moved | read-back agrees |
|---|---|---|---|---|
| an ancestor of head (`7d504486`, head is `5583cc08`) | `unpack ok` / `ng refs/heads/main stale ref` | no | no | yes |
| a never-existing id (`deadbeef…`) | `ng refs/heads/main stale ref` | no | no | yes |
| zero id (claiming a create) | `ng refs/heads/main stale ref` | no | no | yes |
| **control:** the correct head | `unpack ok` / `ok refs/heads/main` | **yes** | yes | yes |

`/race` reads head, builds `width` different commits on it, sends all the pushes at once with `Promise.all`, then reads head back through both `info/refs` and `log`:

| width | trials | exactly one winner | more than one ok | none ok | read-back mismatch | replies seen |
|---|---|---|---|---|---|---|
| 2 | 20 | **20** | 0 | 0 | 0 | `ok` ×20; `ng … stale ref` ×20 |
| 6 | 20 | **20** | 0 | 0 | 0 | `ok` ×20; `ng … stale ref` ×21; **`ERR artifacts_git_receive_pack_busy` ×79** |

(An earlier width-2 run of 20 trials on the first race code gave the same result: 20 of 20, with both A and B winning sometimes.)

**Result: PASS.**
- The server enforces the old-SHA compare-and-swap.
- A stale push was **never** accepted, so read-back never had to catch one.
- Every winner was confirmed by read-back through both `info/refs` and `log`.

**Shown to fail.** The control row: the same code path with a correct old-SHA is accepted and moves the head, so the "refused" assertion goes red for a non-stale push.

**Input to S1.**
- Artifacts receive-pack is a real per-ref CAS.
- Beyond about 2 concurrent pushers to one repo, extra pushers are rejected as a whole request: HTTP 200 with a single pkt-line, `ERR artifacts_git_receive_pack_busy`, and no `unpack` or ref status. They are not queued.
- A client must treat `ERR` as "not applied, retry" and must parse it. GitCore's first parser threw on it. Real git reports it as a remote error.

## Check 5: pako replay on the edge

`/pako?repo=keel-spike-13-seed`, in the deployed DO:
1. Upload-pack v1 (`want <head>`, `side-band-64k ofs-delta no-progress`, `done`).
2. Demultiplex band 1.
3. Parse with the pako reader.
4. Recompute every object's SHA-1.
5. Walk commit → tree → blob references from the head, and require each referenced id to be a parsed object of the right type.

```
"packBytes": 355727, "fetchMs": 198,
"pako": {"ok": true, "declaredCount": 378, "parsedObjects": 378, "distinctOids": 378, "deltas": 33,
         "trailerOk": true, "referencesChecked": 1368, "missingOrMismatched": [],
         "types": {"commit": 4, "tree": 59, "blob": 315}},
"decompressionStream": {"firstObjectInflatedSize": 206,
   "onRestOfPack": {"ok": false, "error": "TypeError: Trailing bytes after end of compressed data",
                    "outputBytesDeliveredBeforeError": 0},
   "onExactSlice": {"consumedBytes": 141, "ok": true, "outputBytes": 206}}
```

**Server capabilities advertised:** `agent=gitty/1.0 object-format=sha1 multi_ack multi_ack_detailed no-done side-band side-band-64k shallow deepen-since deepen-not deepen-relative allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress symref=HEAD:refs/heads/main`. There is no `filter`.

- The parse and verify ran inside a request that used **86 ms** of DO CPU in total, including the fetch and `DecompressionStream`.
- `performance.now()` does not advance during pure CPU work in Workers, so the in-code `parseMs` reads 0. Use the tail's `cpuTime`.

**Result: PASS.**

**Shown to fail.** Two demonstrations:
- **`DecompressionStream` on the same pack, on the edge.** Fed from the first object's data to the end of the pack, it throws `Trailing bytes after end of compressed data`. It delivers **0** of the 206 bytes it had already inflated. Fed exactly the 141 bytes that pako reported consuming, it succeeds. So the trailing bytes are the whole problem, and a reader needs a consumed-length signal that only pako gives.
- **A corrupt pack.** `corrupt=1` flips one byte in the last object, and the reader goes red: `"pako": {"ok": false, "error": "Error: inflate failed at 355692: incorrect data check"}`.

## Placement

The question was whether Artifacts sits near US West, as S12 measured from LHR (about 370 ms per smart-HTTP round trip, and 166 ms for `info()`).

Method:
- DOs were created with and without `locationHint`. Each one's colo was read from `https://www.cloudflare.com/cdn-cgi/trace` inside the DO. All requests entered at LHR.
- `/bench` makes 200 alternating `readTree`/`readBlob` calls.
- `/pushbench` makes 8 sequential fast-forward pushes, timing advertise and receive-pack separately.

| DO | hint | colo (trace) |
|---|---|---|
| pd1 / pd3 | none (default) | **LHR** |
| pe1 | `weur` | **LHR** |
| pw1 / pw3 | `wnam` | **DEN** |

### (a) Default placement vs `wnam`: reads p50 / p95 (ms)

| namespace (how its backend was placed) | repo | from LHR (default) | from LHR (`weur`) | from DEN (`wnam`) |
|---|---|---|---|---|
| `keel-spike-13`: unrestricted, first used from an LHR DO | seed (created from LHR) | **20 / 28** | 20 / 25 | 128 / 140 |
| same | den (created from the DEN DO) | **20 / 26** | 19 / 28 | 128 / 140 |
| `keel-spike-13-w`: unrestricted, first used from a DEN DO | w-seed (created from DEN) | 155 / 232 | – | **51 / 77** |
| `keel-spike-13-eu`: `jurisdiction: eu` (REST) | eu-seed (created from LHR) | **38 / 45** | 38 / 46 | 152 / 238 |
| same | eu-den (created from DEN) | **34 / 44** | 32 / 41 | 152 / 166 |
| same | eu-fork (`fork()` of eu-seed) | **37 / 46** | – | 150 / 189 |

Push, p50 / p95 (ms):

| namespace | DO colo | advertise | receive-pack |
|---|---|---|---|
| `keel-spike-13` | LHR | 68–90 / 104–351 | **112–142** / 164–378 |
| `keel-spike-13` | DEN | 270–283 / 297–537 | 423–435 / 463–474 |
| `keel-spike-13-w` | LHR | 351 / 456 | 617 / 768 |
| `keel-spike-13-w` | DEN | **135** / 218 | **285** / 690 |
| `keel-spike-13-eu` | LHR (default and `weur`) | 104–117 / 117–148 | **196–211** / 260–267 |
| `keel-spike-13-eu` | DEN | 321 / 350 | 536 / 594 |

**Findings:**
- **The backend location is per namespace, not per account and not per repo.** A repo created from DEN in a London-placed namespace is served from London (rows 1 and 2 are identical).
- **Two unrestricted namespaces in the same account sit on different continents.**
  - `keel-spike-13` was first touched by a binding call from an LHR DO, and is London-near: 20 ms reads from LHR.
  - `keel-spike-13-w` was first touched by a binding call from a DEN DO, and is US-placed: 51 ms from DEN, 155 ms from LHR.
  - This is consistent with the backend being placed where the namespace is first used, and with S12's US-West result for a namespace created from the US. Two namespaces is suggestive, not proof.
- **The binding read bar (p95 < 50 ms) holds only when the DO is co-located with the namespace.** Keel must pin each namespace and its DOs to the same region:
  - create the namespace from a DO with the intended `locationHint`;
  - or use a jurisdiction;
  - then hint the DOs to match.
- **`locationHint: "wnam"` was honoured (DEN). `weur` from London stayed in LHR.**

### (b) `jurisdiction: "eu"` namespace

- **Creation through REST with the wrangler OAuth token (`wrangler auth token`) works:**
  ```
  POST /accounts/<account>/artifacts/namespaces {"namespace":"keel-spike-13-eu","jurisdiction":"eu"}
  -> {"result":{"namespace":"keel-spike-13-eu","jurisdiction":"eu","repo_count":0,...},"success":true}
  ```
  The default namespace reports `"jurisdiction": "unrestricted"` on the same endpoint.
- **The EU backend is in the EU but not in London:** reads 34–38 ms p50 and 41–46 ms p95 from LHR; receive-pack about 200 ms. That clears the 50 ms read bar from LHR, narrowly.
- **`fork()` keeps the jurisdiction.**
  - `fork()` can only target the same namespace.
  - The binding's `list()` reports the fork as `jurisdiction: "eu"`, `source: "artifacts:keel-spike-13-eu/keel-spike-13-eu-seed"`.
  - The fork reads like its parent: 37 / 46 ms from LHR, 150 / 189 ms from DEN.
  - **Fork latency** was 4,074 ms for the `fork()` call. The fork was readable 4,277 ms after the call started.
- Repos created from the DEN DO in the EU namespace are served from the EU like the rest: 34 / 44 ms from LHR.

## Go / no-go

**GO: GitCore composes Tier 0 candidates. Fallback not taken.**

- Path-level composition was never wrong in 10,000 distinct adversarial histories. It refuses everything git conflicts on, and everything where git's rename, mode or recursive-base logic could disagree.
- The composed push lands, `fsck`s clean, matches `git merge-tree`, and is deterministic across replays.
- The server's CAS and connectivity checks make a bad GitCore push fail closed.

**Conditions on the GO:**
1. **Placement is part of the design.**
   - Binding reads meet p95 < 50 ms only from a DO in the same region as the namespace backend.
   - Across the Atlantic, compose would be about 6× slower: 128 ms per read × 43 reads ≈ 5.5 s, against 0.7 s.
2. **The refusal path is real traffic.**
   - In the adversarial mix, 57% of the merges git completes cleanly are refused. Each refusal must route to MergeBox, or the change is serialised.
   - The share for real Keel traffic, which is mostly path-disjoint, needs measuring on S1 workloads.
3. **Push contention.**
   - Push clients must parse `ERR artifacts_git_receive_pack_busy` and retry with backoff.
   - Compose throughput per repo is bounded by the receive-pack lock and by the shared per-repo capacity of about 190–400 operations per second.

## Design-relevant findings

- **CAS behaviour (for S1).**
  - receive-pack enforces old-SHA compare-and-swap: `ng <ref> stale ref` for an ancestor, an unknown id or the zero id.
  - Concurrent pushes from one base give exactly one winner: 40 of 40 trials.
  - At width 6, the losers get either `ng stale ref` or a request-level `ERR artifacts_git_receive_pack_busy`.
  - No acknowledged push ever disagreed with read-back.
- **Connectivity check on push.** A pack missing a reachable object is rejected (`unpack reachable object is missing`, `ng … missing object`) and the ref does not move.
- **Rate-limit bucket.** Binding reads draw on the **same per-repo capacity** as git HTTP; it shows as queueing, not errors.
  - No over-limit error was produced at up to 2.3× the documented limits, so its shape is untested.
  - `get()` is slow under load (about 150 per second), so cache repo handles.
- **Placement.** The backend is per namespace, and is plausibly placed by first use. Co-locate DOs with their namespace; `jurisdiction: "eu"` pins it to the EU (about 35 ms from LHR).
- **Durable Object version skew after deploy.** DO instances that kept receiving requests went on running an old Worker version for several minutes after newer deploys, while the stateless entry already ran the new one.
  - Tail evidence: `stateless c109baa3 … /token?…&do=pw1` was followed by `durableObject d8b54eee … /token?…&do=pw1`, which returned `no route`. Version d8b54eee had been superseded by two deploys.
  - A fresh object name ran the new code.
  - The skew sent one experiment to the wrong namespace: `ns=w` was not understood by the old code. That experiment was redone on fresh objects.
  - The Worker-to-DO interface must tolerate mixed versions.
- **Fixed committer time plus trailers makes candidates reproducible.** The same inputs gave the same commit id on two repos.
- **Small API notes:**
  - `info().lastPushAt` stayed `null` after git pushes.
  - Binding `list()` returns `status` and `jurisdiction` fields that are not in the generated types.
  - Repos and namespaces are created implicitly by the first binding call.

## Untested

- The shape of an over-limit (429 or `ArtifactsError`) response: it could not be triggered at up to 2.3× the documented limits.
- DO memory use during compose: not observable from inside the Worker or through tail.
- Whether namespace placement follows first use, with a sample larger than two unrestricted namespaces.
- A full burst of upload-pack fetches past 2,000 per 10 s. Bursts used ref advertisements, plus 40 full clones.

## Teardown

Everything named `keel-spike-13*` was deleted on 2026-10-10:
- **16 repos**, deleted with `wrangler artifacts repos delete <repo> --namespace <ns> --force`. Each returned `Deleted Artifacts repo "<repo>" from namespace "<ns>".`
  - 11 in `keel-spike-13`, including `keel-spike-13-w-seed`, created there by the old-version DO;
  - 4 in `keel-spike-13-eu`;
  - 1 in `keel-spike-13-w`.
- **The Worker** `keel-spike-13-gitcore`, with its Durable Object class, deleted with `wrangler delete --name keel-spike-13-gitcore --force`, which reported `Successfully deleted keel-spike-13-gitcore`.
- **The three namespaces**, deleted with `DELETE /accounts/<account>/artifacts/namespaces/<ns>`.
  - This route is not in the REST docs.
  - The first call returned an empty body; its status code was not captured.
  - A repeat DELETE returns HTTP 404, and GET returns `10200 Namespace not found`.

Listing after teardown:

```
$ wrangler artifacts namespaces list --json | filter keel-spike-13
total namespaces: 13 | matching keel-spike-13: []
$ wrangler artifacts repos list --namespace keel-spike-13
No Artifacts repos found in namespace "keel-spike-13".
$ wrangler artifacts repos list --namespace keel-spike-13-eu
No Artifacts repos found in namespace "keel-spike-13-eu".
$ wrangler artifacts repos list --namespace keel-spike-13-w
No Artifacts repos found in namespace "keel-spike-13-w".
$ wrangler deployments list --name keel-spike-13-gitcore
✘ [ERROR] A request to the Cloudflare API (/accounts/<account>/workers/scripts/keel-spike-13-gitcore/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
$ GET /accounts/<account>/workers/scripts | filter keel-spike-13
scripts: 251 | matching keel-spike-13: []
$ GET /accounts/<account>/artifacts/namespaces/keel-spike-13      (same for -eu, -w)
{"result":null,"success":false,"errors":[{"code":10200,"message":"Namespace not found",...}]}
```

No `keel-spike-13` resources remain.
