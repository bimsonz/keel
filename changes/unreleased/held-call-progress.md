### Fixed

- **A held tool call at the MCP door says it is still waiting every 30 seconds.** `inbox`, `Inbox_listEvents` and `status` with a `wait` and a progress token sent one progress notice at the start and nothing more, and a client that drops a call silent for 325 seconds dropped a `wait: 600` before Keel answered it. They now send a progress notice every 30 seconds until they answer (`PROGRESS_EVERY_SECONDS`).
