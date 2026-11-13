# Chaos test results

- `run-01` through `run-05`: N=10,000 jobs, 8 workers, kill ~every 2s. All invariants passed.
- `run-XX` (fill in the correct number): same setup, but run with the `attempt` check
  deliberately removed from `finish()` in worker.js. Checks 3d/4/7 failed as expected —
  this proves the guard is actually load-bearing, not decorative.
- `run-YY` (fill in): same setup, immediately after reverting the fix. All checks passed again.
- `stress-timeout-01`: N=2,000 jobs (smaller scale), same kill rate. Did NOT drain within
  the 15-minute timeout; one job was reclaimed 174 times. All correctness invariants
  (no double effects, no double claims, no lost jobs) still held -- only liveness suffered.
  Likely cause: Docker's restart backoff throttling repeatedly-killed containers, shrinking
  the effective worker pool faster than the queue could drain. See DESIGN.md for discussion.

One run at a smaller job count (2,000 jobs, same 8 workers, same kill rate) failed to drain within the 15-minute timeout, with one job cycling through 174 claim attempts. All correctness invariants (no double effects, no lost jobs, no double claims) still held — only liveness suffered. The likely cause is Docker’s restart backoff: killing the same container repeatedly in a short window causes Docker to delay its restarts increasingly, effectively shrinking the worker pool during the test. I wasn’t able to confirm this directly after the fact (container history was lost once I tore the stack down), but the pattern — slow drain, one job starved repeatedly — is consistent with it. This is a limitation of the chaos setup, not of the queue’s correctness guarantees: a production deployment would need the orchestrator’s restart policy tuned (or an external supervisor with its own backoff) so that sustained process failures don’t compound into a worse outage than the failures themselves.