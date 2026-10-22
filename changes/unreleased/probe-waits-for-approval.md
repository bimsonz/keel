### Fixed

- **A probe waits for a proposal's approval as long as a maintainer may take.** A conflict's probe waited a day in all for its parties' submissions, and a proposal is no world until a maintainer approves its commit, so a proposal approved more than a day after the suspicion left the conflict unproven for good. A probe now waits up to 30 days for a proposal's approval (`PROBE_APPROVAL_WAIT_MS`), and once it is approved waits for any submission it still owes a day from then. The Change object's answer to a waiting probe says when it waits for an approval (`forApproval`).
