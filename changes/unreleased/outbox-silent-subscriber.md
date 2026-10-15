### Fixed

- **A subscriber that never answers no longer holds an object's other deliveries.** Each delivery an outbox flush makes is bounded (`DELIVERY_BOUND_MS`, 30 seconds): past it the delivery counts as failed and waits for its retry with the usual backoff, and every delivery is acknowledged as soon as its subscriber takes it, rather than once the whole flush is done. Before, one subscriber that hung held every other subscriber's acknowledgements and the object's alarm until the platform ended it.
- **A credential's key is never awaited across requests.** The Worker keeps the credential KEK once a read of it has been imported; until then each request reads it for itself, so a read dropped with the request that started it cannot hold every later seal or open on the isolate.
