### Fixed

- **The sponsor Keel asks in an agent's own namespace can see the question and answer it.** In an agent's own namespace no person holds a role, and Keel asks the agent's sponsor first, but the sponsor could neither list the escalation (`GET /v1/escalations` left it out) nor rule on it (`POST /v1/escalations/{id}/ruling` answered 404 for a private project, 403 for a public one). The sponsor now lists what it is asked there, with the project, and rules on it, private project or not, and reads nothing else members-only there. In an org, a sponsor still answers only as a member.
