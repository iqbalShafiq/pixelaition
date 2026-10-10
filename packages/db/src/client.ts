import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDatabase(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not configured");
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDatabase>;
