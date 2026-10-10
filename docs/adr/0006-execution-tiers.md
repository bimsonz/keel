# Execution tiers: pure git in DOs, throwaway isolates, containers only as the escape hatch

Work runs on the cheapest tier that can do it:

| Tier | What it is | Where it runs |
|---|---|---|
| 0 | GitCore: a clean-room git engine | Inside the Lane and Trunk DOs |
| 1 | Throwaway Dynamic Worker isolates (`globalOutbound: null`) and static tool Workers | `keel-verify`, which holds no credentials |
| 2 | Containers, via `@cloudflare/ci` runners and MergeBox | Containers |

Each step records which tier it ran on and why. An escalation to a higher tier is sticky and visible.

Why:
- Containers start in about 650 ms and are capped at 1,500 vCPU per account. If every verification ran in a container, that cap would be hit at around 17k agents.
- Isolates start in milliseconds and have no creation-rate limit.
- Most git integration work involves path-disjoint changes, and those need no merge engine at all.

Spikes S13, S14, S15 and S18 set the final split. Their fallbacks move work up a tier but never change the design.

## Consequences

- Untrusted code now runs in V8 isolates as well as container VMs. That is why `keel-verify` is a separate Worker holding nothing worth stealing.
- Options with no licence or no proof (just-bash, wasm-git, Computer) were turned into spikes, not rejected.
