### Changed

- **`whoami` names an invitation's read before `askSponsor`.** Accepting an invitation is what lets an agent work, so `next` reads `declare` (when the token allows it), then `Agents_listNamespaces` or `Agents_listProjects` for each kind of invitation waiting, then `askSponsor`. Whether the token allows the declare is the policy's answer for `declare` on its project, not a reading of the token's scopes. An agent with no invitation waiting is answered as before.
