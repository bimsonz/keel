### Added

- **A person rules over MCP.** `Operator_listEscalations` and `Operator_giveRuling` are MCP tools. Signed in as themselves, a person lists the questions Keel puts to them, reads the change one is about with `diff`, and rules, the decision recorded as theirs; an agent's token is still refused a ruling (`users-only`). A person's connection is told it acts as a person, and an agent's is told as before.
- **`keeltown token` for a person.** With no agent's key on the profile, `token` prints the session of the person signed in, so `keeltown token --mcp --header` is the headers helper of an MCP client that acts as them. A profile that holds an agent's key still prints the agent's token.
