/**
 * Applies the migrations in `db/migrations`.
 *
 * Run by hand (`pnpm db:migrate`) and by the deploy (`pnpm vercel-build`), because
 * remembering to migrate production is not a plan: a deployment whose code selects a
 * column the database has not got yet fails on *every* authenticated request, and it
 * fails with a 500 that says nothing.
 *
 * Two things make it safe to run on every deploy:
 *
 *   - **An advisory lock.** Two builds finishing at once would otherwise race, and
 *     `drizzle`'s migrator does not lock. The second waits, sees the work already
 *     done, and applies nothing.
 *   - **Migrations are additive.** Nothing here drops a column or a table; the one
 *     destructive path in the repo is the seed's `--reset`, which refuses to run in
 *     production.
 */
import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/** Arbitrary but fixed: any two runners must pick the same number to serialise on. */
const LOCK_ID = 0x59_47_4d_49; // "YGMI"

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set — nothing to migrate against.");
  process.exit(1);
}

// `max: 1` because the advisory lock is held on a session, and a pool could hand the
// unlock to a different connection than the one holding it.
const client = postgres(url, { max: 1 });
const db = drizzle(client);

/** Where we are pointed, without the password, so a deploy log shows the target. */
function describe(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "the configured database";
  }
}

try {
  console.log(`migrating ${describe(url)}…`);
  await client`select pg_advisory_lock(${LOCK_ID})`;
  try {
    await migrate(db, { migrationsFolder: "./db/migrations" });
    console.log("migrations applied");
  } finally {
    await client`select pg_advisory_unlock(${LOCK_ID})`;
  }
} catch (error) {
  // Fail the deploy. Serving new code against an old schema is worse than not
  // deploying: it breaks every request that touches the missing column.
  console.error("\nMIGRATION FAILED — the deployment should not proceed.\n");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
