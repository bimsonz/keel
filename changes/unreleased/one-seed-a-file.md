### Changed

- **Core's property tests draw one seed a file** (tests only; no route, event or contract). Every property in a file draws from one seed, fresh on each run unless `FC_SEED` pins it, so properties that play the same plans share them: the Change machine's 35 properties took 137 s unseeded and now take about 7. A failure prints its seed, and `FC_SEED=<seed>` replays the file.
