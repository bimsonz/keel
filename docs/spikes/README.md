# Spikes

Each spike is a time-boxed experiment against the live Cloudflare edge (a Cloudflare account, resources named `keel-spike-NN-*`). Each one has its own document here, which records:
- the question;
- the setup;
- the measured numbers, with the commands and their output;
- pass/fail against the spec;
- go/no-go;
- the fallback taken.

Spike code lives in `spikes/NN-slug/`. It is throwaway, and sits outside the pnpm workspace. The demo fixture is `fixtures/forge-lite/`; the evidence for it is in its `scenarios/README.md`.

## Results

| ID | Document | Verdict | Key numbers | Fallback taken |
|---|---|---|---|---|
| S1 | [Push CAS](01-push-cas.md) | **Pass: go** | 0 server CAS violations in 180 two-pusher races; stale, zero and unknown old ids refused (`stale ref`); `atomic` advertised; custom refs round-trip | None (the single writer + WAL + read-back stays primary) |
| S2 | [Forks](02-forks.md) | **Partial: go via pool** | 100 concurrent forks of one source succeed, unthrottled. Ready p95: 3.9 s at 1 MB, **7.2 s at 50 MB** (fails ≤ 5 s); 12–62 s at 300 MB. `repo.forked` untested | Pre-forked pool, refilled in parallel, with TTL clean-up |
| S3 | [Shallow push](03-shallow-push.md) | **Pass: go with conditions** | A shallow push into an empty repo is accepted, but the shallow boundary is kept; each receive-pack request is capped at ~64 MiB | Full push only under 64 MiB, else chunked; shallow clones push only back to their source |
| S4 | [Tier 2 container](04-tier2-container.md) | **Pass: go** | The token is injected at egress and absent from env, `/proc` and the filesystem. Cold start 0.57 s p50; warm verify (clone + merge-tree + 214 tests) 6.2 s p50; 10 concurrent in ~16 s; ~5.4 vCPU-s per suite on `standard-2` | None |
| S5 | [K2](05-k2.md) | **Go with conditions** | Produce p99 1,411 ms pooled over 21,478 sends (one run's p99 was 2,749 ms, which fails); each `send()` costs a fixed ~400–500 ms. Consume reached 4,454 rec/s at `max_records` 10,000 (pass) but 1,108 at 1,000 (fail). Live lag p50 1.8 s; 0 order or duplicate findings; lease expiry and nack redeliver. The binding is produce-only; consume is HTTP with a token | Not taken: outbox in the same transaction, then batched sends from an alarm; the Projector pulls 10k at a time. The Queues fallback was measured, and it doesn't keep per-entity order |
| S6 | [Push triggers](06-push-triggers.md) | **Pass: go** | Namespace `triggers.events`: 235/235 ref updates seen, 0 missed, 0 duplicated; p95 3.1 s; no activation gap. Per-repo subscriptions dropped 52 s of pushes | Per-repo subscriptions rejected; `submit` stays authoritative |
| S8 | [Test harness](08-test-harness.md) | **Pass: go** | Every binding type Keel uses (D1, DO SQLite, Workflow, Queue, service binding, cross-script DO, R2, Effect) green in workerd, each with a seeded defect that goes red | None |
| S9 | [Emitters](09-emitters.md) | **Go on the fallback** | One handler object serves REST and MCP with no casts; REST body = MCP `structuredContent` in the pool and live on staging. Negotiated shared routes untested (http-mcp 0.1) | 0.27/0.24/0.1/0.5; upgrade once newer releases are published |
| S11 | [Effect on Workers](11-effect-on-workers.md) | **Pass: go** | Runtime overhead p50 0.002 ms per request (< 1 ms); Layer per request +0.06 ms; keel 500 KiB gzip, 116 ms startup; live warm server CPU 4–9 ms; abort interrupts and finalises | One `ManagedRuntime` per isolate |
| S12 | [workspace-git](12-workspace-git.md) | **Go with placement** | CPU p95 ≤ 190 ms. Cycle p95 2.3 s from LHR (fails < 2 s) and 0.96 s placed near the backend | — |
| S13 | [GitCore](13-gitcore.md) | **Pass: go** | 0 wrong trees in 10,000 histories against `git merge-tree`; reads p95 25–45 ms when co-located; 3-change compose + push accepted; stale push refused; pako replay 378/378 | None. MergeBox handles refusals |
| S14 | [Tier 1 parity](14-tier1-parity.md) | **Fail: fallback** | 100% per-test parity in all six worlds, but warm p50 253–449 ms per file, one DO is one CPU, and a run holding 200 MiB returns `ok` | ExecBox runs suites; Tier 1 runs probes (107 ms cold, 8 ms warm) |
| S15 | [CIWorkflow](15-ciworkflow.md) | **Go: subclass** | All six checks ran live. Fork reason #1 (one cache scope per instance) confirmed and worked around; #2 (token-free hydration) and #3 (egress interception) refuted | No fork |
| S16 | [Deploy adapters](16-deploy-adapters.md) | **Pass: go** | (a) 30/30 cold first bytes < 1 s; (b) previews serve, from local only; (c) 10% split observed, rollback restores; (d) nothing left behind | None. The in-Worker Previews REST path with a scoped token is untested |
| S17 | [Clef](17-clef-eval.md) ([dataset](s17-dataset.json)) | **Go for Clef, conditional** | Clef recall 100%, decoy false positives 0%; permuted agreement 95.0% only with all permutations asked in one call; Flash misses one and is no faster | Flash dropped; deterministic fallback armed behind re-measuring on ≥ 200 items |
| S17b | [Clef at scale](17b-clef-scale.md) ([dataset](s17b-dataset.json)) | **Fail: fallback** | 242 items: relabelled agreement 90.9% (Wilson 86.6–93.9, against ≥ 95%), recall 97.0% (91.6–99.0), precision 91.6%, decoy false positives 14.3%. Clef can't see cache invalidation, so B, B′ and careless get the same answer | Deterministic extractors and lattices decide; Clef only ranks probes |
| S18 | [Wasm in Dynamic Workers](18-wasm-loader.md) | **Go with conditions** | All four tools instantiate and match Node; 64 MiB code ceiling; cold < 300 ms only with bytes held in memory; a single 255 MiB memory still returns `ok` | Ruff ships as a static tool Worker |
| S26 | [Probe drafting](26-probe-drafting.md) | **Pass at the bar: go, template-first** | Kimi K2.7 Code free-form: 8/10 admitted (CI 0.49–0.94), 0 vacuous. Freshness template: Kimi 10/10, Qwen 2.5 Coder 9/10, about 7× faster. Synchronous `env.AI.run` times out at about 235 s for reasoning models. A do-nothing-revoke mutant catches vacuous probes the matrix admits | Templates first for known predicates; free-form drafting (pinned Kimi) otherwise |

## Tier decision (S13, S14, S15, S18)

- **Tier 0:** GitCore composes candidates. MergeBox (a container with real git) takes every merge GitCore refuses.
- **Tests:** suites run in Tier 2: `KeelVerify extends CIWorkflow` with `KeelSandbox` on `standard-2`. Probes and the world matrix's probe cells run in Tier 1, on a fresh isolate id per run.
- **`@cloudflare/ci`:** subclassed, not forked. Candidates hydrate from content-addressed R2 bundles through a custom `SourceControlAdapter`. The trusted install's snapshot is handed to candidates as a bundle.
- **Wasm tools:** clang-format, tree-sitter and hcl2json run in Tier 1 isolates behind one tool DO that holds the bytes. Ruff ships as a static tool Worker. Keel enforces its own memory caps.

## Still open

- **S16 (b):** calling the Previews REST API from inside a Worker with a per-Worker scoped token held in Secrets Store needs that token.
- **S16 (a):** the `cand-<id>.<host>` wildcard form needs approval for the DNS change. The path form on workers.dev is measured.
- **S2:** `repo.forked` event latency. The account-level `artifacts` event source already has its one allowed subscription, held by another workload.

## Final sweep (10 Oct 2026)

Every spike tore down its own resources and pasted its listing into its document. The sweep afterwards ran the following checks (the account ID is redacted):

```
$ wrangler r2 bucket list | grep -c keel-spike        → 0
$ wrangler queues list | grep -c keel-spike           → 0
$ wrangler workflows list | grep -c keel-spike        → 0
$ wrangler d1 list | grep -c keel-spike               → 0
$ wrangler containers list | grep -c keel-spike       → 0
GET /accounts/<acct>/workers/scripts                  → 246 scripts, none matching keel-spike
```

**Artifacts namespaces.** Seven empty namespaces were left, because wrangler has no namespace delete. They were deleted with the REST route `DELETE /accounts/<acct>/artifacts/namespaces/<ns>`, which is not in the REST docs:

```
keel-spike-01 DELETE=204 GET-after=404
keel-spike-02 DELETE=204 GET-after=404
keel-spike-03 DELETE=204 GET-after=404
keel-spike-04 DELETE=204 GET-after=404
keel-spike-06 DELETE=204 GET-after=404
keel-spike-12 DELETE=204 GET-after=404
keel-spike-15 DELETE=204 GET-after=404
```

S13 had already deleted its own three namespaces (`keel-spike-13`, `-13-eu` and `-13-w`) the same way.

**Known remainder:** S4's container snapshot. Its registry tag (`rootfs-snapshot-*`) was deleted, but snapshots carry a 30-day TTL. Whether deleting the tag frees the stored data straight away is untested, so the data may persist until the TTL expires.
