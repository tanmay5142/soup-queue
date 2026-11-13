import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://queue:queue@localhost:5432/queue",
  max: 20,
});