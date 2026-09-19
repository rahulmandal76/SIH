// Canonical Prisma Client Database Provider
// Unified Healthcare Intelligence Platform: MedSync + AuraHealth Nexus

import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let prismaInstance = null;

export function getPrisma() {
  if (prismaInstance) return prismaInstance;

  const provider = process.env.DATABASE_PROVIDER || "sqlite";

  if (provider === "postgresql") {
    // In production with PostgreSQL:
    // const { PrismaPg } = await import("@prisma/adapter-pg");
    // const pg = (await import("pg")).default;
    // const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // const adapter = new PrismaPg(pool);
    // prismaInstance = new PrismaClient({ adapter });
    throw new Error("PostgreSQL runtime requires active DATABASE_URL and pool connection.");
  }

  // SQLite (Local Development)
  const dbPath = process.env.SQLITE_DB_PATH || path.resolve(__dirname, "dev.db");
  const adapter = new PrismaBetterSqlite3({ url: `file:${dbPath}` });
  prismaInstance = new PrismaClient({ adapter });
  return prismaInstance;
}

export const prisma = getPrisma();

export async function disconnectPrisma() {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
}

export default prisma;
