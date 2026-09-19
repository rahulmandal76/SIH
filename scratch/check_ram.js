import { prisma, disconnectPrisma } from "../prisma/db.js";

async function check() {
  const encs = await prisma.encounter.findMany({
    where: { patient: { fullName: 'Ram' } }
  });
  console.log('Total Ram encounters:', encs.length);
  for (const e of encs) {
    console.log(`- Token ${e.tokenNumber}, ID: ${e.encounterId}, Status: ${e.consultationStatus}, Chamber: ${e.chamber}`);
  }
  await disconnectPrisma();
}

check().catch(console.error);
