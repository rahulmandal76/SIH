import { defineConfig } from "@prisma/config";
import dotenv from "dotenv";
dotenv.config();

export default defineConfig({
  schema: process.env.DATABASE_PROVIDER === "postgresql" ? "prisma/schema.prisma" : (process.env.PRISMA_SCHEMA || "prisma/schema.sqlite.prisma"),
  datasource: {
    url: process.env.DATABASE_URL || "file:./prisma/dev.db"
  }
});
