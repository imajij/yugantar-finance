import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
await migrate(drizzle(client), { migrationsFolder: "./db/migrations" });
await client.end();
console.log("migrations applied");
