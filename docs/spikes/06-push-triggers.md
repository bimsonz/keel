# S6: Push triggers

**Date:** 2026-10-10. **Code:** [`spikes/06-push-triggers/`](../../spikes/06-push-triggers/). **Raw results:** [`spikes/06-push-triggers/results/`](../../spikes/06-push-triggers/results/).

## Question

Keel observes a push to a change repo through events; an explicit `submit` call is the authoritative signal. How reliable and how fast are the events?

- **Namespace-wide `triggers.events` → Workflow:** over 200 pushes across 50 repos, are any events missed or duplicated? What is the latency from push to Workflow instance start?
- **Per-repo Queue subscriptions:** what is the activation gap between creating a subscription and its first delivered event?
- **Odd cases:** how do branch and tag deletes, tags, `refs/notes/*`, multi-ref pushes and brand-new repos behave?

**Pass:** no missed events, and p95 < 10 s.

## Answer

- **The namespace-wide trigger passes.**
  - **200/200** pushes each started exactly one Workflow instance: **0 missed, 0 duplicates**.
  - Latency from push completion to instance start: **p50 1.5 s, p95 3.1 s, max 6.2 s**. That includes a 50-push burst that completed in 4.7 s, which had a p95 of 4.5 s.
- **Every ref-changing push in the namespace during the spike produced exactly one instance: 235 of 235.** This includes:
  - pushes to brand-new repos, made 0.5–2.7 s after creation. The namespace trigger has **no activation gap**;
  - tags, annotated tags and `refs/notes/commits`;
  - branch and tag deletes, with `after` = 40 zeros;
  - force pushes;
  - one event **per ref** in a multi-ref push.

  A no-op push, a fork and a repo deletion produced none.
- **Per-repo Queue subscriptions are not safe to rely on.**
  - In 1 of 4 probes, the first **52 s** of pushes after subscription creation were **dropped and never backfilled**: 5 pushes, with the first delivery at 63.5 s.
  - The other 3 probes delivered the first push 0.4–1.3 s after creation.
  - Once active, delivery took 1.8–5.5 s (p50 2.8 s, n = 16), which is slower than the trigger.
  - Subscriptions also **outlive their repo**: all 4 were still listed and enabled after the repos were deleted.
- **Go/no-go: GO** for one namespace-wide `cf.artifacts.repo.pushed` trigger per shard namespace as Keel's push observer, with `submit` kept authoritative. **No-go for per-repo subscriptions.** The spec fallback is not needed as the primary path, but keep a cheap reconciliation re-read as a safety net (see [Go / no-go](#go--no-go)).

## Setup

| Item | Value |
|---|---|
| Worker | `keel-spike-06-trigger`, default placement. HTTP routes ran in **LHR**. |
| Workflow | `keel-spike-06-push-wf` (class `PushEventWorkflow`). `run()` takes `Date.now()` as its first statement (instance start), then one `step.do` inserts `{ instance id, start, event.timestamp, repo, ref, before, after }` into D1 `keel-spike-06-log`. The insert is `INSERT OR IGNORE` on instance id, so a step retry cannot look like a duplicate event. |
| Trigger | `"triggers": { "events": [{ "type": "cf.artifacts.repo.pushed", "filter": { "namespace": "keel-spike-06" }, "targets": [{ "type": "workflow", "workflow_name": "keel-spike-06-push-wf" }] }] }`. Deploy printed `event triggers: 1`. |
| Per-repo subscriptions | Queues `keel-spike-06-repo-q` and `keel-spike-06-repo-q2`, consumed by the same Worker (`max_batch_size` 10, `max_batch_timeout` 1 s) into a D1 table `qevents` |
| Binding | `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "keel-spike-06" }]`, confirmed with `wrangler types` |
| Tooling | wrangler 4.149.0 (devDependency), pnpm, `pnpm install --ignore-workspace`; TypeScript 7 `tsc --noEmit` clean; `oxlint -c oxlint.config.json` clean |
| Push driver | `scripts/pushes.ts`. Repos are created through the Worker's `/create`. Pushes use local `git push --porcelain` with the token in a `GIT_CONFIG_*` env var, never in argv or the URL. Each push records `{ repo, ref, before, after, local start, local completion }` in `results/pushes.jsonl`. |
| Matcher | `scripts/match.ts` joins pushes and instances on `(repo, ref, after)`. Latency is instance `started_at` (Worker clock) − local push completion − clock offset. |
| Clock | Worker − local offset from `/now` round trips: **+72 ms** (RTT 124 ms) at the start and **+21.5 ms** (RTT 23 ms) at the end. The start value is used, so latencies carry about ±50 ms of clock uncertainty. |
| Client | London. `git push` to Artifacts took 0.4–2.0 s per push. |

### The 200 pushes

| Phase | Pushes | How | Span |
|---|---|---|---|
| `fresh` | 50 | For each of `r00`–`r49`: create the repo, then **immediately** commit and push `main`. The gap from `create()` returning to push completion was 532 / 1627 / 2668 ms (min / p50 / max). | 2.6 min |
| `spread` | 100 | Two round-robin rounds over the 50 repos: commit, push `main`, sleep 300 ms | 173 s |
| `burst` | 50 | One commit per repo prepared first, then 50 `git push` processes in parallel | **4.7 s** |

The `special` phase on `r00` (tags, notes, deletes, multi-ref, force, no-op) and the subscription probes are reported separately and are not part of the 200.

## Numbers

### Namespace trigger: 200 pushes, 50 repos (`results/match.json`)

| Metric | Value |
|---|---|
| Pushes (all `ok`) / repos | 200 / 50 |
| Matched / **missed** | 200 / **0** |
| **Duplicates** (more than one instance for a push) | **0** |
| Instances not matching any push (prefix `r`) | 0, once the 9 `special` pushes are accounted for |
| Push done → instance **start**, all | **p50 1498, p95 3142, max 6186** ms |
| … `fresh` (new repo, push within 0.5–2.7 s of create) | p50 1787, p95 4067, max 4895 |
| … `spread` | p50 1368, p95 2225, max 6186 |
| … `burst` (50 in 4.7 s) | p50 1291, p95 4512, max 5301 |
| Push done → instance **created** (`event.timestamp`) | p50 959, p95 1617, max 2820 |

Instance creation to `run()` start is Workflows scheduling: **p50 399 ms, p95 1588 ms, max 4507 ms** (n = 235, Worker clock only, so no clock offset). Most of the tail is there, not in event emission.

### Special refs on `r00` (`results/pushes.jsonl`, phase `special:*`)

| Push | Ref | before → after | Instances | Latency (s) |
|---|---|---|---|---|
| Lightweight tag | `refs/tags/light-1` | `0000…` → commit | 1 | 1.0 |
| Annotated tag | `refs/tags/ann-1` | `0000…` → **tag object** id | 1 | 1.2 |
| Notes | `refs/notes/commits` | `0000…` → notes commit | 1 | 0.4 |
| New branch | `refs/heads/feature-x` | `0000…` → commit | 1 | 1.6 |
| **Branch delete** | `refs/heads/feature-x` | commit → **`0000…`** | 1 | 1.2 |
| Multi-ref push (one `git push`, 2 refspecs) | `refs/heads/main` and `refs/heads/multi-b` | each its own | **2: one per ref** | 1.4 and 1.5 |
| Force push (non-fast-forward) | `refs/heads/main` | old → rewritten | 1 | 1.6 |
| No-op push (`[up to date]`) | `refs/heads/main` | unchanged | **0** | — |
| **Tag delete** | `refs/tags/light-1` | commit → **`0000…`** | 1 | 1.1 |

Non-push changes, observed for at least 90 s afterwards:

| Action | Instances |
|---|---|
| `fork("r01" → "r01-fork")` inside the namespace (`results/fork-trigger-probe.json`) | **0** |
| `delete()` of all 56 repos | **0** |

**Implications for the Workflow:**

- **Filter on `ref`.** The trigger fires for tags and notes, so a Keel Workflow must ignore refs it does not own. This includes `refs/notes/*`, if Keel writes notes.
- **Treat `after` = 40 zeros as a delete.** `@cloudflare/ci`'s mapper drops these and non-branch, non-tag refs; Keel needs the same rule.
- **A fork made into a namespace is invisible to its push trigger.** A fork's initial refs are not announced.

### Payload delivered to the Workflow

`event.payload` is an **object** (not a string). Its `id` equals the Workflow **instance id**, so a redelivered event would map to the same instance. It has **no `metadata` / `eventTimestamp`**; `event.timestamp` is the instance creation time. Captured from the first smoke push:

```json
{
 "id": "d5ba9ec7-4382-4c29-a7a6-eb2b95fb87ba",
 "type": "cf.artifacts.repo.pushed",
 "source": { "namespace": "keel-spike-06", "repoName": "smoke00" },
 "payload": {
  "ref": "refs/heads/main",
  "before": "0000000000000000000000000000000000000000",
  "after": "43f7fe04854ba084dc49565122166ab521c21cee",
  "commits": [ { "id": "43f7fe04…", "message": "smoke00 first", "messageTruncated": false,
                 "timestamp": "2026-10-10T18:58:19.000Z",
                 "author": { "name": "keel-s6", "email": "s6@keel.invalid" },
                 "committer": { "name": "keel-s6", "email": "s6@keel.invalid" }, "parents": [] } ],
  "totalCommitsCount": 1,
  "commitsTruncated": false
 }
}
```

### Per-repo Queue subscriptions: activation gap (`results/sub*-gap.json`)

Method:

1. Create a repo and push to it once.
2. Run `wrangler queues subscription create <queue> --source artifacts.repo --source-namespace keel-spike-06 --source-repo-name <repo> --events pushed`, and take time 0 when it returns.
3. Commit and push every 10 s until three events have arrived.
4. Re-check 12 minutes later for late deliveries.

| Probe | Repo / queue | Pushes before first delivery (s after creation) | First delivered push | Dropped, never delivered (re-checked 12 min later) |
|---|---|---|---|---|
| 1 (first subscription on a new queue) | `sub00` / `repo-q` | 5.6, 17.2, 28.8, 40.2, **52.0** | **63.5 s** | **5** |
| 2 (second subscription on that queue) | `sb00` / `repo-q` | — | 0.7 s | 0 |
| 3 (first subscription on another new queue) | `sc00` / `repo-q2` | — | 1.3 s | 0 |
| 4 (third subscription on `repo-q`) | `sd00` / `repo-q` | — | 0.4 s | 0 |

- **The activation gap ranges from under 1 s to between 52 and 63.5 s**, and pushes before activation are lost. With n = 4, the cause of the long gap is not established: a new queue alone did not reproduce it (probe 3).
- The namespace trigger saw **all 21** of these probe pushes, including the 5 the subscription dropped. Its latency on them was p50 1.2 s, p95 2.0 s and max 6.3 s.
- **Delivery once active** (n = 16):
  - push done → consumer receive: **p50 2.8 s, p95 5.5 s**, min 1.8 s;
  - the event's `metadata.eventTimestamp` is 0.02–0.45 s after local push completion;
  - Queue delivery adds 1.3–5.4 s with `max_batch_timeout: 1`.
- **Queue message bodies arrived as objects** (`typeof m.body === "object"`) in 16/16 messages, not as JSON strings. Parse defensively, accepting both.
- **One subscription per resource.**
  - The S2 attempt to add an account-level `artifacts` subscription was refused with `We currently do not support multiple subscriptions on the same resource.`
  - So per-repo subscriptions are also at most one per repo across the account.
- **Subscriptions survive repo deletion.** After all 56 repos were deleted, `wrangler queues subscription list` still showed all 4, `enabled: true`. Whoever deletes the repo must delete its subscription too.

### Commands and captured output (trimmed, redacted)

```console
$ D1_ID=… scripts/deploy.sh
Uploaded keel-spike-06-trigger
Deployed keel-spike-06-trigger triggers
  Consumer for keel-spike-06-repo-q
  workflow: keel-spike-06-push-wf
  event triggers: 1

$ node scripts/pushes.ts fresh r 50 ; node scripts/pushes.ts spread r 50 2 300 ; node scripts/pushes.ts burst r 50
r00 ok=true push=1703ms
r01 ok=true push=718ms
…
burst: 50 pushes, ok=50, all done within 4686 ms

$ curl -X POST -H "x-spike-key: …" <worker>/events?since=0 > results/events.json   # 235 instances
$ node scripts/match.ts
{ "pushes": 200, "repos": 50, "instances": 209, "matched": 200, "missed": 0, "duplicates": 0,
  "latencyPushDoneToInstanceStartMs": { "all": { "n": 200, "p50": 1498, "p95": 3142, "max": 6186 }, … },
  "latencyPushDoneToInstanceCreatedMs": { "n": 200, "p50": 959, "p95": 1617, "max": 2820 } }

$ wrangler queues subscription create keel-spike-06-repo-q --source artifacts.repo \
    --source-namespace keel-spike-06 --source-repo-name sub00 --events pushed --name keel-spike-06-sub00
✨ Successfully created event subscription 'keel-spike-06-sub00' with id '<id>'.
$ node scripts/pushes.ts sub sub00 <t0> 10000 40
0 t+6s ok=true 588291c7
1 t+17s ok=true 798e7758
2 t+29s ok=true ebfefb68
3 t+40s ok=true 064c698f
4 t+52s ok=true 32a089b3
5 t+63s ok=true 5d7f661e
6 t+75s ok=true ab09fd83
first queue event after 1 delivered: {"type":"cf.artifacts.repo.pushed","repo":"sub00","ref":"refs/heads/main",
  "before":"32a089b3…","after":"5d7f661e…","event_ts":"2026-10-10T19:08:31.376Z","body_type":"object"}
```

The 209 `instances` in the matcher output are the instances in repos with prefix `r`: the 200 pushes plus the 9 `special` ref updates on `r00`.

**wrangler config note.** The Artifacts guide shows `filter.repoName` and `target: { scriptName, workflowName }`. wrangler 4.149.0's schema accepts only `filter: { namespace, repo_name }` and `targets: [{ "type": "workflow", "workflow_name" }]`, and fills in `script_name` itself. It also accepts every Artifacts event type, from `cf.artifacts.repo.created` to `cf.artifacts.repo.token.revoked`. But in S2, a `cf.artifacts.repo.forked` rule never fired.

## Pass/fail

| Criterion | Result | Evidence |
|---|---|---|
| No missed events (namespace trigger, 200 pushes / 50 repos) | **PASS** | 200/200 matched and 0 duplicates. 235/235 ref updates in the namespace overall. |
| p95 < 10 s | **PASS** | 3.1 s overall, 4.5 s for the burst, max 6.2 s |
| Namespace trigger sees a brand-new repo (no per-repo gap) | **PASS** | 50/50 `fresh` pushes made 0.5–2.7 s after `create()`, plus 4/4 probe repos |
| Per-repo subscription activation gap | Measured: **unsafe** | 1 of 4 dropped its first 52 s of pushes (5 pushes, no backfill). 3 of 4 were active within about 1 s. |
| Deletes and non-branch refs | Measured | Branch and tag deletes fire with `after` = zeros. Tags and notes fire. A no-op push, a fork and a repo deletion do not. |

## Go / no-go

**GO: use one namespace-wide `cf.artifacts.repo.pushed` → Workflow trigger per shard namespace as Keel's push observer,** under these rules:

1. **`submit` stays authoritative.**
   - The trigger is the fast path: about 1.5 s typical and 3–4.5 s p95, even in a burst.
   - The spike showed no loss over 235 events in about 25 minutes. That proves no delivery guarantee.
2. **Keep a cheap reconciliation as a safety net,** a reduced form of the spec fallback. On `submit`, and once for any change with no event within about 10 s of its expected push, re-read HEAD (`log({ ref, limit: 1 })`).
   - The full [60, 150, 300] s re-read schedule is not needed for latency.
   - It still costs little and covers a dropped event.
3. **The Workflow must:**
   - filter by `ref` (it fires for `refs/tags/*` and `refs/notes/*`);
   - treat `after` = zeros as a delete;
   - expect one instance per ref in a multi-ref push;
   - use the instance id (= event id) for idempotency.
4. **Do not use per-repo Queue subscriptions**, for three reasons:
   - an activation gap of up to about 1 minute that silently drops pushes;
   - one subscription per resource;
   - subscriptions outlive their repos.

   Nothing in Keel's design needs them once the namespace trigger exists.
5. **Don't expect a pushed event from a fork.** Pool members (see S2) are announced by `await fork()`, not by an event.

**NO-GO** for designs that treat the per-repo subscription as live as soon as it is created.

## Fallback

The spec fallback is explicit `submit` only, plus a reconciliation re-read of HEAD at [60, 150, 300] s.

- **Not taken as the primary path:** the trigger passed both criteria.
- **Kept in reduced form** as the safety net in Go/no-go rule 2.
- **This is the path to take** if Keel must run without Workflows or triggers.

## Can-fail demonstrations

1. **The matcher reports a deliberately excluded event as missed.** `--drop n` removes the instances for the first n pushes before matching; `--dup n` injects n extra copies.

   | Run (`results/…`) | Pushes | Matched | Missed | Duplicates |
   |---|---|---|---|---|
   | `match.json` (control) | 200 | 200 | 0 | 0 |
   | `match-canfail-drop1.json` | 200 | 199 | **1**: `{ "phase": "fresh", "repo": "r00", "after": "7462b4f4ba" }` | 0 |
   | `match-canfail-drop5.json` | 200 | 195 | **5** | 0 |
   | `match-canfail-dup2.json` | 200 | 200 | 0 | **2** |

2. **The same push-to-event join detects real loss.** Joining probe 1's pushes with Queue messages, `sub-gap.ts` reported 5 pushes with no event (`droppedBeforeActivation: 5`). The trigger join on the same pushes reported 9/9 delivered. The join goes red when events are really missing, not only in simulation.
3. **No-op control.** The `[up to date]` push produced no instance. The 9 `special` ref updates produced exactly 9 instances, so the trigger is not emitting one event per `git push` regardless of what changed.

## Gotchas found

- **The wrangler `triggers.events` shape differs from the guide** (see the config note above).
- **No `eventTimestamp` reaches the Workflow.** Use `event.timestamp`, which is instance creation, or your own clock.
- **The Workflow instance id equals the event `id`.**
- **Queue message bodies are objects, not strings.**
- **Deleting the Worker:**
  - A Queue consumer must be removed first (`wrangler queues consumer remove`), or the delete fails with `code: 10064` (seen in S2).
  - Workflows outlive their Worker and need a separate `wrangler workflows delete` (seen in S2).
  - The trigger was cleared with `triggers.events: []` before deleting. Whether deleting the Worker alone removes the trigger is untested.
- **`wrangler queues subscription create` does support Artifacts sources** in wrangler 4.149.0, with `--source artifacts.repo --source-namespace … --source-repo-name …`. The OAuth login was enough; no extra API token was needed.

## Untested

- **Trigger behaviour under sustained load** above a 50-push burst in 4.7 s, and over hours rather than about 25 minutes.
- **Workflow-side placement:** the trigger Worker ran unplaced, and instance start latency was not compared with a placed Worker.
- **Trigger delivery while the target Workflow is erroring or being redeployed.**
- **A `repoName` filter on `triggers.events`.**
- **Events for pushes larger than one commit batch** (`commitsTruncated: true`).
- **The cause of the 52–63.5 s activation gap** (n = 4, 1 long). Repeated per-repo subscription creation at scale.
- **The account-level `artifacts` source** (`repo.created`, `repo.deleted`, `repo.forked`). It is held by another subscription on this shared account (see S2).

## Teardown

All S6 resources were deleted on 2026-10-10:

```console
$ curl … /delete?names=<all 56 repos>
deleted 56 of 56 []
$ wrangler artifacts repos list --namespace keel-spike-06
No Artifacts repos found in namespace "keel-spike-06".
$ wrangler queues subscription delete keel-spike-06-repo-q --id <id> --force     # ×3; and ×1 on repo-q2
✨ Successfully deleted event subscription 'keel-spike-06-sb00' with id '<id>'.
✨ Successfully deleted event subscription 'keel-spike-06-sd00' with id '<id>'.
✨ Successfully deleted event subscription 'keel-spike-06-sub00' with id '<id>'.
✨ Successfully deleted event subscription 'keel-spike-06-sc00' with id '<id>'.
$ wrangler queues subscription list keel-spike-06-repo-q ; … keel-spike-06-repo-q2
No event subscriptions found for queue 'keel-spike-06-repo-q'.
No event subscriptions found for queue 'keel-spike-06-repo-q2'.
$ wrangler deploy -c wrangler.deploy.jsonc          # with "triggers": { "events": [] }
  event triggers: 0
$ wrangler queues consumer remove keel-spike-06-repo-q keel-spike-06-trigger     # and repo-q2
Removed consumer from queue keel-spike-06-repo-q.
Removed consumer from queue keel-spike-06-repo-q2.
$ wrangler delete --name keel-spike-06-trigger --force
Successfully deleted keel-spike-06-trigger
$ wrangler workflows delete keel-spike-06-push-wf
✅ Workflow "keel-spike-06-push-wf" removed successfully.
$ wrangler queues delete keel-spike-06-repo-q ; wrangler queues delete keel-spike-06-repo-q2
Deleted queue keel-spike-06-repo-q.
Deleted queue keel-spike-06-repo-q2.
$ wrangler d1 delete keel-spike-06-log -y
Deleted 'keel-spike-06-log' successfully.

# final listing, both spikes
$ wrangler artifacts namespaces get keel-spike-02 --json ; … keel-spike-06 --json
keel-spike-02 repo_count 0 created_at 2026-10-10T18:49:08.572Z
keel-spike-06 repo_count 0 created_at 2026-10-10T18:58:17.487Z
$ wrangler deployments list --name keel-spike-06-trigger
This Worker does not exist on your account. [code: 10007]
$ wrangler workflows list | grep keel-spike-0[26] ; wrangler queues list | grep keel-spike-0[26] ; wrangler d1 list | grep keel-spike-0[26]
(none)
```

**Remainder:** the namespace `keel-spike-06` with **0 repos**. Wrangler cannot delete namespaces. It was first used at 2026-10-10T18:58:17Z by the Worker's `/create`, called from a London client (default placement; the Worker's HTTP routes ran in LHR).

## Reproduce

```sh
cd spikes/06-push-triggers && pnpm install --ignore-workspace
source <scratch>/cf.env                                    # CLOUDFLARE_ACCOUNT_ID only
wrangler d1 create keel-spike-06-log && wrangler queues create keel-spike-06-repo-q
D1_ID=… scripts/deploy.sh
wrangler d1 execute keel-spike-06-log -c wrangler.deploy.jsonc --remote --file schema.sql
wrangler secret put SPIKE_KEY -c wrangler.deploy.jsonc
export WORKER_URL=… SPIKE_KEY_FILE=… WORK=<scratch>/s06-work
node scripts/pushes.ts clock && cp results/clock.json results/clock-start.json
node scripts/pushes.ts fresh r 50 && node scripts/pushes.ts spread r 50 2 300 && node scripts/pushes.ts burst r 50
node scripts/pushes.ts special r00
curl -X POST -H "x-spike-key: …" "$WORKER_URL/events?since=0" > results/events.json
node scripts/match.ts ; node scripts/match.ts --drop 1 ; node scripts/match.ts --dup 2
```
