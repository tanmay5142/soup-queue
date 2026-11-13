import os from "os";
import crypto from "crypto";
import pg from "pg";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://queue:queue@localhost:5432/queue",
  max: 3,
});

// New id every time the process starts, so a restarted worker is a NEW worker.
const WORKER_ID = `${os.hostname()}-${crypto.randomBytes(3).toString("hex")}`;
const LEASE_SECONDS = Number(process.env.LEASE_SECONDS || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), WORKER_ID, ...a);

// 1. CLAIM: take one waiting job, start its timer, write a diary line.
//    All in ONE statement, so it is all-or-nothing.
//    SKIP LOCKED = if another worker is grabbing a job right now, skip it.
async function claim() {
  const r = await pool.query(
    `WITH next AS (
       SELECT id FROM jobs
       WHERE status = 'queued'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ),
     claimed AS (
       UPDATE jobs j
       SET status = 'running',
           attempt = j.attempt + 1,
           worker_id = $1,
           lease_expires_at = now() + make_interval(secs => $2::double precision),
           updated_at = now()
       FROM next
       WHERE j.id = next.id
       RETURNING j.*
     ),
     logged AS (
       INSERT INTO run_log (job_id, attempt, worker_id)
       SELECT id, attempt, worker_id FROM claimed
     )
     SELECT * FROM claimed`,
    [WORKER_ID, LEASE_SECONDS]
  );
  return r.rows[0] || null;
}

// 2. WORK: small steps. After each step: renew the timer and check for cancel.
//    The WHERE clause checks "is this job still mine?"
async function runJob(job) {
  for (let i = 0; i < 5; i++) {
    await sleep(40 + Math.random() * 60);
    const hb = await pool.query(
      `UPDATE jobs
       SET lease_expires_at = now() + make_interval(secs => $4::double precision),
           updated_at = now()
       WHERE id = $1 AND attempt = $2 AND worker_id = $3 AND status = 'running'
       RETURNING cancel_requested`,
      [job.id, job.attempt, WORKER_ID, LEASE_SECONDS]
    );
    if (hb.rowCount === 0) return "lost"; // job is no longer mine: stop at once
    if (hb.rows[0].cancel_requested) return "cancelled";
  }
  return job.payload && job.payload.fail === true ? "failed" : "succeeded";
}

// 3. FINISH: one guarded action. The result and the side effect are saved
//    in the same transaction, or not at all.
async function finish(job, outcome) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `UPDATE jobs
       SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE $4::text END,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1 AND attempt = $2 AND worker_id = $3 AND status = 'running'
       RETURNING status`,
      [job.id, job.attempt, WORKER_ID, outcome]
    );
    if (r.rowCount === 0) {
      await c.query("ROLLBACK"); // zombie: job was taken from me. Do nothing.
      return "lost";
    }
    if (r.rows[0].status === "succeeded") {
      // The "side effect". job_id is the primary key, so a second one
      // for the same job would throw an error (and we would see it).
      await c.query(
        `INSERT INTO job_effects (job_id, attempt, worker_id) VALUES ($1, $2, $3)`,
        [job.id, job.attempt, WORKER_ID]
      );
    }
    await c.query("COMMIT");
    return r.rows[0].status;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// 4. REAPER: jobs whose timer ran out go back in the line
//    (or become cancelled, if someone asked to cancel them).
//    Uses the database clock (now()), not this computer's clock.
async function reap() {
  const r = await pool.query(
    `UPDATE jobs
     SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END,
         worker_id = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE status = 'running' AND lease_expires_at < now()
     RETURNING id, status`
  );
  if (r.rowCount > 0) {
    log("reaper recovered", r.rows.map((x) => `${x.id}->${x.status}`).join(","));
  }
}

async function reaperLoop() {
  while (true) {
    try {
      await reap();
    } catch (e) {
      log("reaper error", e.message);
    }
    await sleep(2000);
  }
}

async function workLoop() {
  while (true) {
    try {
      const job = await claim();
      if (!job) {
        await sleep(150 + Math.random() * 100); // nothing to do, rest a bit
        continue;
      }
      const outcome = await runJob(job);
      if (outcome === "lost") {
        log("lost job", job.id, "attempt", job.attempt, "- stopped");
        continue;
      }
      const final = await finish(job, outcome);
      if (final === "lost") {
        log("finish rejected for job", job.id, "attempt", job.attempt);
      }
    } catch (e) {
      log("error", e.message);
      await sleep(500); // e.g. database restarting. Wait and try again.
    }
  }
}

log("started");
reaperLoop();
workLoop();