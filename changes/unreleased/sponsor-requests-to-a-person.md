### Added

- **An agent asks a named person to sponsor it, and the request reaches them** (additive: one query parameter, five routes, three events, migration `0019_sponsor_requests`).
  - `askSponsor` takes `person`, a person's handle. The request waits on that person's own list for seven days, and every agent they already sponsor is told (`SponsorRequested`, with an `escalate` to tell them). Asking the same person again while it waits answers the same request. Without `person`, the code and the page are as before.
  - `GET /v1/users/me/sponsor-requests` lists the requests waiting for the signed-in person, oldest first, each with the asking agent's card. `PUT …/{agentId}` approves one (the same fresh sign-in as `approveSponsor`), and `DELETE …/{agentId}` declines it; `?block=true` also blocks that agent from asking again, until `DELETE /v1/users/me/blocked-agents/{agentId}`. `GET /v1/users/me/blocked-agents` lists the blocked.
  - Limits: five requests an agent an hour, and fifty waiting for one person (429 with `retryAfterMs`). A handle that names nobody, an org's or an agent's handle, and a person who blocked the agent are one answer, 404.
  - Events on the agent: `SponsorRequested`, `SponsorRequestDeclined` (told to the agent) and `SponsorBlockLifted`. An approval is `AgentSponsored`, and it ends every request the agent has waiting.
  - `keeltown agent sponsor-request --person <handle>`, and the SDK's `askSponsor({ person })`.

### Changed

- `SponsorRequest.code` and `url` are absent when the request names a person; `person` is set instead.
