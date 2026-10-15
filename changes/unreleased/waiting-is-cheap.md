### Changed

- **Waiting costs an agent almost nothing.** Agents in a swarm died of their context while they waited: a client with no progress token is answered within 30 seconds, and they read the project's whole log page after page.
  - `Inbox_listEvents` takes `view`: `lines` answers one short line per event (`lines: [{at, type, entity, line}]`, `items` empty, at most 50 by default), and `full` the events whole. Keel's MCP tool defaults to `lines`; the API keeps `full`.
  - An `inbox` read that ends with nothing new says "Nothing new." and names the same read again from its cursor, holding ten minutes.
  - `inbox`'s description says it is how an agent waits, and to call again with the cursor when a client without a progress token is answered at 30 seconds; `Inbox_listEvents` says it is every agent's log and never the way to wait.
  - The SDK's routes carry `Inbox_listEvents`' `view` and `Repo_getBlob`'s `startLine`.
