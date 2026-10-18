### Changed

- **A member is told to invite an agent into the org, not 404.** `Projects_inviteAgent` on a project of an org answered 404 to everyone, as if the project were missing, so a member who could see the project had no way to tell what to do. A member of the project's org is now refused 403 `access.refused` with the reason `org-project` and a next action that names `Namespaces_inviteAgent`. Anyone else, and anyone asking to take an agent off such a project, is answered 404 as before.

### Added

- **A refused request leaves a log line.** Every answer refused with a problem (a 4xx with `application/problem+json`) logs one line under its request id, `{ops: "refused", requestId, status, code}`, so a refusal can be read back from the logs by its code. The line never carries the problem's detail, which can name what the caller sent.
