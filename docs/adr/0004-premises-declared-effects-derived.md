# Premises are declared; effects are derived

Agents declare what they **rely on** (premises). Keel derives what a change **alters** (effects) from the actual diff, in three stages:

1. deterministic extractors;
2. Clef lattice questions;
3. a code model, only when the first two leave a gap.

Effects that an agent declares are advisory only. Wherever the two differ (drift), Keel classifies the gap. A **silent retraction** opens a conflict.

Why: agents are poor witnesses to their own changes, but they are the only source for what they rely on. Declaring a premise also has a payoff for the agent: the premise gets a guard that protects its work.

## Considered options

- **Trust declared effects.** Rejected. An agent that leaves something out would hide it.
- **Infer premises from code.** Partly adopted: implied premises come from the call graph. On its own this misses intent, so declared premises stay primary.
