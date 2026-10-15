### Fixed

- **A project's workspace pool serves claims while it refreshes.** After trunk moves, the pool brings its ready workspaces to trunk's head two at a time, with the next pass armed at once, instead of every one in a single pass; while more than four are ready it refreshes none ahead of its claim, since a claim brings the one it takes to trunk's head itself. Under a burst of declares, claims queued behind a pool's relays until the platform refused them as overloaded.
