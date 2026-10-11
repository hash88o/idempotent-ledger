import { readFile } from "node:fs/promises";

import pg from "pg";

const DEFAULT_POOL_SIZE = 20;

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://ledger:ledger@localhost:54329/ledger";

/** Open a pool on DATABASE_URL, which defaults to the docker-compose database. */
export function createPool(max = DEFAULT_POOL_SIZE): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max });
}

/** Apply sql/schema.sql. Every statement is IF NOT EXISTS, so this is safe on every start. */
export async function migrate(pool: pg.Pool): Promise<void> {
  const sql = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
}
