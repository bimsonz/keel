### Fixed

- **A reading whose re-exports star each other in cycles finishes** (no route, event or migration). `factsOf` followed an `export *` once for every path through the cycles, down to its depth cap, so a few barrel files that re-export each other cost millions of lookups: one tree asked 50 million kinds and took 21 s for a name no file exports. Each export is now resolved once for each depth it is asked at, and the facts are the same.
