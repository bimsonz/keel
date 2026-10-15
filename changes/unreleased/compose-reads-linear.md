### Fixed

- **A large batch composes in GitCore in time linear in its members, not quadratic** (no route, event or migration). GitCore's `FallbackReader` tried staging and then every member's workspace in a fixed order for each object, waiting for each miss, so restacking member k cost k misses per object it read. On loadgen a batch of 16 took 145–173 s to compose (1 member 5 s, 6 members 31 s, 11 members 80 s). It now tries the reader that answered most recently first (move to front), so an object costs about one miss.
