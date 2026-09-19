const { PrismaClient } = require('@prisma/client');
const { PrismaLibSql } = require('@prisma/adapter-better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../../prisma/dev.db');
const adapter = new PrismaLibSql({ url: `file:${dbPath.replace(/\\/g, '/')}` });
const prisma = new PrismaClient({ adapter });

async function check() {
  const encs = await prisma.encounter.findMany({
    where: { patient: { fullName: 'Ram' } }
  });
  console.log('Total Ram encounters:', encs.length);
  for (const e of encs) {
    console.log(`- Token ${e.tokenNumber}, ID: ${e.encounterId}, Status: ${e.consultationStatus}, Chamber: ${e.chamber}`);
  }
  await prisma.$disconnect();
}

check().catch(console.error);
