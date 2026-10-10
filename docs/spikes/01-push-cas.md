# S1: Compare-and-swap on concurrent pushes to Artifacts

**Date:** 2026-10-10, run against the live Artifacts service from London (`cf-ray …-LHR`). **Code:** [`spikes/01-push-cas/`](../../spikes/01-push-cas/). **Raw results:** [`spikes/01-push-cas/results/`](../../spikes/01-push-cas/results/).

## Answer

- **Artifacts' receive-pack enforces a real per-ref compare-and-swap on the old-oid.**
  - Two concurrent pushes from the same base were run 180 times across five variants. 166 of those races reached the server with identical old-oids.
  - **Server-side CAS violations: 0.** In every race exactly one update landed, and the read-back head was the winner's commit.
  - The loser gets `! [remote rejected] HEAD -> main (stale ref)`.
- **The check is on the old-oid, not merely on fast-forward.**
  - In 11 trials, an update that *was* a fast-forward of the new head was still refused because its old-oid was stale.
  - Hand-built commands with a wrong, zero or stale old-oid were refused, every time and on every ref namespace tried.
- **A stale lease is refused.** `--force-with-lease=main:<wrong>` is refused by git before anything is sent. The equivalent update sent to the server anyway is refused there too.
- **`atomic` is advertised and works.** Without `atomic` the server *still* applies a multi-ref push all-or-nothing.
- **Custom refs round-trip:** `refs/keel/*`, `refs/notes/*` and `refs/heads/cand/*`.
- **One sharp edge: `--force` loses updates.**
  - In the `--force` variant, 3 of 30 trials had *both* pushes succeed. In each one, the second pusher had already read the first's commit in its ref advertisement, sent that commit as its old-oid, and overwrote it.
  - The server's check was honoured: those are client read-then-overwrite losses, not CAS failures.
  - The server also has no non-fast-forward denial. Any write-token holder can rewrite history.
- **Go/no-go: GO.** The server CAS is fit to be the second fence behind ADR 0003's single writer + WAL + read-back.
  - The trunk writer must push with an explicit expected old value (`--force-with-lease=refs/heads/main:<wal.old>` or a raw command carrying `wal.old`), never bare `--force`.
- **Fallback taken: none beyond the primary design**, which is unchanged. Custom refs work, so the `cand/*` fallback isn't needed.

## Question

Does Artifacts' receive-pack provide compare-and-swap semantics on ref updates? Specifically:

- When two clients push to `main` from the same base at the same moment, does exactly one win?
- Is a stale `--force-with-lease` refused?
- Is `--atomic` advertised and honoured?
- Do the custom refs Keel wants (`refs/keel/*`, `refs/notes/*`, `refs/heads/cand/*`) round-trip?

**Pass:** exactly one push wins each trial, and a stale lease is refused.

## Setup

| Item | Value |
|---|---|
| Repo | `keel-spike-01/cas`, created with `wrangler artifacts repos create` (wrangler 4.149.0), seeded with one commit |
| Client | Apple git 2.50.1, run hermetically (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`); node 22.22 for the raw client |
| Auth | Repo write token from `wrangler artifacts repos issue-token --scope write`. It is passed as `Authorization: Bearer` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0=http.extraHeader` env vars, so it never appears in argv, a URL or `.git/config` (`scripts/lib.sh`). |
| `scripts/race.sh` | One trial: clone A fetches `main`, clone B takes the same base from A, and each makes a different commit. Both pushes then spin on a barrier file and start together; measured start skew is ≤ 4 ms. Each push records the update command it actually sent (`GIT_TRACE_PACKET`), so a trial is tagged **server** (both commands reached the server with the same old-oid) or **client** (one push saw the other's result in its ref advertisement, and git refused it locally). The head is read back with `git ls-remote` after every trial. |
| `scripts/rawpush.ts` | A ~200-line smart-HTTP receive-pack client. It sends hand-built `<old> <new> <ref>` commands plus a pack from `git pack-objects`, so the server's check can be tested with old-oids git would never send. `race` mode POSTs two updates with the same old-oid via `Promise.all`. |
| Classifier | A trial where both report success, or where the head is neither commit, is counted as `VIOLATION_*`. A winner whose commit is not the read-back head is also counted. |

Server capabilities, captured with `curl -H @hdr "$REMOTE/info/refs?service=…"`:

```text
git-receive-pack (v0/v1):
agent=gitty/1.0 object-format=sha1 report-status report-status-v2 delete-refs atomic ofs-delta side-band side-band-64k symref=HEAD:refs/heads/main
git-upload-pack (v0/v1):
agent=gitty/1.0 object-format=sha1 multi_ack multi_ack_detailed no-done side-band side-band-64k shallow deepen-since deepen-not deepen-relative allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress symref=HEAD:refs/heads/main
git-upload-pack (Git-Protocol: version=2):
version 2 | agent=gitty/1.0 | ls-refs=unborn | fetch=shallow filter sideband-all | object-format=sha1
unauthenticated GET: 401
```

`atomic` is advertised. `push-options` and `quiet` are not. Protocol v2 upload-pack advertises `filter`, which was not exercised here (see [Untested](#untested)).

## Numbers

### Concurrent pushes from the same base

Commands: `scripts/race.sh <mode> <n> <workdir> > results/<mode>.tsv`, `node scripts/rawpush.ts race <gitdir> 50 results/raw-race.tsv`, and `node scripts/summarise.ts results/*.tsv` (→ `results/summary.txt`).

| Variant | Trials | A won | B won | Both OK | Decided at server | Decided at client | **Server CAS violations** | Classifier flags | Push ms p50 / p95 / max |
|---|---|---|---|---|---|---|---|---|---|
| `race`: plain `git push`, both commits on the same parent | 50 | 22 | 28 | 0 | 44 | 6 | **0** | 0 | 281 / 476 / 793 |
| `raw-race`: two receive-pack POSTs, identical old-oid | 50 | 29 | 21 | 0 | 50 | 0 | **0** | 0 | 109 / 267 / 510 |
| `force`: both `git push --force` | 30 | 15 | 12 | 3 | 27 | 3 | **0** | 3 (lost updates, below) | 285 / 541 / 860 |
| `ffchain`: B's commit sits on top of A's | 30 | 11 | 18 | 1 (`BOTH_OK_FF`, no loss) | 26 | 4 | **0** | 0 | 276 / 489 / 1027 |
| `lease`: both `--force-with-lease=main:<base>` | 20 | 15 | 5 | 0 | 19 | 1 | **0** | 0 | 289 / 377 / 403 |
| **Total** | **180** | | | | **166** | 14 | **0** | | |

The loser's error text, by variant:

```text
race     : "! [remote rejected] HEAD -> main (stale ref)": 44, "! [rejected] HEAD -> main (fetch first)": 6
raw-race : "ng refs/heads/main stale ref": 50
force    : "! [remote rejected] HEAD -> main (stale ref)": 27, both succeeded: 3
ffchain  : "! [remote rejected] HEAD -> main (stale ref)": 26, "! [rejected] HEAD -> main (fetch first)": 3, both succeeded (fast-forward): 1
lease    : "! [remote rejected] HEAD -> main (stale ref)": 19, "! [rejected] HEAD -> main (stale info)": 1
```

Sample rows from `results/race.tsv` and `results/raw-race.tsv`:

```text
trial mode base         cA           cB           rcA rcB sentA                      sentB                      decided head         skew_ms msA msB outcome
1     race 826f385738dc d6a1abfc7deb e63e4e6eb534 0 1  826f385738dc->d6a1abfc7deb 826f385738dc->e63e4e6eb534 server  d6a1abfc7deb 0       445 476 A_WON
3     race ca612dc42f97 aa1d355824ac 2dbd89826dd2 1   0   ca612dc42f97->aa1d355824ac ca612dc42f97->2dbd89826dd2 server  2dbd89826dd2 0       395 244 B_WON
8     race f10cefc410e6 …            …            1   0   f10cefc410e6->56faeaa78100 (none sent)                client  56faeaa78100 1       378 248 B_WON
trial mode     base         cA           cB           resA                         resB                         head         outcome
1     raw-race c2d3181fde83 8824d5e85d03 dc9a83befa40 ng refs/heads/main stale ref ok refs/heads/main           dc9a83befa40 B_WON
2     raw-race dc9a83befa40 b8c2a6780914 8d9bb446f48a ok refs/heads/main           ng refs/heads/main stale ref b8c2a6780914 A_WON
```

**Head equals the winner's commit in every trial.** The read-back `ls-remote` head matched the single successful push in all 176 single-winner trials. Across all 180 trials it was never a third commit.

**What `ffchain` proves.** In 11 trials A landed first, and B's update was a fast-forward of A's commit, yet it was still refused with `stale ref` because its old-oid was the base. A server that only checked fast-forward would have accepted all 11. The check is a true compare-and-swap.

#### The three `--force` trials where both pushes succeeded (`results/force.tsv`)

```text
trial base         cA           cB           rcA rcB sentA                      sentB                      decided head         outcome
7     9f0996b55f8a 8388ee0cb133 576fcda682f9 0   0   9f0996b55f8a->8388ee0cb133 8388ee0cb133->576fcda682f9 client  576fcda682f9 VIOLATION_BOTH_OK
16    d7af769edc7a ec3a3880f987 3e051cd9605e 0   0   3e051cd9605e->ec3a3880f987 d7af769edc7a->3e051cd9605e client  ec3a3880f987 VIOLATION_BOTH_OK
30    5ffb7297a737 846c6a3678d5 2832d6ee796b 0   0   2832d6ee796b->846c6a3678d5 5ffb7297a737->2832d6ee796b client  846c6a3678d5 VIOLATION_BOTH_OK
```

In each trial the second update's old-oid is the *first push's commit* (in trial 7, B sent `8388ee0cb133->…`). The second pusher's ref advertisement arrived after the first update had landed, and `--force` then discarded the first commit.

- Each accepted command's old-oid equalled the ref's value at that moment, so the server CAS held.
- The update was still lost. That is what `--force` means, and why the trunk writer must carry its own expected value.

### Deterministic server-side checks (`scripts/cas-single.sh` → `results/cas-single.txt`)

These are hand-built receive-pack commands, one request each. Every request returned HTTP 200 with `unpack ok`.

| # | Command sent | Result | `main` / ref after |
|---|---|---|---|
| R1 | wrong old-oid (never existed) → fast-forward of head | `ng refs/heads/main stale ref` | unchanged |
| R2 | old-oid zero (create) on existing `main` | `ng … stale ref` | unchanged |
| R3 | stale real old-oid (`head~1`) → fast-forward of head | `ng … stale ref` | unchanged |
| R4 | wrong old-oid → non-fast-forward | `ng … stale ref` | unchanged |
| R5 | **control:** correct old-oid → fast-forward | `ok refs/heads/main` | moved |
| R6 | correct old-oid → **non-fast-forward** | `ok refs/heads/main` | moved: no server-side non-fast-forward denial |
| R7 | **control:** create `refs/heads/side` with old-oid zero | `ok` | created |
| R8 | two commands, no `atomic`: valid fast-forward of `side` + stale `main` | `ng side stale ref`, `ng main stale ref` | both unchanged |
| R9 | the same, stale command first | both `ng … stale ref` | both unchanged |
| R10 | the same with `atomic` | both `ng … stale ref` | both unchanged |
| R11 | **control:** two valid commands, no `atomic` | both `ok` | both moved |
| R12 | delete `side` with wrong old-oid | `ng … stale ref` | unchanged |
| R13 | **control:** delete `side` with correct old-oid | `ok` | deleted |

```text
## R1 wrong old-oid (never existed), new is a fast-forward of head
{"sent":["72813a9956cf->4e2f10c3dd39 refs/heads/main"],"http":200,"ms":146,"unpack":"unpack ok","result":["ng refs/heads/main stale ref"],"after":{"refs/heads/main":"7c18ddec9977"}}
## R8 two commands WITHOUT atomic: valid fast-forward of side + stale main
{"sent":["3d20d366f8fa->fd06c1300979 refs/heads/side","72813a9956cf->1c9d10efaabc refs/heads/main"],"atomic":false,"http":200,"ms":105,"unpack":"unpack ok","result":["ng refs/heads/side stale ref","ng refs/heads/main stale ref"],"after":{"refs/heads/side":"3d20d366f8fa","refs/heads/main":"bd162e70a617"}}
## R11 two valid commands WITHOUT atomic (control: both must be ok)
{"sent":["3d20d366f8fa->fd06c1300979 refs/heads/side","bd162e70a617->ca68c5a26139 refs/heads/main"],"atomic":false,"http":200,"ms":113,"unpack":"unpack ok","result":["ok refs/heads/side","ok refs/heads/main"],"after":{"refs/heads/side":"fd06c1300979","refs/heads/main":"ca68c5a26139"}}
```

### Lease (`results/cas-single.txt`, L1–L3; `results/lease.tsv`)

```text
## L1 --force-with-lease=main:<wrong sha> (non-fast-forward rewrite)
 ! [rejected]        45b8f4193cba7963f11e735b3a7671a940c68d55 -> main (stale info)
exit=1 head=ca68c5a26139 commandSent=0
## L2 --force-with-lease=main:<stale real sha head~1>
 ! [rejected]        45b8f4193cba7963f11e735b3a7671a940c68d55 -> main (stale info)
exit=1 head=ca68c5a26139 commandSent=0
## L3 --force-with-lease=main:<correct sha> with a non-fast-forward rewrite
 + ca68c5a...5cc87bd 5cc87bda5474fe3201410c43a22811054e3780ac -> main (forced update)
exit=0 head=5cc87bda5474 expected=5cc87bda5474
```

- **Client side:** git refuses a stale lease before sending (`commandSent=0`).
- **Server side:** the server refuses the same update when it is sent anyway (R1, R3 and R4 above).
- **Under concurrency:** two simultaneous leases on the same base, in the `lease` variant, gave exactly one winner 20/20 times. 19 of those were decided at the server (`stale ref`). Git sends the lease value as the command's old-oid, so the lease is enforced end to end, from the client's check through the server's compare-and-swap.

### `--atomic` with git (`results/cas-single.txt`, A1–A2)

```text
## A1 git push --atomic: main stale (non-ff, no force) + new branch atomic-x
 ! [rejected]        68720a52c0bb… -> main (non-fast-forward)
 ! [rejected]        5cc87bda5474… -> atomic-x (atomic push failed)
exit=1
## A2 same without --atomic
   7c18dde..5cc87bd  5cc87bda5474… -> nonatomic-x
 ! [rejected]        68720a52c0bb… -> main (non-fast-forward)
exit=1
```

In A1 and A2 git spotted the stale ref itself and sent only the valid command, or nothing under `--atomic`. R8–R10 cover the case where the server makes the decision.

### Custom refs (`scripts/custom-refs.sh` → `results/custom-refs.txt`)

```text
## push the three refs
 * [new reference]   refs/keel/test -> refs/keel/test
 * [new reference]   refs/notes/mfp -> refs/notes/mfp
 * [new branch]      cand/x -> cand/x
## ls-remote (protocol v2, git's default)            (v0 and the receive-pack advertisement list the same refs)
a0d6c2363732	refs/heads/cand/x
5cc87bda5474	refs/heads/main
a0d6c2363732	refs/keel/test
c0e275e79c99	refs/notes/mfp
## fetch back into a fresh repo
PASS refs/keel/test round-trips
PASS refs/notes/mfp round-trips
PASS refs/heads/cand/x round-trips
PASS note body readable after fetch
## a plain clone: which refs come along by default
  refs/heads/main  refs/remotes/origin/{HEAD,cand/x,main,nonatomic-x}
## stale update to refs/keel/test is refused by the server
{"sent":["72813a9956cf->4812e52d862f refs/keel/test"],…,"result":["ng refs/keel/test stale ref"],"after":{"refs/keel/test":"a0d6c2363732"}}
## and a correct update to refs/keel/test is applied (control)
{"sent":["a0d6c2363732->4812e52d862f refs/keel/test"],…,"result":["ok refs/keel/test"],"after":{"refs/keel/test":"4812e52d862f"}}
## append a second note and push (notes ref is a fast-forward)
   c0e275e..928d9fa  refs/notes/mfp -> refs/notes/mfp
PASS notes ref advanced on the server
ALL CHECKS PASS
```

A plain `git clone` brings only `refs/heads/*`. `refs/keel/*` and `refs/notes/*` need an explicit refspec.

### Latency (London)

| Operation | p50 / p95 / max |
|---|---|
| One receive-pack POST (raw client, tiny pack) | 109 / 267 / 510 ms |
| `git push` (advertisement GET + POST) | 281 / 476 / 793 ms |
| Seed push of 1 commit to an empty repo | 335 ms (single sample) |

These are faster than the "few hundred ms per round trip" expected. The backend location was not determined.

## Pass/fail

| Criterion | Result | Evidence |
|---|---|---|
| Exactly one push wins each trial (50 concurrent trials, same base, plain push) | **PASS** | 50/50 single winner; 44 decided by the server's `stale ref`; head = winner every time |
| No server-side CAS violation under any variant | **PASS** | 0 across 180 trials. The 3 `--force` double-successes each carried the up-to-date old-oid; the losses are client-side `--force` semantics |
| Stale lease refused | **PASS** | L1/L2 refused by git (`stale info`); the same update sent raw refused by the server (R1, R3, R4); 20/20 concurrent leases had one winner |
| Correct lease succeeds | **PASS** | L3 forced update applied, head = expected |
| `--atomic` advertised | **PASS** | `atomic` in the receive-pack capabilities |
| `--atomic` with one stale update rejects both | **PASS** | A1 (git: `atomic push failed`), R10 (server: both `ng`) |
| Custom refs round-trip and are listed | **PASS** | `refs/keel/test`, `refs/notes/mfp` (note body intact), `refs/heads/cand/x`; listed by `ls-remote` under v0 and v2 |
| Can-fail: sequential stale push rejected, and the assertion goes red when the second wins | **PASS** | [below](#can-fail-demonstrations) |

## Go / no-go

**GO.** Artifacts' compare-and-swap is real and per ref. It can serve as the second fence behind ADR 0003's single writer, WAL and read-back, with these conditions for the trunk writer:

1. **Always carry the WAL's `old` as the expected value.** Use `git push --force-with-lease=refs/heads/main:<old> <remote> <new>:refs/heads/main`, or the raw receive-pack command `<old> <new> refs/heads/main`. A plain `git push` takes its old-oid from whatever the advertisement says at that instant, not from the WAL. Bare `--force` loses updates (3/30 here).
2. **Don't rely on the server to refuse a rewrite.** It accepts non-fast-forward updates whenever the old-oid matches (R6), so trunk history is protected only by keeping trunk's write token with the composer (ADR 0002).
3. **Treat `ng … stale ref` (exit 1, HTTP 200) as "someone else moved the ref".** Then run the WAL's read-back path; don't retry blindly.

## Fallback taken

**None beyond the primary design.** The single writer + WAL + read-back (ADR 0003) stays primary, and server CAS is the second fence as planned. Custom refs work natively, so the `cand/*` fallback isn't needed. `refs/heads/cand/*` also works, should branches be preferred.

## Can-fail demonstrations

**1. Sequential stale push** (`scripts/stale.sh` → `results/stale.txt`). Two clones at the same base; A pushes, then B (stale) pushes. The assertion is "B was rejected and the head is A's commit". Two controls let B legitimately win, and the assertion goes red on both:

```text
## 1. git push, second push stale (expected: rejected)
 ! [rejected]        HEAD -> main (fetch first)
ASSERT OK   [git push] stale second push rejected; head=91a552063e0b is the first push
## 2. raw receive-pack, second update carries the stale old-oid (expected: rejected by the server)
{"sent":["91a552063e0b->eb1fdb5772a1 refs/heads/main"],…,"result":["ng refs/heads/main stale ref"],"after":{"refs/heads/main":"3361bc326437"}}
ASSERT OK   [raw stale old-oid] stale second push rejected; head=3361bc326437 is the first push
## 3. CONTROL: second push uses --force (it re-reads the head and overwrites)
 + 4878374...69d802f HEAD -> main (forced update)
ASSERT FAIL [git push --force] second push WON (exit=0); head=69d802f6b096, first=4878374646f0 lost, second=69d802f6b096
## 4. CONTROL: raw update whose old-oid is the new head (a re-read), non-fast-forward
{"sent":["72f815b0b90b->ccce549588eb refs/heads/main"],…,"result":["ok refs/heads/main"],"after":{"refs/heads/main":"ccce549588eb"}}
ASSERT FAIL [raw re-read old-oid] second push WON (exit=0); head=ccce549588eb, first=72f815b0b90b lost, second=ccce549588eb
```

**2. The race classifier flags a double success.**

- `scripts/race.sh seqforce 3`: A pushes, then B pushes `--force` after A finishes.
- `node scripts/rawpush.ts control-race <gitdir> 3`: B's old-oid is A's commit.

Both produce double successes, and the classifier counts every one:

```text
## control-seqforce.tsv  (3 trials)   outcomes: {"VIOLATION_BOTH_OK":3}  CAS violations: 3
## control-raw.tsv  (3 trials)        outcomes: {"VIOLATION_BOTH_OK":3}  CAS violations: 3
```

**3. Each deterministic check has a control.**

- R5, R7, R11 and R13 (correct old-oid) returned `ok` and moved the ref, so the `ng` results in R1–R4, R8–R10 and R12 come from the old-oid alone.
- In the custom-ref test, the correct update to `refs/keel/test` was applied after the stale one was refused.

## Design-relevant findings

1. **The server compare-and-swaps the old-oid of every command** (`stale ref`): plain, forced, fast-forward, create (old-oid zero on an existing ref), delete, and custom namespaces.
2. **No server-side non-fast-forward denial.** Any write-token holder can rewrite any ref with a matching old-oid. Token scoping (ADR 0002) is the only guard on trunk history.
3. **Multi-ref pushes are all-or-nothing even without `atomic`** (R8, R9). The innocent command is also reported as `stale ref`, so the reason text can't be used to pick out the culprit.
   - Useful: trunk's `main` and a bookkeeping ref (say `refs/keel/wal`) can be advanced in one atomic push.
   - Hazard: unrelated ref updates bundled into one push fail together.
4. **Plain clones skip `refs/keel/*` and `refs/notes/*`.** Platform refs stay out of agents' default view but can be fetched with an explicit refspec. Notes round-trip and append as fast-forwards.
5. **Rejections are HTTP 200** with `ng <ref> stale ref` in report-status, so a client must parse report-status. Git maps this to exit 1.
6. **A ref advertisement can already be stale.** Of the 180 races, 14 were decided by git itself because the second push's advertisement already showed the first's update (`fetch first` / `stale info`). Either way the outcome was a single winner.

## Untested

- More than two concurrent writers per trial.
- Concurrent races on custom refs and `atomic` multi-ref races. Only deterministic stale checks were run on those.
- The 2,000 git requests per 10 s per repo limit, and how the server behaves near it.
- Isomorphic-git or another Worker-side client as the pusher; S12 covers that path.
- `report-status-v2` output and `side-band` report parsing in the raw client (it requests plain `report-status`).
- Token expiry mid-push, and `art_v1_` tokens.
- Protocol v2 `filter` (advertised, not exercised).
- Whether the CAS holds across a fork and its source; they are separate repos, so it was not expected to.

## Teardown

```console
$ wrangler artifacts repos list --namespace keel-spike-01   # before
│ cas  │ main           │ false     │ ready  │ 2026-10-10T18:46:47.317Z │
$ wrangler artifacts repos delete cas --namespace keel-spike-01 --force
Deleted Artifacts repo "cas" from namespace "keel-spike-01".
$ wrangler artifacts repos list --namespace keel-spike-01   # after
No Artifacts repos found in namespace "keel-spike-01".
$ wrangler artifacts namespaces get keel-spike-01
namespace:   keel-spike-01
repo_count:  0
created_at:  2026-10-10T18:46:46.546Z
updated_at:  2026-10-10T19:13:25.809Z
```

S1 deployed no Worker. wrangler 4.149.0 can't delete namespaces, so `keel-spike-01` remains with `repo_count: 0`. Full log: `results/teardown.txt`, shared with S3.

## Reproduce

```sh
cd spikes/01-push-cas
wrangler artifacts repos create cas --namespace keel-spike-01 --json        # keep the output out of the repo
wrangler artifacts repos issue-token cas --namespace keel-spike-01 --scope write --ttl 14400 --json
export REMOTE=<remote from `wrangler artifacts repos get`> TOKEN=<plaintext>
# seed one commit on main, then:
scripts/race.sh race 50 <scratch>/work-race      > results/race.tsv
scripts/race.sh force 30 <scratch>/work-force    > results/force.tsv
scripts/race.sh ffchain 30 <scratch>/work-ff     > results/ffchain.tsv
scripts/race.sh lease 20 <scratch>/work-lease    > results/lease.tsv
scripts/race.sh seqforce 3 <scratch>/work-seq    > results/control-seqforce.tsv
git init <scratch>/raw && (cd <scratch>/raw && git fetch "$REMOTE" main)   # with the bearer header, see scripts/lib.sh
node scripts/rawpush.ts race <scratch>/raw 50 results/raw-race.tsv
node scripts/rawpush.ts control-race <scratch>/raw 3 results/control-raw.tsv
scripts/cas-single.sh <scratch>/single  > results/cas-single.txt
scripts/custom-refs.sh <scratch>/custom > results/custom-refs.txt
scripts/stale.sh <scratch>/stale        > results/stale.txt
node scripts/summarise.ts results/*.tsv > results/summary.txt
wrangler artifacts repos delete cas --namespace keel-spike-01 --force
```
