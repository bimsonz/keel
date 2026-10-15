### Fixed

- **The SDK sends a long poll again when its connection drops.** A read with a `wait` (`status`, `inbox`, `events`) whose `fetch` failed (a deploy, a reset socket) ended the caller's wait with `TypeError: fetch failed`. It is now sent again after 1 s, doubling to 30 s, until its own wait is up; `keeltown status --wait` and `keeltown inbox --wait` ride through a deploy. Any other call, any answer, and an aborted call are as before.
