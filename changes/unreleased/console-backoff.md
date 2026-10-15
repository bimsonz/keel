### Fixed

- The console asks Keel again more slowly while Keel is away. A read of the log, of its tail and of the reader's own feed that Keel answers 503 (or 429, or that drops on the way) is asked again no sooner than Keel's Retry-After, and otherwise after a wait that doubles from a second, with jitter, up to thirty. A project's page whose first read of its log meets a 503 still loads, and the home keeps following the reader's feed past one.
