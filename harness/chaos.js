import pg from "pg";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const sh = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const N = Number(process.env.JOBS || 10000);
const API = process.env.API || "http://localhost:3000";
const DB_URL = process.env.DATABASE_URL || "postgres://queue:queue@localhost:5432/queue";
const KILL_EVERY_MS = 2000;
const DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

// ---------- results files (every run is saved, pass or fail) ----------
fs.mkdirSync("results", { recursive: true });
const label = N >= 10000 ? "run" : "smoke";
const num = fs.readdirSync("results").filter((f) => f.startsWith(label + "-") && f.endsWith(".log") && !f.endsWith("-workers.log")).length + 1;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const base = `results/${label}-${String(num).padStart(2, "0")}-${stamp}`;
const prefix = `${label}${num}`;
function log(...a) {
  const line = new Date().toISOString() + " " + a.join(" ");
  console.log(line);
  fs.appendFileSync(base + ".log", line + "\n");
}

const db = new pg.Pool({ connectionString: DB_URL, max: 4 });
let netErrors = 0;
let kills = 0;

// ---------- small HTTP helper (retries on network errors, like a real client) ----------
async function http(method, url, body) {
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => null);
      return { code: r.status, body: j };
    } catch (e) {
      netErrors++;
      await sleep(200 * (t + 1));
    }
  }
  return { code: 0, body: null };
}

// ---------- the killer ----------
const stop = { done: false };
async function killerLoop() {
  while (!stop.done) {
    await sleep(KILL_EVERY_MS * (0.75 + Math.random() * 0.5));
    if (stop.done) break;
    try {
      const { stdout } = await sh("docker", ["compose", "ps", "-q", "worker"]);
      const ids = stdout.split(/\r?\n/).filter(Boolean);
      if (ids.length === 0) continue;
      const id = ids[Math.floor(Math.random() * ids.length)];
      await sh("docker", ["kill", "-s", "KILL", id]);
      kills++;
      log(`KILL #${kills} worker container ${id.slice(0, 12)}`);
      // safety: if docker did not restart it by itself, start it again
      setTimeout(() => sh("docker", ["start", id]).catch(() => {}), 1500);
    } catch (e) {
      log("killer error:", e.message);
    }
  }
}

// ---------- submit jobs ----------
const records = new Map(); // key -> what happened to that key
const cancelTasks = [];

async function submitOne(i) {
  const key = `${prefix}-k${i}`;
  const payload = { n: i, fail: i % 50 === 0 }; // 2% of jobs are meant to fail
  const copies = Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 3) : 1;
  const rs = await Promise.all(
    Array.from({ length: copies }, () => http("POST", `${API}/jobs`, { idempotency_key: key, payload }))
  );
  const rec = {
    key,
    copies,
    codes: rs.map((r) => r.code),
    ids: [...new Set(rs.map((r) => r.body && r.body.id).filter((x) => x != null))],
    cancels: [],
  };
  records.set(key, rec);

  const id = rec.ids[0];
  if (id != null && Math.random() < 0.15) {
    cancelTasks.push(
      (async () => {
        await sleep(Math.random() * 3000);
        const times = Math.random() < 0.3 ? 2 : 1;
        for (let k = 0; k < times; k++) {
          const r = await http("POST", `${API}/jobs/${id}/cancel`);
          rec.cancels.push(r.code);
        }
      })()
    );
  }
}

async function snapshot() {
  const r = await db.query(
    `SELECT md5(string_agg(id::text||':'||status||':'||attempt::text, ',' ORDER BY id)) AS h,
            (SELECT count(*) FROM job_effects)::int AS effects
     FROM jobs`
  );
  return r.rows[0];
}

// ---------- main ----------
async function main() {
  log(`START ${label} #${num}: jobs=${N}, kill every ~${KILL_EVERY_MS}ms, API=${API}`);

  const { stdout } = await sh("docker", ["compose", "ps", "-q", "worker"]);
  const workerCount = stdout.split(/\r?\n/).filter(Boolean).length;
  log(`workers running at start: ${workerCount}`);
  if (workerCount < 8) log("WARNING: fewer than 8 workers are running (use run-chaos.ps1)");

  await db.query("TRUNCATE jobs, job_effects, run_log RESTART IDENTITY CASCADE");

  const t0 = Date.now();
  const killer = killerLoop();

  let next = 0;
  async function submitWorker() {
    while (true) {
      const i = next++;
      if (i >= N) return;
      await submitOne(i);
      if (i % 1000 === 0) log(`submitted ${i}/${N}`);
    }
  }
  await Promise.all(Array.from({ length: 50 }, submitWorker));
  await Promise.all(cancelTasks);
  log(`all submits and cancels sent after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // wait until nothing is queued or running
  let drainTimedOut = false;
  let lastLog = 0;
  const d0 = Date.now();
  while (true) {
    const r = await db.query(
      `SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS open, count(*)::int AS total FROM jobs`
    );
    if (r.rows[0].open === 0) break;
    if (Date.now() - d0 > DRAIN_TIMEOUT_MS) {
      drainTimedOut = true;
      log(`DRAIN TIMEOUT: ${r.rows[0].open} jobs still open`);
      break;
    }
    if (Date.now() - lastLog > 10000) {
      log(`waiting: ${r.rows[0].open} jobs still open`);
      lastLog = Date.now();
    }
    await sleep(2000);
  }
  stop.done = true;
  await killer;
  log(`finished after ${((Date.now() - t0) / 1000).toFixed(1)}s, kills=${kills}`);

  // quiet period: nothing should change anymore (catches late zombie writes)
  const before = await snapshot();
  await sleep(12000);
  const after = await snapshot();
  const stable = before.h === after.h && before.effects === after.effects;

  // ---------- invariants ----------
  const results = [];
  const check = (name, bad) => {
    results.push({ name, ok: bad.length === 0, count: bad.length, sample: bad.slice(0, 5) });
  };

  const jobs = (await db.query(`SELECT id::text AS id, idempotency_key AS key, status, attempt FROM jobs`)).rows;
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const finalById = new Map(jobs.map((j) => [j.id, j.status]));

  // 1. nothing lost, nothing extra
  const lost = [...records.keys()].filter((k) => !byKey.has(k));
  check("1. no job lost (every key has a job)", lost);
  check("1b. no extra jobs (rows == number of keys)", jobs.length === N ? [] : [`rows=${jobs.length} keys=${N}`]);

  // 2. duplicate POSTs
  const dupBad = [];
  for (const rec of records.values()) {
    const created = rec.codes.filter((c) => c === 201).length;
    const okRest = rec.codes.every((c) => c === 201 || c === 200);
    if (created !== 1 || !okRest || rec.ids.length !== 1) dupBad.push(`${rec.key} codes=${rec.codes} ids=${rec.ids}`);
  }
  check("2. duplicate POSTs: exactly one 201, same id for all", dupBad);

  // 3. effects
  const q = async (sql) => (await db.query(sql)).rows.map((r) => JSON.stringify(r));
  check("3. no job has more than one effect", await q(`SELECT job_id::text, count(*)::int FROM job_effects GROUP BY job_id HAVING count(*) > 1`));
  check("3b. every succeeded job has an effect", await q(`SELECT j.id::text FROM jobs j WHERE j.status='succeeded' AND NOT EXISTS (SELECT 1 FROM job_effects e WHERE e.job_id=j.id)`));
  check("3c. no effect for a job that is not succeeded", await q(`SELECT j.id::text, j.status FROM jobs j JOIN job_effects e ON e.job_id=j.id WHERE j.status <> 'succeeded'`));
  check("3d. effect belongs to the job's final attempt", await q(`SELECT j.id::text, j.attempt, e.attempt AS effect_attempt FROM jobs j JOIN job_effects e ON e.job_id=j.id WHERE e.attempt <> j.attempt`));

  // 4. stuck jobs
  check("4. no job stuck in queued or running", await q(`SELECT id::text, status FROM jobs WHERE status IN ('queued','running')`));
  if (drainTimedOut) check("4b. queue drained before timeout", ["drain timed out"]);

  // 5. final states are sensible
  check("5. only expected final states", jobs.filter((j) => !["succeeded", "failed", "cancelled"].includes(j.status)).map((j) => `${j.id}:${j.status}`));
  check("5b. outcome matches payload (fail flag)", await q(`SELECT id::text, status FROM jobs WHERE (status='succeeded' AND payload->>'fail'='true') OR (status='failed' AND coalesce(payload->>'fail','false')<>'true')`));

  // 6. cancel consistency
  const cancelBad = [];
  for (const rec of records.values()) {
    const id = rec.ids[0];
    const final = finalById.get(id);
    for (const c of rec.cancels) {
      if (![200, 202, 409].includes(c)) cancelBad.push(`${rec.key} odd cancel code ${c}`);
    }
    if (rec.cancels.some((c) => c === 200 || c === 202) && final !== "cancelled") {
      cancelBad.push(`${rec.key} cancel accepted (${rec.cancels}) but final=${final}`);
    }
  }
  check("6. an accepted cancel (200/202) always ends as cancelled", cancelBad);

  // 7. double claim detector: attempt counter must equal number of claim records
  check("7. attempt == number of claims in run_log (no double claim)", await q(`SELECT j.id::text, j.attempt, coalesce(r.c,0)::int AS claims FROM jobs j LEFT JOIN (SELECT job_id, count(*) c FROM run_log GROUP BY job_id) r ON r.job_id=j.id WHERE coalesce(r.c,0) <> j.attempt`));

  // 8. quiet after finishing
  check("8. nothing changed during the 12s quiet period", stable ? [] : [JSON.stringify({ before, after })]);

  // ---------- info numbers ----------
  const statusCounts = (await db.query(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status ORDER BY status`)).rows;
  const rerun = (await db.query(`SELECT count(*)::int AS n, coalesce(max(attempt),0)::int AS max_attempt FROM jobs WHERE attempt > 1`)).rows[0];
  const cancelCodes = {};
  for (const rec of records.values()) for (const c of rec.cancels) cancelCodes[c] = (cancelCodes[c] || 0) + 1;

  log("");
  log("=========== RESULTS ===========");
  for (const r of results) {
    log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  (${r.count} problems, e.g. ${r.sample.join(" | ")})`}`);
  }
  log("");
  log(`final states: ${statusCounts.map((s) => `${s.status}=${s.n}`).join(", ")}`);
  log(`workers killed: ${kills}`);
  log(`jobs that were started more than once (a worker died mid-job): ${rerun.n}, highest attempt: ${rerun.max_attempt}`);
  log(`cancel replies: ${JSON.stringify(cancelCodes)}`);
  log(`network errors seen by the harness: ${netErrors}`);
  if (rerun.n === 0) log("WARNING: no job was ever re-run, so the kills never hit a running job. This run proves little.");

  const failed = results.some((r) => !r.ok);
  log(failed ? "VERDICT: FAILED (see FAIL lines above; do not edit this file)" : "VERDICT: ALL CHECKS PASSED");

  fs.writeFileSync(base + ".json", JSON.stringify({ label, num, N, kills, netErrors, statusCounts, rerun, cancelCodes, results }, null, 2));

  // raw worker logs as extra evidence
  try {
    const { stdout: wl } = await sh("docker", ["compose", "logs", "worker", "--no-color"], { maxBuffer: 500 * 1024 * 1024 });
    fs.writeFileSync(base + "-workers.log", wl);
  } catch (e) {
    log("could not save worker logs:", e.message);
  }

  await db.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  log("HARNESS CRASHED:", e.stack || e.message);
  process.exit(2);
});