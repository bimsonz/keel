### Fixed

- **An object that could not take a call just now answers 503 with a wait, not 500.** When the platform refuses a call because a Durable Object is overloaded, or because it restarted under the call for a deploy, the request now answers `503 service.unavailable` with `Retry-After` and `retryAfterMs`, so the caller sends it again on the same Idempotency-Key. Keel reads this from the platform's own marks on the error, or from its sentence once the error has crossed an object's RPC. Every other defect still answers `500 internal.defect` with its incident id.
