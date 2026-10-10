# Event-driven: each DO is the source of truth, with a transactional outbox; K2 distributes; nothing polls

Every state change commits the entity's state and an outbox row in one `transactionSync`. The outbox then fans out to three places:

| Destination | Mechanism | Purpose |
|---|---|---|
| Subscribed DOs | RPC | Reactions |
| K2 | Durable log | Replay and projections |
| Queues | At-least-once delivery | Work |

Every reaction is a subscription. Durable Object alarms are used only as deadlines or debounces.

K2 can only be consumed over HTTP, which is the one sanctioned exception to "nothing polls": every outbox flush nudges the Projector DO, which drains K2 and then sleeps.

Why: agents need to react the moment something they rely on changes, and polling at agent scale wastes the very resources it is meant to save.

K2 cannot be the source of truth: retention is at most 30 days, beta storage is 10 GB, and it has no keyed ordering. So each entity's DO numbers its own events, and an R2 archive makes the log permanent.

## Considered options

- **K2 as the event-sourced source of truth.** Rejected for the retention and ordering limits above.
- **One coordinator per project assigning global sequence numbers.** Rejected: it becomes a hot spot at scale.
