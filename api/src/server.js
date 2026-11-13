import express from "express";
import { pool } from "./db.js";
import "express-async-errors";

const app = express();
app.use(express.json());

// 1. CREATE a job (safe to send twice with the same key)
app.post("/jobs", async (req, res) => {
  const { idempotency_key, payload = {} } = req.body || {};
  if (typeof idempotency_key !== "string" || idempotency_key.length === 0) {
    return res.status(400).json({ error: "idempotency_key is required" });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return res.status(400).json({ error: "payload must be a JSON object" });
  }

  const payloadJson = JSON.stringify(payload);

  // Try to insert. If the key already exists, do nothing.
  const inserted = await pool.query(
    `INSERT INTO jobs (idempotency_key, payload)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [idempotency_key, payloadJson]
  );
  if (inserted.rows.length === 1) {
    return res.status(201).json(inserted.rows[0]);
  }

  // Key already existed: return the old job.
  const existing = await pool.query(
    `SELECT *, (payload = $2::jsonb) AS same_payload
     FROM jobs WHERE idempotency_key = $1`,
    [idempotency_key, payloadJson]
  );
  const row = existing.rows[0];
  if (!row.same_payload) {
    return res
      .status(409)
      .json({ error: "this idempotency_key was used with a different payload" });
  }
  delete row.same_payload;
  return res.status(200).json(row);
});

// 2. GET one job
app.get("/jobs/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });

  const r = await pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(r.rows[0]);
});

// 3. LIST jobs with pagination (cursor = last id you saw)
app.get("/jobs", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const cursor = Number(req.query.cursor) || 0;
  const status = req.query.status;

  const params = [cursor, limit];
  let where = "id > $1";
  if (status) {
    params.push(status);
    where += " AND status = $3";
  }

  const r = await pool.query(
    `SELECT * FROM jobs WHERE ${where} ORDER BY id ASC LIMIT $2`,
    params
  );
  const next_cursor =
    r.rows.length === limit ? r.rows[r.rows.length - 1].id : null;
  res.json({ jobs: r.rows, next_cursor });
});

// 4. CANCEL a job
app.post("/jobs/:id/cancel", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });

  // One single database action, so there is no gap for a race.
  const r = await pool.query(
    `UPDATE jobs
     SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         cancel_requested = CASE WHEN status = 'running' THEN true ELSE cancel_requested END,
         updated_at = now()
     WHERE id = $1 AND status IN ('queued', 'running')
     RETURNING *`,
    [id]
  );

  if (r.rows.length === 1) {
    const job = r.rows[0];
    // queued -> cancelled right away (200). running -> asked to stop (202).
    return res.status(job.status === "cancelled" ? 200 : 202).json(job);
  }

  // Nothing changed: either missing, or already finished.
  const cur = await pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
  if (cur.rows.length === 0) return res.status(404).json({ error: "not found" });
  return res
    .status(409)
    .json({ error: "job already finished", job: cur.rows[0] });
});

// Catch errors so the server never crashes silently
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`api listening on ${port}`));