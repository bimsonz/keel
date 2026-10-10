# Workflow doorways

Precheck (one instance per change revision) and KeelVerify (one per batch) enter the hexagon here. Each `run()` builds its runtime from `this.env` (see `src/composition`), retries are configured on steps, and ids, time and randomness come only from inside steps. KeelVerify's shape waits on spike S15.
