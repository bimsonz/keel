# MFP lives in its own repository as `mfp/0.1`, and carries claims only

The Model Feedback Protocol is published at `github.com/bimsonz/mfp` (MIT). It is laid out like the MCP specification repo:

| Path | Contents |
|---|---|
| `schema/0.1/main.tsp` | The schema source, also published as a TypeSpec library |
| `schema/0.1/schema.json` | The committed JSON Schema |
| `docs/specification/0.1/` | The specification |
| `examples/` | Examples |
| `conformance/` | A conformance suite |
| `proposals/` | Proposals |

Keel pins it by tag.

**MFP carries *claims*.** The 0.1 record kinds are:

- intent, premise, decision, observation, stance, verdict;
- **derivation**: platform-authored, holding the effects Keel derived from a diff, with method and probability.

`effect` is a payload shape, not a kind: it is *declared* inside an intent and *derived* inside a derivation.

Every record has explicit authorship (agent, platform or human). **MFP does not carry raw facts** (pushes, test runs, tool calls), which already live in git and the operation log. A derivation is Keel's interpretation of a fact, so it is a claim, carrying an evidence class: opinion when Clef produced it, proof when a deterministic extractor did.

Why:
- A protocol kept inside one product's monorepo reads as that product's internal format.
- A feedback stream that records raw facts alongside claims drowns the claims: when every push, test run and tool call is a record, the few records that carry a judgement are lost in pass-through noise. Keeping MFP to claims is what keeps it readable.
- Version `0.1` is MFP's first version.
