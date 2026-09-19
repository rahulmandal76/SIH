// Canonical One-Time Migration Script: Flat db.json -> Relational Database
// Unified Healthcare Intelligence Platform: MedSync + AuraHealth Nexus

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { prisma, disconnectPrisma } from "../prisma/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_JSON_PATH = path.resolve(__dirname, "..", "Patient-case-taking-software-", "server", "db.json");

export async function runMigration() {
  console.log("==================================================");
  console.log("PHASE 2: CANONICAL db.json DATABASE MIGRATION");
  console.log("==================================================");

  if (!fs.existsSync(DB_JSON_PATH)) {
    throw new Error(`Legacy db.json not found at: ${DB_JSON_PATH}`);
  }

  const rawData = fs.readFileSync(DB_JSON_PATH, "utf-8");
  const fileHash = crypto.createHash("sha256").update(rawData).digest("hex");
  console.log(`Source db.json SHA-256 Checksum: ${fileHash}`);

  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch (err) {
    throw new Error(`Invalid JSON in legacy db.json: ${err.message}`);
  }

  const legacyPatients = parsed.patients || [];
  console.log(`Found ${legacyPatients.length} legacy patient entries in db.json.`);

  const report = {
    sourceFile: DB_JSON_PATH,
    sourceHash: fileHash,
    recordsRead: legacyPatients.length,
    usersCreated: 0,
    patientsCreated: 0,
    patientsExisting: 0,
    encountersCreated: 0,
    encountersExisting: 0,
    documentsCreated: 0,
    syntheticPatientCreated: false,
    errors: []
  };

  // 1. Seed Default Doctor User (Dr. K. S. Sharma)
  console.log("\n[Step 1] Seeding default clinical doctor...");
  const defaultDoctorEmail = "dr.sharma@hospital.gov.in";
  let doctorUser = await prisma.user.findUnique({
    where: { email: defaultDoctorEmail }
  });

  if (!doctorUser) {
    doctorUser = await prisma.user.create({
      data: {
        userUid: "00000000-0000-0000-0000-000000000002",
        name: "Dr. K. S. Sharma",
        email: defaultDoctorEmail,
        role: "doctor",
        chamber: "OPD Chamber #04 - General Medicine",
        active: true
      }
    });
    report.usersCreated++;
    console.log(`-> Created Doctor user: ${doctorUser.name} (${doctorUser.email})`);
  } else {
    console.log(`-> Doctor user already exists: ${doctorUser.name}`);
  }

  // 2. Seed Synthetic Patient SYN-PAT-001 (Arjun Mehta)
  console.log("\n[Step 2] Seeding canonical synthetic patient (SYN-PAT-001)...");
  const syntheticUid = "00000000-0000-0000-0000-000000000001";
  let syntheticPatient = await prisma.patient.findUnique({
    where: { patientUid: syntheticUid }
  });

  if (!syntheticPatient) {
    syntheticPatient = await prisma.patient.create({
      data: {
        patientUid: syntheticUid,
        patientId: "SYN-PAT-001",
        fullName: "Arjun Mehta",
        age: 45,
        gender: "Male",
        abhaNumber: "91-1123-8822-7711",
        abhaAddress: "arjun.mehta@abdm",
        abhaVerified: true
      }
    });
    report.patientsCreated++;
    report.syntheticPatientCreated = true;
    console.log(`-> Created Synthetic Patient: ${syntheticPatient.fullName} (${syntheticPatient.patientId}) [UID: ${syntheticPatient.patientUid}]`);
  } else {
    console.log(`-> Synthetic Patient already exists: ${syntheticPatient.fullName} (${syntheticPatient.patientId})`);
  }

  // 3. Identity Grouping & Deduplication for Legacy Patients
  console.log("\n[Step 3] Resolving and migrating legacy patient identities...");
  const patientGroups = new Map();

  for (const item of legacyPatients) {
    // Determine unique patient key:
    // If ABHA is unique (not placeholder 91-1123-8822-7711), use ABHA.
    // Otherwise use Name + Gender + Age as the distinct identity key.
    const isPlaceholderAbha = !item.abhaId || item.abhaId === "91-1123-8822-7711";
    let key;
    if (!isPlaceholderAbha) {
      key = `ABHA:${item.abhaId.trim()}`;
    } else {
      key = `NAME:${(item.name || "Unknown").trim().toLowerCase()}_${item.gender || "Unknown"}_${item.age || 0}`;
    }

    if (!patientGroups.has(key)) {
      patientGroups.set(key, {
        name: (item.name || "Unknown").trim(),
        age: item.age ? Number(item.age) : null,
        gender: item.gender || null,
        mobileNumber: item.phone || item.mobileNumber || null,
        abhaNumber: item.abhaId || null,
        items: []
      });
    }
    patientGroups.get(key).items.push(item);
  }

  console.log(`-> Identified ${patientGroups.size} distinct patient identities across ${legacyPatients.length} queue records.`);

  // 4. Create or Resolve Canonical Patients
  let patientSeq = 1;
  const resolvedPatients = new Map(); // key -> patient record

  for (const [key, group] of patientGroups.entries()) {
    // Check if patient already exists by ABHA or Name
    let existingPatient = null;
    if (group.abhaNumber && group.abhaNumber !== "91-1123-8822-7711") {
      existingPatient = await prisma.patient.findFirst({
        where: { abhaNumber: group.abhaNumber }
      });
    }
    if (!existingPatient) {
      existingPatient = await prisma.patient.findFirst({
        where: { fullName: group.name, age: group.age }
      });
    }

    if (existingPatient) {
      resolvedPatients.set(key, existingPatient);
      report.patientsExisting++;
      console.log(`  Existing patient found: ${existingPatient.fullName} (${existingPatient.patientId}) -> UID: ${existingPatient.patientUid}`);
    } else {
      const generatedId = `PAT-2026-${String(patientSeq++).padStart(4, "0")}`;
      const newPatient = await prisma.patient.create({
        data: {
          patientUid: crypto.randomUUID(),
          patientId: generatedId,
          fullName: group.name,
          age: group.age,
          gender: group.gender,
          mobileNumber: group.mobileNumber,
          abhaNumber: group.abhaNumber,
          abhaAddress: null,
          abhaVerified: false
        }
      });
      resolvedPatients.set(key, newPatient);
      report.patientsCreated++;
      console.log(`  Created patient: ${newPatient.fullName} (${newPatient.patientId}) -> UID: ${newPatient.patientUid}`);
    }
  }

  // 5. Migrate Encounters
  console.log("\n[Step 4] Migrating legacy queue records as relational Encounters...");
  for (const item of legacyPatients) {
    const isPlaceholderAbha = !item.abhaId || item.abhaId === "91-1123-8822-7711";
    let key;
    if (!isPlaceholderAbha) {
      key = `ABHA:${item.abhaId.trim()}`;
    } else {
      key = `NAME:${(item.name || "Unknown").trim().toLowerCase()}_${item.gender || "Unknown"}_${item.age || 0}`;
    }

    const patient = resolvedPatients.get(key);
    if (!patient) {
      console.error(`  Warning: Could not resolve patient for token #${item.token}`);
      report.errors.push(`Missing patient mapping for token ${item.token}`);
      continue;
    }

    const tokenStr = String(item.token);
    const existingEncounter = await prisma.encounter.findFirst({
      where: { tokenNumber: tokenStr }
    });

    if (existingEncounter) {
      report.encountersExisting++;
      console.log(`  Encounter for Token #${tokenStr} already exists (ID: ${existingEncounter.encounterId}) - Skipped.`);
      continue;
    }

    const isCompleted = item.consultationStatus === "completed" || item.status === "completed";
    const encounterId = `ENC-2026-${tokenStr.padStart(4, "0")}`;

    const newEncounter = await prisma.encounter.create({
      data: {
        encounterId,
        patientUid: patient.patientUid,
        tokenNumber: tokenStr,
        priority: item.priority || "Normal",
        triageReason: item.triageReason || null,
        consultationStatus: isCompleted ? "completed" : (item.consultationStatus || "waiting"),
        chiefComplaint: item.chiefComplaint || null,
        hpi: item.caseData?.hpi || null,
        pastHistory: item.caseData?.pastHistory || null,
        currentMedsJson: item.caseData?.currentMeds ? JSON.stringify(item.caseData.currentMeds) : null,
        allergiesJson: item.caseData?.allergies ? JSON.stringify(item.caseData.allergies) : null,
        doctorNotes: item.doctorNotes || null,
        intakeConversation: item.conversation ? JSON.stringify(item.conversation) : null,
        provenance: "LEGACY_DB_JSON",
        createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
        completedAt: isCompleted && item.completedAt ? new Date(item.completedAt) : null
      }
    });

    report.encountersCreated++;
    console.log(`  Created Encounter ${newEncounter.encounterId} for Token #${tokenStr} -> Patient: ${patient.fullName} (${patient.patientId})`);

    // 6. Migrate attached reports if present
    const extractedReports = item.caseData?.extractedReports || [];
    for (const rep of extractedReports) {
      const docId = `DOC-LEGACY-${tokenStr}-${rep.id}`;
      const existingDoc = await prisma.document.findUnique({
        where: { documentId: docId }
      });
      if (!existingDoc) {
        const doc = await prisma.document.create({
          data: {
            documentId: docId,
            patientUid: patient.patientUid,
            encounterId: newEncounter.encounterId,
            fileName: `${rep.type} (${rep.date || "Unknown"})`,
            filePath: `legacy_archive/${docId}.txt`,
            fileSize: 1024,
            mimeType: "text/plain",
            documentType: (rep.type || "other").toLowerCase().replace(/\s+/g, "_"),
            totalPages: 1,
            uploadDate: new Date(),
            status: "ready",
            provenance: "LEGACY_REPORT"
          }
        });

        await prisma.documentPage.create({
          data: {
            documentId: doc.documentId,
            pageNumber: 1,
            extractedText: `Type: ${rep.type}\nTest/Results: ${rep.test}\nDate: ${rep.date}\nSource: ${rep.source}\nStatus: ${rep.status}`,
            ocrStatus: "native_text",
            ocrConfidence: 1.0
          }
        });
        report.documentsCreated++;
      }
    }
  }

  // 7. Audit Log Entry for Migration
  await prisma.auditLog.create({
    data: {
      patientUid: null,
      actorUserId: doctorUser.id,
      actorType: "system",
      action: "MIGRATION_DB_JSON",
      resourceType: "database",
      resourceId: "db.json",
      metadataJson: JSON.stringify({
        recordsRead: report.recordsRead,
        patientsCreated: report.patientsCreated,
        encountersCreated: report.encountersCreated,
        sourceChecksum: fileHash
      })
    }
  });

  console.log("\n==================================================");
  console.log("MIGRATION COMPLETED SUCCESSFULLY");
  console.log("==================================================");
  console.log(`Records read:              ${report.recordsRead}`);
  console.log(`Users created:             ${report.usersCreated}`);
  console.log(`Patients created:          ${report.patientsCreated}`);
  console.log(`Patients existing:         ${report.patientsExisting}`);
  console.log(`Encounters created:        ${report.encountersCreated}`);
  console.log(`Encounters existing:       ${report.encountersExisting}`);
  console.log(`Documents created:         ${report.documentsCreated}`);
  console.log(`Synthetic patient seeded:  ${report.syntheticPatientCreated}`);
  console.log(`Errors:                    ${report.errors.length}`);
  console.log("==================================================\n");

  return report;
}

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigration()
    .then(async (report) => {
      await disconnectPrisma();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("Migration failed:", err);
      await disconnectPrisma();
      process.exit(1);
    });
}
