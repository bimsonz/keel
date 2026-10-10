# Trunk promotion: one writer, a write-ahead log, and a read-back, without relying on Artifacts compare-and-swap

Trunk advances only through the Trunk DO. On each tick it does the following:

1. Writes a `PendingGroup {old, members, committerTime}` entry to its write-ahead log.
2. Composes the new commit deterministically, so a retry produces the same SHA.
3. Pushes `old → new`.
4. Reads the head back. If the head is `new`, the group is committed. If it is still `old`, the push is retried with the same SHA. If it is anything else, promotion freezes and a person is alerted.

If Artifacts' receive-pack turns out to enforce the old-SHA check (spike S1), that becomes a second fence. It is never the only one.

Why: nothing in the Artifacts documentation covers compare-and-swap for concurrent pushes, and Durable Object input gates don't cover outbound I/O. A single writer combined with a write-ahead log stays correct either way.
