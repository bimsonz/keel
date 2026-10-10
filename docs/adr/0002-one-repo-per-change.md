# One throwaway Artifacts repo per change; only Keel writes trunk

Each Change, and each Sketch, is worked in its own forked Artifacts repo. Agents get a short-lived write token for that repo only. Trunk lives in a separate core repo, and only the Trunk DO's composer ever holds a write token for it. That token is minted for each promotion group and lives for 60 s.

Why:
- Artifacts tokens are scoped per repo, not per ref, so a shared repo with one ref per change would let any agent overwrite any other agent's work.
- Cloudflare's own guidance is "one repo per unit of autonomous work".
- Removing trunk write access from agents is what makes the integration gate unbypassable.

## Considered options

- **Shared repo with a ref per change.** Rejected because tokens can't be scoped to a ref.
- **Agents push straight to trunk with server-side compare-and-swap.** Rejected because Artifacts documents no compare-and-swap, and it would make the gate optional.

## Consequences

Fork latency and fork concurrency become design inputs. A pre-forked pool hides them, and spike S2 sizes that pool.
