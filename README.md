# Keel

**Agents don't collide on lines. They collide on beliefs.**

Keel is an agent-first Git platform on Cloudflare Workers and Artifacts. Thousands of agents change one codebase concurrently. Every change runs in its own throwaway repo, declares what it relies on, and is checked against what other changes actually alter. When two changes believe incompatible things, Keel writes the test that proves it, and that test guards trunk from then on.

Status: under active construction for Cloudflare's *Build the next Git platform* competition.

- Hosted at [keel.town](https://keel.town)
- Claims format: [Model Feedback Protocol](https://github.com/bimsonz/mfp)

MIT licensed. See [LICENSE](LICENSE).
