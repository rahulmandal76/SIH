import { defineConfig } from "@prisma/config";

export default defineConfig({
  schema: process.env.PRISMA_SCHEMA || "prisma/schema.sqlite.prisma",
  datasource: {
    url: process.env.DATABASE_URL || "file:./prisma/dev.db"
  }
});
