import { prisma, disconnectPrisma } from "../prisma/db.js";

async function cleanRam() {
  const ram = await prisma.patient.findFirst({ where: { fullName: 'Ram' } });
  if (!ram) return;
  const deleted = await prisma.encounter.deleteMany({
    where: {
      patientUid: ram.patientUid,
      tokenNumber: { notIn: ['113', '118', '119', '120'] }
    }
  });
  console.log('Cleaned extra encounters for Ram:', deleted.count);
  const remaining = await prisma.encounter.findMany({
    where: { patientUid: ram.patientUid }
  });
  console.log('Remaining Ram encounters:', remaining.map(e => e.tokenNumber));
  await disconnectPrisma();
}

cleanRam().catch(console.error);
