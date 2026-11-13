# Design Note — Training Job Queue

## How a worker picks up a job

A job starts as "queued". A worker asks the database for one waiting job
using a single database command that does three things together: it picks
one queued job, marks it "running", and gives it a 5-second timer (called
a lease). Because this happens in one atomic step, two workers can never
end up with the same job. Postgres has a built-in way to say "if another
worker is already looking at a row, skip it and look at the next one"
(`FOR UPDATE SKIP LOCKED`), so workers never wait on each other or collide.

## How a dead worker is detected

While a worker works on a job, it keeps resetting that 5-second timer every
time it finishes a small step ("I'm still alive"). A separate background
loop (the "reaper") runs every 2 seconds and checks for any job whose timer
has run out while it was still marked "running". If it finds one, it
assumes the worker died and puts the job back in the queue so another
worker can pick it up.

Every time a job is picked up, a counter on it (called "attempt") goes up
by one. This counter is the key to catching a worker that is not really
dead, just slow — for example, one that froze for a while and then woke
up. If it wakes up and tries to save a result for a job it no longer owns
(because someone else already picked it up on a higher attempt number),
the database rejects the write, because the attempt number no longer
matches. The slow worker's result is silently thrown away instead of
corrupting the real result.

## What happens if a running job gets cancelled

Cancelling a queued job is simple: it's marked cancelled right away. Cancelling
a running job is trickier, because the worker might finish at almost the same
moment. The cancel request just sets a flag ("please stop") on the job. The
worker checks this flag between every small step of its work. If a cancel and
a finish happen to land at the exact same instant, the database's row locking
makes sure only one of them actually changes the row — they can never both
"win". In my design, a job that finishes with its cancel flag already set is
marked cancelled, not succeeded, even if the work itself completed.

## The guarantee I give

I give **at-least-once execution, with an exactly-once side effect**.

In plain words: a job might genuinely start running more than once (if its
worker dies partway through), but the actual recorded result is only ever
saved once. I can't promise a job only ever starts once, because a worker
can die at any moment and there's no way to know that for certain until its
timer runs out. But I can promise the result table never ends up with two
different results for the same job, because saving a result requires the
worker's attempt number to still be the current one, and the result table
itself only allows one row per job.

True "exactly-once execution" isn't possible here, or in any system like
this, because you cannot guarantee a worker won't die right after doing the
real work but before telling the database it's done. The best you can do is
make sure that even if the work runs twice, only one result counts.

## Why Postgres, not SQLite

Several workers write to the database at the same time, and they need to
safely "grab" a job without colliding. Postgres supports exactly that kind
of safe, simultaneous access out of the box (row-level locking, and the
`SKIP LOCKED` feature used in the claim query). SQLite only allows one
writer at a time for the whole database, which would make workers queue up
behind each other just to pick up work — a bad fit for 8 concurrent workers.