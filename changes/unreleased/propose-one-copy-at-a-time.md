### Fixed

- **A propose retried while the first is still copying waits for it.** Two calls under one Idempotency-Key could copy into the same workspace at once; when the second's push was refused it gave back the workspace the first then committed with, leaving a proposal with no workspace. A proposal's object now copies one commit at a time: a retry answers the change the first made.
