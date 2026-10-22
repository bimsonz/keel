### Changed (breaking)

- **A project settings PUT keeps every field it leaves out.** `PUT /v1/projects/{projectId}/settings` used to read an absent `verification` as `required`, an absent `visibility` as `private` and an absent `proposals` as `open`, so a client that did not send a field reset it: a PUT without `proposals` reopened a project's proposals. A field the body leaves out now keeps what is stored. To change `verification`, `visibility` or `proposals`, send it. A replay under the same request id answers the settings as they stand, whatever moved since.
