### Fixed

- **A change not yet landed has a diff again**, over the API, MCP and the console's Files changed tab. The HTTP isolate's CodeHost served only the core namespace, so reading a change's workspace in `keel-ws-00` threw "no Artifacts binding serves namespace keel-ws-00" and answered 500 `internal.defect`. Every CodeHost now takes the one map of namespaces, `artifactsNamespaces(env)` in `composition/do.ts`.
