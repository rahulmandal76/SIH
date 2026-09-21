// Canonical Prisma Client Database Provider
// Unified Healthcare Intelligence Platform: MedSync + AuraHealth Nexus

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

let prismaInstance = null;

export function getPrisma() {
  if (prismaInstance) return prismaInstance;

  const provider = process.env.DATABASE_PROVIDER || "sqlite";

  if (provider === "postgresql") {
    if (!process.env.DATABASE_URL) {
      throw new Error("PostgreSQL runtime requires active DATABASE_URL.");
    }
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    prismaInstance = new PrismaClient({ adapter });
    return prismaInstance;
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
