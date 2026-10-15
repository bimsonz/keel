### Changed

- **An id is read in either case at the API and the MCP door.** A ULID is Crockford base32, which reads the same upper-case or lower-case, and an agent that copied `prj_nx568p…` from a workspace's address was refused it. Each path segment, query value and JSON body string that is wholly an id (`prj_`, `chg_`, `agt_`, `lse_` and the rest) is now written upper-case before any route or validator sees it. Answers, events and the published patterns keep ids upper-case; a string that only holds an id among other text is left as it was.
