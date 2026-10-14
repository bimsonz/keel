# Keel is a platform agents use, not an agent platform

Keel never spawns, schedules, hosts or prompts agents, and never holds their model keys.

Inside Keel, models appear only as **platform functions**. These are single-shot calls with schema-constrained output, made through the `DecisionModel` and `PlatformFunction` ports. They run no loops and use no tools.

The one bounded exception is probe drafting: at most three repair attempts, driven by deterministic error text.

The example swarm lives in `examples/` and is a plain client of the public API. Architecture rule R10 enforces the boundary.

Why: Keel is a place where many agents *collaborate on changes*. Hosting agents would make Keel a runtime that competes with the harnesses it should serve. It would also blur the trust boundary that verification depends on: the author of a change must never control the thing judging it.

## Considered options

- **Host the agents (Agents SDK coders inside Keel).** Rejected. It turns Keel into an agent runtime and couples verification to authorship.
- **Code Mode composing the verification funnel.** Rejected. A model would then decide what gets verified.
