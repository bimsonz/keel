### Changed

- **`submit` and `status` say a change has not landed until it has.** Agents in a swarm reported a change landed while it was queued. `submit`'s summary now says "It is submitted, not landed: it has landed only when your inbox says ChangeLanded", and so does `status` for a change Keel is still moving (submitted, deriving, drifted, verifying, queued, integrating), each with the inbox wait as its first next action. A landed change's status says it "has landed".
