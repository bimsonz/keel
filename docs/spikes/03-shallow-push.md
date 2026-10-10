# S3: Shallow push, large push and fetch-by-SHA from a fork

**Date:** 2026-10-10, run against the live Artifacts service from London. **Code:** [`spikes/03-shallow-push/`](../../spikes/03-shallow-push/). **Raw results:** [`spikes/03-shallow-push/results/`](../../spikes/03-shallow-push/results/).

## Answer

- **Shallow push: accepted.** A `clone --depth 1` + commit + push into a **new empty repo** succeeds.
  - The server records the client's shallow boundary.
  - From then on the destination is a **permanently shallow repo**:
    - a plain `git clone` of it comes back shallow (2 commits);
    - `git fsck` passes;
    - `git fetch --unshallow` exits 0 but changes nothing;
    - the boundary's parent is unknown to the server (fetch → HTTP 500, binding `readCommit` → `null`).
  - Pushed back into the repo it was cloned from, which holds the history, the same shallow push yields a complete, non-shallow repo.
- **Large push: there is a hard 64 MiB cap per receive-pack request.**
  - The 300 MB full push fails with `receive-pack request exceeds maximum size` after 13.6 s. 150 and 75 MB fail the same way.
  - Bisected: a 66,093,229-byte pack is accepted and a 67,142,171-byte pack is refused, which brackets 64 MiB (67,108,864 B).
  - No `MEMORY_LIMIT` appeared.
  - The cap is per request, not per repo: the 150 MB repo pushed as three ~49 MiB commits landed and cloned back with a clean `fsck --full`.
- **Fetch-by-SHA from a fork: works**, in protocol v2 and v0, for:
  - the advertised tip;
  - a reachable non-tip commit;
  - a commit whose branch had been deleted (unreachable).
- **Isolation from later source pushes:** a commit pushed to the source after the fork is **not** fetchable from the fork. An unknown SHA gives **HTTP 500**, not a clean "not our ref".
- **Go/no-go: GO, with conditions.** Agents shallow-clone their Change repo and push back to a named branch in that same repo, which always holds the base history. Keel must never shallow-push into an empty repo. Every push must stay under 64 MiB per request.
- **Fallback taken:** the specified one, made concrete:
  - full push only for repos under 64 MiB;
  - otherwise chunked per-commit pushes;
  - agents push shallow clones only to a named branch of the repo they cloned from.

## Question

- Does Artifacts accept a push from a shallow clone, and what does the destination look like afterwards?
- Can a ~300 MB repo be full-pushed, and if not, where is the ceiling?
- Can a commit be fetched by SHA from a fork made through the binding, including SHAs that are unadvertised or exist only in the source?

**Pass:** the shallow push is accepted.

## Setup

| Item | Value |
|---|---|
| Repos | `keel-spike-03/src`, `shallow-dst`, `big` (recreated per measurement) and `fork1`, created with wrangler 4.149.0. Each repo's creation token is used for git. |
| Seed (`scripts/seed.sh`) | 50 commits: each adds a 60 KB random binary file and appends to `docs/log.txt`. `.git` 4.3 MB; push 1489 ms. |
| Client | Apple git 2.50.1, hermetic config, bearer header through `GIT_CONFIG_*` env vars (`scripts/lib.sh`, the same as S1) |
| Shallow test (`scripts/shallow.sh`) | `clone --depth 1` of src → commit → push to empty `shallow-dst`. Then a full clone + `fsck --full` + shallowness + `--unshallow` check (`verify_clone`) on each destination, and fetch-by-SHA probes against `shallow-dst`. The same shallow clone is then pushed back to src as `agent/shallow-<pid>`. |
| Big push (`scripts/big.sh`) | 97% random 1 MiB binary files, about 3% text, in 3 commits, repacked into one pack; then `git push main`. `scripts/chunked.sh` pushes `main~2`, `main~1`, `main` one request at a time. |
| Forker Worker | `keel-spike-03-forker` (`worker/`), binding `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "keel-spike-03" }]`. `/fork` runs `(await env.ARTIFACTS.get(src)).fork(name, { defaultBranchOnly: true })`, then reads metadata **only** through `await handle.info()`. `/log` and `/commit` expose the binding's `log()` and `readCommit()`. Calls need an `x-spike-key` header matching a Worker secret (403 without it). Bundle 2.6 KiB. |
| Fetch-by-SHA (`scripts/fork-fetch.sh`) | After the fork: push F1 → F2 to fork `main`, push F3 to a temp branch and delete it, push S1 to src `main`. Then, from fresh repos, `git fetch <fork> <sha>` with `protocol.version=2` and `0`. |

## Numbers

### Shallow push (`results/shallow.txt`)

```text
## 1. shallow clone of src
clone exit=0 ms=878
is-shallow=true commits-local=1 boundary=953da79edb2d
new commit=ab0cd48aead3 parent=953da79edb2d

## 2. push the shallow clone to the EMPTY repo shallow-dst
To https://<acct>.artifacts.cloudflare.net/git/keel-spike-03/shallow-dst.git
 * [new branch]      HEAD -> main
push exit=0 ms=673
shallow lines sent: > shallow 953da79edb2d
dst refs: ab0cd48aead3	HEAD ab0cd48aead3	refs/heads/main

## 3. does shallow-dst serve a valid clone?
  shallow=true commits=2
  fsck:                                  (exit 0, no output)
  server-recorded shallow boundary: 953da79edb2d
  after --unshallow: exit=0 shallow=true commits=2
VERIFY FAIL [dst] plain clone is shallow: history truncated at the boundary
-- shallow clone of dst (depth 1)
depth-1 clone exit=0 fsck-ok
-- into a fresh repo, fetch by SHA from dst: the shallow root itself, then its parent (absent on dst)
warning: rejected 953da79edb2d8c853d1619e2c5cfe0f787677c9b because shallow roots are not allowed to be updated
fetch boundary 953da79edb2d exit=0 object-present=yes
warning: rejected ab0cd48aead3b5f3d4433444c4a81ac02e1798d5 because shallow roots are not allowed to be updated
fetch tip ab0cd48aead3 exit=0 object-present=yes shallow=false
 * branch            ab0cd48aead3b5f3d4433444c4a81ac02e1798d5 -> FETCH_HEAD
fetch tip with --update-shallow exit=0 object-present=yes shallow=true
error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500
fatal: expected 'packfile'
fetch boundary's parent 92014fdc862c (not on dst) exit=128

## 4. push the same shallow clone back to src (which holds the history) as agent/shallow-<pid>
 * [new branch]      HEAD -> agent/shallow-91812
push exit=0 ms=427
  shallow=false commits=53
  root commits: 1
VERIFY OK   [src]
```

This is the second of two identical runs. The first run gave the same outcomes, with a push of 795 ms into the empty repo and 526 ms back to src. `shallow-dst` was recreated between runs.

The binding's view of the shallow repo (`results/binding-view.txt`):

```text
$ scripts/call.sh "/log?name=shallow-dst&limit=50"
200 0.292660
[{"hash": "ab0cd48aead3", "parents": ["953da79edb2d"], "message": "agent commit on shallow clone"}, {"hash": "953da79edb2d", "parents": ["92014fdc862c"], "message": "seed 50"}]
$ scripts/call.sh "/commit?name=shallow-dst&hash=<boundary parent 92014fdc862c...>"
200 0.225888
null
```

`log()` stops at the boundary without an error. The boundary commit still names a parent that `readCommit()` can't find.

### Large full push (`results/big-*.txt`)

| Target | Pack | Pack bytes | Result | Push wall ms |
|---|---|---|---|---|
| 300 MB | 291.11 MiB (318 objects) | n/a | **refused**: `receive-pack request exceeds maximum size` | 13629 |
| 150 MB | 145.07 MiB | n/a | **refused**, same message | 5866 |
| 75 MB | 72.04 MiB | 75,533,615 | **refused**, same message | 3747 |
| 68 MB | 65.04 MiB | n/a | **refused**, same message | 3403 |
| 66 MB | 64.03 MiB | 67,142,171 | **refused**, same message | 4546 |
| 65 MB | 63.03 MiB | 66,093,229 | accepted, `remote main` = local | 3377 |
| 55 MB | 53.03 MiB | 55,603,912 | accepted | 3456 |
| 40 MB | 38.03 MiB | 39,869,939 | accepted; clone back 969 ms, `fsck --full` ok | 2073 |

```text
== big-300                                   (generator: files ≈ 303 MB, .git 306 MB, 318 objects)
pack on disk: 291.11 MiB
Total 318 (delta 14), reused 318 (delta 14), pack-reused 0 (from 0)
error: remote unpack failed: receive-pack request exceeds maximum size
 ! [remote rejected] main -> main (receive-pack request exceeds maximum size)
push exit=1 ms=13629
== big-66
pack on disk: 64.03 MiB
Writing objects: 100% (82/82), 64.03 MiB | 70.73 MiB/s, done.
error: remote unpack failed: receive-pack request exceeds maximum size
 ! [remote rejected] main -> main (receive-pack request exceeds maximum size)
push exit=1 ms=4546
== big-65
pack on disk: 63.03 MiB
Writing objects: 100% (81/81), 63.03 MiB | 76.38 MiB/s, done.
push exit=0 ms=3377
remote main: 912c4c140240 local: 912c4c140240
```

**Ceiling:** the request body is the pack plus about 150 bytes of commands, and the boundary falls between 66,093,229 B (accepted) and 67,142,171 B (refused). This is consistent with a **64 MiB (67,108,864 B) limit on one receive-pack request**.

- No `MEMORY_LIMIT` or other error code appeared.
- A refused push leaves the repo untouched (`remote main:` empty).
- The 300 MB push ran with an earlier output filter that dropped the `Writing objects` line.

**Per request, not per repo** (`results/big-150-chunked.txt`):

```text
main~2 new-objects=49.0MiB exit=0 ms=2748  * [new branch] 6ef99a1031761fcdb9b10ea5a2edf2cb5b9caac7 -> main
main~1 new-objects=49.0MiB exit=0 ms=2813  6ef99a1..20b6b33 20b6b33e86626c13d03916786a7c3aca7e55579f -> main
main new-objects=47.0MiB exit=0 ms=2408  20b6b33..a43feb3 a43feb3426bb95b9968e96c64f87efabe0b0a6b9 -> main
remote main: a43feb3426bb local: a43feb3426bb
clone back exit=0 ms=3216
fsck --full: ok
head=a43feb3426bb commits=3 pack=145.07 MiB
Deleted Artifacts repo "big" from namespace "keel-spike-03".
```

Each `big` repo was deleted as soon as it had been measured. The last deletion is shown above.

### Fork, then fetch by SHA (`results/fork.txt`, `results/fork-fetch.txt`)

```text
$ scripts/call.sh '/fork?src=src&name=fork1'
200 3.463749
{ "forkMs": 3385, "readyAfterMs": 23, "polls": 1,
  "info": { "name": "fork1", "defaultBranch": "main", "lastPushAt": null,
            "source": "artifacts:keel-spike-03/src", "readOnly": false,
            "remote": "https://<acct>.artifacts.cloudflare.net/git/keel-spike-03/fork1.git", … } }
```

```text
## fork refs right after the fork
953da79edb2d	HEAD
4b006007923a	refs/heads/agent/shallow
3eaa2b901b34	refs/heads/agent/shallow-33811
ab0cd48aead3	refs/heads/agent/shallow-91812
953da79edb2d	refs/heads/main
F1=9f481acb38f8 F2=4a1711e9bd1f F3=2c8354800962   (F3's branch deleted; fork refs: main=F2 plus the agent/* branches)
S1=8d8b772287c7                                     (pushed to src after the fork)

## fetch by SHA from the fork into a fresh empty repo
advertised-tip-F2 (4a1711e9bd1f)   v2 exit=0   object-present=yes
reachable-non-tip-F1 (9f481acb38f8) v2 exit=0   object-present=yes
unreachable-F3 (2c8354800962)      v2 exit=0   object-present=yes
source-only-S1 (8d8b772287c7)      v2 exit=128 object-present=no  error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500 fatal: expected 'packfile'
src-branch-not-forked (4b006007923a) v2 exit=0   object-present=yes
nonexistent (3e31944ec8e1)         v2 exit=128 object-present=no  error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500 fatal: expected 'packfile'
advertised-tip-F2 (4a1711e9bd1f)   v0 exit=0   object-present=yes
reachable-non-tip-F1 (9f481acb38f8) v0 exit=0   object-present=yes
unreachable-F3 (2c8354800962)      v0 exit=0   object-present=yes
source-only-S1 (8d8b772287c7)      v0 exit=128 object-present=no  error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500 fatal: the remote end hung up unexpectedly
src-branch-not-forked (4b006007923a) v0 exit=0   object-present=yes
nonexistent (3e31944ec8e1)         v0 exit=128 object-present=no  error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500 fatal: the remote end hung up unexpectedly

## the realistic flow: a full clone of src fetches the agent's tip from the fork by SHA
into-src-clone-F2 (4a1711e9bd1f)   v2 exit=0   object-present=yes
  ms=431 parent-chain-ok=yes
```

| SHA fetched from the fork | v2 | v0 |
|---|---|---|
| Advertised tip (F2) | ok | ok |
| Reachable, unadvertised (F1 = F2~1) | ok | ok |
| Unreachable: branch deleted (F3) | **ok** | **ok** |
| Exists only in the source, pushed after the fork (S1) | HTTP 500 | HTTP 500 |
| Never existed | HTTP 500 | HTTP 500 |
| Into a full clone of src (the trunk-composer case) | ok, 431 ms | not run |

**`defaultBranchOnly: true` didn't limit the fork.** The fork came with all four src branches, not just `main`.

**`info()` push metadata.** `info()` on src and on fork1 still reported `lastPushAt: null` after several pushes, and `updatedAt` stayed at the creation time (`results/binding-view.txt`).

## Pass/fail

| Criterion | Result | Evidence |
|---|---|---|
| Shallow push accepted (into an empty repo) | **PASS** | exit 0; client sent `shallow 953da79edb2d`; `dst` main = the new commit |
| Destination serves a clone that passes `git clone` + `git fsck` | **PASS** | clone exit 0, fsck exit 0 |
| Destination holds a complete history | **FAIL (inherent)** | every clone is shallow at the pushed boundary; `--unshallow` is a no-op; the boundary parent is unknown to the server |
| Shallow push into the repo that holds the history | **PASS** | `agent/shallow-*` pushed; full clone non-shallow, 53 commits, 1 root, fsck ok |
| 300 MB full push | **FAIL** | refused at the 64 MiB per-request cap; 150 and 75 MB also refused; no `MEMORY_LIMIT` |
| Large repo via chunked pushes | **PASS** | 145 MiB in 3 requests; clone back + `fsck --full` ok |
| Fetch an unadvertised SHA from a fork | **PASS** | reachable non-tip and unreachable both fetched (v2 and v0) |
| SHA that only exists in the source is not served by the fork | **PASS** (isolation) | HTTP 500, object absent |

## Go / no-go

**GO, with conditions:**

1. **Agents shallow-clone their Change repo and push back to a named branch of that same repo.** The repo was forked from trunk, so it already holds the history beneath the boundary. Keel must never shallow-push into an empty or unrelated repo: the result is permanently shallow, and nothing on the server can deepen it.
2. **Any check that a repo holds full history must assert non-shallowness**, for example a clone that reports `is-shallow-repository=false` and reaches a root commit. `git fsck` passes on the truncated repo.
3. **Every receive-pack request must stay under 64 MiB.** Keel's push paths (trunk composer, seeding, any import-by-push) must split a large push into per-commit chunks, or seed through the binding's `import` (untested here).
4. **Fetch-by-SHA failures surface as HTTP 500.** Callers must treat a 500 on a fetch-by-SHA as "maybe absent", confirm with a read, and not retry it as transient.

## Fallback taken

The specified fallback, made concrete:

- **Small repos:** a full push only when the pack is under 64 MiB (keep a margin: ≤ 60 MiB).
- **Larger repos:** chunked per-commit pushes, each under the cap. This was demonstrated with 145 MiB in three requests.
- **Agents:** push to a named branch of their own Change repo, never shallow into an empty repo.

## Can-fail demonstrations

1. **The shallow-destination check goes red on the truncated repo and green on the complete one.** `verify_clone` (a clone that must be non-shallow, pass `fsck --full` and reach a root) printed `VERIFY FAIL [dst] plain clone is shallow: history truncated at the boundary` for `shallow-dst` and `VERIFY OK [src]` for src (53 commits, 1 root). The naive check (clone + fsck) passes on `shallow-dst`, so it can't fail here, which is why the stronger check is required.
2. **The size check goes red above the cap and green below it.** It failed at 64.03, 65.04, 72.04, 145.07 and 291.11 MiB, and passed at 38.03, 53.03 and 63.03 MiB, each followed by a `remote main` = local read-back.
3. **The fetch-by-SHA probe reports absence.** `object-present=no`, exit 128, for the source-only and nonexistent SHAs; `object-present=yes` for the others. It can tell the cases apart.
4. **Fetching from a shallow repo into a full repo exits 0 without updating refs.** The `rejected … shallow roots` warning, then `--update-shallow`, showed this. The exit code alone can't tell success from failure, so the probe checks object presence and `FETCH_HEAD`.

## Design-relevant findings

1. **The server stores the shallow boundary sent by the pusher.** A repo seeded by a shallow push is shallow forever, for git and for the binding: `log()` stops at the boundary, and `readCommit()` returns `null` for the parent.
2. **A fetch from a shallow repo into a full repo silently does nothing.** Exit 0, objects downloaded, refs not updated, and only a warning on stderr. Any Keel fetch must verify the ref or `FETCH_HEAD`, not the exit code.
3. **There is no 300 MB push.** The hard limit is 64 MiB per receive-pack request; the 1 GB per-repo limit is reachable only through many requests. The refusal appears to come only after the whole body is uploaded: wall time scales with size, 13.6 s for 291 MiB (about 21 MiB/s from London).
4. **Any object in a repo can be fetched by SHA, reachable or not.** A deleted branch's commits stay downloadable by anyone with a read token for that repo. Removing pushed secrets needs a repo deletion, not a branch deletion.
5. **A fork does not see the source's later pushes.** Its objects stay isolated from what is pushed to the source after the fork.
6. **A fork copied every branch even with `defaultBranchOnly: true`.** Change repos forked from trunk will inherit whatever branches trunk carries.
7. **One fork call took 3385 ms**, for a 4.3 MB, 50-commit source, single sample. The repo was then ready on the first `get()`, 23 ms later. S2 sizes this properly.
8. **`info().lastPushAt` stayed `null` and `updatedAt` didn't move after pushes.** Push detection must use `ls-remote` or the `pushed` events, not `info()`.
9. **Unknown SHAs return HTTP 500** in both protocol versions.
10. **Protocol v2 upload-pack advertises `filter`**, which contradicts the expectation of no filter support. It was not exercised.

## Untested

- The binding's `import()` path, and whether it hits `MEMORY_LIMIT` at 300 MB.
- Partial clone (`--filter=blob:none`) against the advertised v2 `filter`.
- A shallow push into a repo holding *part* of the history, or a deeper `--depth N`.
- `fetch --deepen` against a shallow-seeded repo. Only `--unshallow` was tried.
- Forking a shallow repo.
- Fork latency distribution, concurrency and copy-on-write behaviour. One fork only; that is S2's job.
- `defaultBranchOnly: false` (the `all=1` path of the Worker).
- The 1 GB per-repo limit.
- Whether the 64 MiB cap counts the compressed request body or the pack only. git sent an uncompressed chunked body here.
- Large fetches beyond 145 MiB.

## Teardown

```console
$ wrangler artifacts repos list --namespace keel-spike-03   # before
│ fork1       │ main           │ false     │ ready  │ 2026-10-10T19:11:43.224Z │
│ shallow-dst │ main           │ false     │ ready  │ 2026-10-10T18:59:21.738Z │
│ src         │ main           │ false     │ ready  │ 2026-10-10T18:56:55.496Z │
$ wrangler artifacts repos delete fork1 --namespace keel-spike-03 --force
Deleted Artifacts repo "fork1" from namespace "keel-spike-03".
$ wrangler artifacts repos delete shallow-dst --namespace keel-spike-03 --force
Deleted Artifacts repo "shallow-dst" from namespace "keel-spike-03".
$ wrangler artifacts repos delete src --namespace keel-spike-03 --force
Deleted Artifacts repo "src" from namespace "keel-spike-03".
$ wrangler delete --name keel-spike-03-forker --force
Successfully deleted keel-spike-03-forker
$ wrangler artifacts repos list --namespace keel-spike-03   # after
No Artifacts repos found in namespace "keel-spike-03".
$ wrangler artifacts namespaces get keel-spike-03
namespace:   keel-spike-03
repo_count:  0
created_at:  2026-10-10T18:56:54.243Z
updated_at:  2026-10-10T19:13:30.139Z
$ wrangler deployments list --name keel-spike-03-forker
✘ [ERROR] A request to the Cloudflare API (/accounts/<acct>/workers/scripts/keel-spike-03-forker/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
$ curl -s -o /dev/null -w '%{http_code}' https://keel-spike-03-forker.<subdomain>.workers.dev/info
404
```

`big` was deleted earlier, right after its last measurement. wrangler 4.149.0 can't delete namespaces, so `keel-spike-03` remains with `repo_count: 0`. Full log: `results/teardown.txt`.

## Reproduce

```sh
cd spikes/03-shallow-push
wrangler artifacts repos create src --namespace keel-spike-03 --json          # keep outputs out of the repo
wrangler artifacts repos create shallow-dst --namespace keel-spike-03 --json
REMOTE=<src remote> TOKEN=<src token> scripts/seed.sh <scratch>/seed
SRC_REMOTE=… SRC_TOKEN=… DST_REMOTE=… DST_TOKEN=… scripts/shallow.sh <scratch>/shallow
wrangler artifacts repos create big --namespace keel-spike-03 --json
REMOTE=<big remote> TOKEN=<big token> scripts/big.sh 300 <scratch>/big300    # recreate `big` after any accepted push
REMOTE=… TOKEN=… scripts/chunked.sh <scratch>/big150
wrangler artifacts repos delete big --namespace keel-spike-03 --force
(cd worker && wrangler types && wrangler deploy && wrangler secret put SPIKE_KEY)
WORKER_URL=… SPIKE_KEY=… scripts/call.sh '/fork?src=src&name=fork1'
wrangler artifacts repos issue-token fork1 --namespace keel-spike-03 --scope write --ttl 7200 --json
SRC_REMOTE=… SRC_TOKEN=… FORK_REMOTE=… FORK_TOKEN=… scripts/fork-fetch.sh <scratch>/fork
```
