import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// ponytail: one module-level pool. Serverless-safe because postgres-js lazily connects;
// swap for @neondatabase/serverless if connection counts ever bite.
const client = postgres(process.env.DATABASE_URL!, { max: 5, prepare: false });

export const db = drizzle(client, { schema, casing: "snake_case" });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };
