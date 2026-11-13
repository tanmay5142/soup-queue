# How I used AI on this task

I used Claude throughout this task, mainly to plan the design, generate
first drafts of the code and the chaos test, and to help debug problems as
they came up. Below is what I asked for, what I kept, what I changed, and
what I checked myself.

## Design
I asked for help structuring the design around the 4 questions the task
asks about (claiming, dead-worker detection, cancel handling, and the
execution guarantee). I accepted the overall approach (lease-based claiming
with SKIP LOCKED, an attempt counter, a reaper loop) but wrote the final
explanation in my own words, since I needed to be able to defend it in the
live discussion.

## Code
I used AI-generated starting points for the database schema, the API
endpoints, and the worker logic. I reviewed every file and tested each one
manually before moving to the next step (for example, testing each API
endpoint's status codes by hand in PowerShell before building the workers).

## Debugging I did myself
- When the chaos harness failed with a password error, I diagnosed it
  myself: I confirmed the database inside the container was fine, then
  found that another Postgres instance on my machine from a different
  project was conflicting on the same port. I fixed it by moving this
  project to a different host port.
- I deliberately broke the code myself (removed the attempt check from the
  finish query) to confirm the chaos test could actually detect a real bug,
  rather than trusting a passing test blindly. I verified the test failed
  with the bug in place, then passed again once I put the fix back.
- I ran the clock-skew test myself using faketime on one worker container,
  and checked that jobs still completed correctly, confirming that the
  design doesn't depend on any worker's local clock.
- When one chaos run at a smaller job count failed to finish in time, I
  investigated the cause myself (checking Docker restart behavior) rather
  than just re-running it until it passed.

## What I verified rather than trusted
I did not accept any correctness claim without running a test for it. Every
invariant in the design note is backed by either a chaos test run or a
targeted smaller test (the concurrent-claim test, the clock-skew test).
Where I was not able to fully confirm something (the exact cause of the
slow-drain run), I said so honestly in the write-up instead of stating it
as fact.