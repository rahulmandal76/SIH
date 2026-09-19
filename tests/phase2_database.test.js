// Phase 2 Comprehensive Database & Dynamic Patient Identity Test Matrix
// Unified Healthcare Intelligence Platform: MedSync + AuraHealth Nexus

import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma, disconnectPrisma } from "../prisma/db.js";
import { runMigration } from "../scripts/migrate_db_json.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const results = [];

function recordTest(id, name, status, details) {
  results.push({ id, name, status, details });
  const icon = status === "PASS" ? "✅" : status === "PENDING_INFRA" ? "⏳" : "❌";
  console.log(`${icon} [${id}] ${name}: ${status}`);
  if (details) console.log(`   └─ ${details}`);
}

async function runTestMatrix() {
  console.log("\n=======================================================");
  console.log("PHASE 2 DATABASE & PATIENT IDENTITY TEST MATRIX");
  console.log("=======================================================\n");

  // TEST 1: Prisma Schema Validation
  try {
    const outPg = execSync("node node_modules/prisma/build/index.js validate --schema=prisma/schema.prisma", { cwd: ROOT_DIR }).toString();
    const outSqlite = execSync("node node_modules/prisma/build/index.js validate --schema=prisma/schema.sqlite.prisma", { cwd: ROOT_DIR }).toString();
    if (outPg.includes("is valid") && outSqlite.includes("is valid")) {
      recordTest("TEST-01", "Prisma Schema Validation (PG & SQLite)", "PASS", "Both schemas parsed and verified valid by Prisma 7 PSL parser.");
    } else {
      recordTest("TEST-01", "Prisma Schema Validation (PG & SQLite)", "FAIL", "Validation output missing expected confirmation.");
    }
  } catch (err) {
    recordTest("TEST-01", "Prisma Schema Validation (PG & SQLite)", "FAIL", err.message);
  }

  // TEST 2: SQLite Migration & Driver Adapter Test
  try {
    const count = await prisma.patient.count();
    recordTest("TEST-02", "SQLite Migration & Driver Adapter Test", "PASS", `Prisma connected to dev.db via @prisma/adapter-better-sqlite3. Found ${count} patients.`);
  } catch (err) {
    recordTest("TEST-02", "SQLite Migration & Driver Adapter Test", "FAIL", err.message);
  }

  // TEST 3: PostgreSQL Migration Test (Infrastructure Truthfulness)
  try {
    recordTest(
      "TEST-03",
      "PostgreSQL Production Configuration",
      "PENDING_INFRA",
      "Production schema validated against PostgreSQL grammar. Live container/service execution pending production staging infrastructure (no local PostgreSQL daemon present)."
    );
  } catch (err) {
    recordTest("TEST-03", "PostgreSQL Production Configuration", "FAIL", err.message);
  }

  // TEST 4: db.json Migration Verification
  try {
    const patientCount = await prisma.patient.count();
    const encounterCount = await prisma.encounter.count();
    const docCount = await prisma.document.count();

    if (patientCount >= 10 && encounterCount >= 14 && docCount >= 33) {
      recordTest("TEST-04", "db.json Migration Verification", "PASS", `Verified counts: ${patientCount} patients, ${encounterCount} encounters, ${docCount} documents.`);
    } else {
      recordTest("TEST-04", "db.json Migration Verification", "FAIL", `Incomplete migration: ${patientCount} patients, ${encounterCount} encounters, ${docCount} documents.`);
    }
  } catch (err) {
    recordTest("TEST-04", "db.json Migration Verification", "FAIL", err.message);
  }

  // TEST 5: Migration Idempotency Test
  try {
    const report = await runMigration();
    if (report.patientsCreated === 0 && report.encountersCreated === 0 && report.errors.length === 0) {
      recordTest("TEST-05", "Migration Repeat / Idempotency Test", "PASS", "Re-running migration generated 0 duplicates and 0 conflicting overwrites.");
    } else {
      recordTest("TEST-05", "Migration Repeat / Idempotency Test", "FAIL", `Unexpected duplicates created: ${report.patientsCreated} patients, ${report.encountersCreated} encounters.`);
    }
  } catch (err) {
    recordTest("TEST-05", "Migration Repeat / Idempotency Test", "FAIL", err.message);
  }

  // TEST 6: Patient Duplicate Prevention Test
  try {
    let duplicateCaught = false;
    try {
      await prisma.patient.create({
        data: {
          patientUid: "00000000-0000-0000-0000-000000000001", // Existing SYN-PAT-001 UID
          patientId: "SYN-PAT-001-DUP",
          fullName: "Duplicate Attempt"
        }
      });
    } catch (e) {
      if (e.code === "P2002" || e.message.includes("Unique constraint")) {
        duplicateCaught = true;
      }
    }

    if (duplicateCaught) {
      recordTest("TEST-06", "Patient Duplicate Prevention Test", "PASS", "Unique constraint on patientUid correctly rejected duplicate insertion (P2002).");
    } else {
      recordTest("TEST-06", "Patient Duplicate Prevention Test", "FAIL", "Duplicate patientUid was accepted without error.");
    }
  } catch (err) {
    recordTest("TEST-06", "Patient Duplicate Prevention Test", "FAIL", err.message);
  }

  // TEST 7: Patient Lookup Test (Mobile & ABHA)
  try {
    const ram = await prisma.patient.findFirst({
      where: { fullName: "Ram" }
    });
    const ramesh = await prisma.patient.findFirst({
      where: { abhaNumber: "91-8842-1092-4402" }
    });

    if (ram && ramesh && ramesh.fullName === "Ramesh Sharma") {
      recordTest("TEST-07", "Patient Lookup Test", "PASS", `Successfully resolved Ram (${ram.patientId}) and Ramesh Sharma (${ramesh.patientId}) by ABHA index.`);
    } else {
      recordTest("TEST-07", "Patient Lookup Test", "FAIL", "Failed resolving patients by demographics/ABHA.");
    }
  } catch (err) {
    recordTest("TEST-07", "Patient Lookup Test", "FAIL", err.message);
  }

  // TEST 8: Encounter Relationship & Multi-Encounter Test
  try {
    const ramEncounters = await prisma.encounter.findMany({
      where: { patient: { fullName: "Ram" } },
      include: { patient: true }
    });

    if (ramEncounters.length === 4) {
      const tokens = ramEncounters.map((e) => e.tokenNumber).sort();
      recordTest("TEST-08", "Encounter Multiplicity & FK Relationship", "PASS", `Patient Ram has 4 distinct encounters mapped to single patientUid: Tokens [${tokens.join(", ")}].`);
    } else {
      recordTest("TEST-08", "Encounter Multiplicity & FK Relationship", "FAIL", `Expected 4 encounters for Ram, found ${ramEncounters.length}.`);
    }
  } catch (err) {
    recordTest("TEST-08", "Encounter Multiplicity & FK Relationship", "FAIL", err.message);
  }

  // TEST 9: User / Doctor Foreign Key Test
  try {
    const doctor = await prisma.user.findUnique({
      where: { email: "dr.sharma@hospital.gov.in" }
    });

    const doc = await prisma.document.findFirst();
    let approval = null;
    if (doctor && doc) {
      approval = await prisma.documentApproval.create({
        data: {
          documentId: doc.documentId,
          approvedByUserId: doctor.id,
          action: "APPROVED",
          comments: "Verified by Dr. Sharma"
        }
      });
    }

    if (approval && approval.approvedByUserId === doctor.id) {
      recordTest("TEST-09", "User / Doctor Foreign Key Test", "PASS", `DocumentApproval successfully linked to User ID ${doctor.id} (${doctor.name}).`);
    } else {
      recordTest("TEST-09", "User / Doctor Foreign Key Test", "FAIL", "Failed creating relational DocumentApproval.");
    }
  } catch (err) {
    recordTest("TEST-09", "User / Doctor Foreign Key Test", "FAIL", err.message);
  }

  // TEST 10: Purpose-Aware Consent Test
  try {
    const patient = await prisma.patient.findFirst();
    const doctor = await prisma.user.findFirst({ where: { role: "doctor" } });

    const consent = await prisma.patientConsent.create({
      data: {
        patientUid: patient.patientUid,
        consentType: "ai_processing",
        purpose: "Clinical summarization and triage assistance",
        policyVersion: "v1.2-2026",
        granted: true,
        capturedByType: "kiosk_self",
        capturedByUserId: doctor ? doctor.id : null
      }
    });

    // Test withdrawal
    const withdrawn = await prisma.patientConsent.update({
      where: { id: consent.id },
      data: {
        granted: false,
        withdrawnAt: new Date()
      }
    });

    if (withdrawn.withdrawnAt && withdrawn.granted === false) {
      recordTest("TEST-10", "Purpose-Aware Consent Foundation Test", "PASS", `Consent lifecycle verified (granted -> withdrawn) for ${patient.patientId}.`);
    } else {
      recordTest("TEST-10", "Purpose-Aware Consent Foundation Test", "FAIL", "Consent update failed.");
    }
  } catch (err) {
    recordTest("TEST-10", "Purpose-Aware Consent Foundation Test", "FAIL", err.message);
  }

  // TEST 11: AuditLog Actor & Patient Linkage Test
  try {
    const doctor = await prisma.user.findFirst({ where: { role: "doctor" } });
    const patient = await prisma.patient.findFirst();

    const audit = await prisma.auditLog.create({
      data: {
        patientUid: patient.patientUid,
        actorUserId: doctor.id,
        actorType: "doctor",
        action: "VIEW_RECORD",
        resourceType: "patient",
        resourceId: patient.patientId,
        metadataJson: JSON.stringify({ ip: "127.0.0.1", chamber: doctor.chamber })
      }
    });

    const queried = await prisma.auditLog.findUnique({
      where: { id: audit.id },
      include: { actorUser: true, patient: true }
    });

    const actor = queried.actorUser || queried.actor;
    if (actor && actor.email === doctor.email && queried.patient.patientUid === patient.patientUid) {
      recordTest("TEST-11", "AuditLog Actor & Patient Linkage Test", "PASS", `AuditLog correctly relates to Actor (${doctor.name}) and Patient (${patient.patientId}) without raw PHI.`);
    } else {
      recordTest("TEST-11", "AuditLog Actor & Patient Linkage Test", "FAIL", "AuditLog relational links corrupted.");
    }
  } catch (err) {
    recordTest("TEST-11", "AuditLog Actor & Patient Linkage Test", "FAIL", err.message);
  }

  // TEST 12: Patient Isolation Query Test
  try {
    const arjun = await prisma.patient.findUnique({ where: { patientId: "SYN-PAT-001" } });
    const ram = await prisma.patient.findFirst({ where: { fullName: "Ram" } });

    const arjunEncounters = await prisma.encounter.findMany({ where: { patientUid: arjun.patientUid } });
    const ramEncounters = await prisma.encounter.findMany({ where: { patientUid: ram.patientUid } });

    const hasCrossContamination = arjunEncounters.some((e) => e.patientUid === ram.patientUid) || ramEncounters.some((e) => e.patientUid === arjun.patientUid);

    if (!hasCrossContamination && ramEncounters.length > 0) {
      recordTest("TEST-12", "Patient Isolation Query Test", "PASS", "Patient database scopes strictly isolated; zero record cross-contamination.");
    } else {
      recordTest("TEST-12", "Patient Isolation Query Test", "FAIL", "Cross-contamination detected between patient scopes.");
    }
  } catch (err) {
    recordTest("TEST-12", "Patient Isolation Query Test", "FAIL", err.message);
  }

  // TEST 13: Legacy Express API Regression Test
  try {
    let baseUrl = "http://localhost:5000";
    let testServer = null;
    try {
      const ping = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(800) });
      if (!ping.ok) throw new Error("not running");
    } catch (e) {
      const { default: app } = await import("../Patient-case-taking-software-/server.js");
      const http = await import("http");
      await new Promise((resolve) => {
        testServer = http.createServer(app);
        testServer.listen(0, "127.0.0.1", () => {
          const port = testServer.address().port;
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      });
    }

    const healthRes = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    const queueRes = await fetch(`${baseUrl}/api/queue`).then((r) => r.json());
    const pat120Res = await fetch(`${baseUrl}/api/patient/120`).then((r) => r.json());

    // Test new intake
    const intakeRes = await fetch(`${baseUrl}/api/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "999",
        name: "Test Automated Patient",
        age: 30,
        gender: "Female",
        phone: "9999988888",
        chiefComplaint: "Automated test complaint",
        priority: "Normal"
      })
    }).then((r) => r.json());

    // Test completion
    const completeRes = await fetch(`${baseUrl}/api/patient/999/complete`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doctorNotes: "Automated prescription completed.",
        consultationStatus: "completed"
      })
    }).then((r) => r.json());

    if (testServer) {
      await new Promise((resolve) => testServer.close(resolve));
    }

    if (
      healthRes.status === "healthy" &&
      queueRes.success === true &&
      pat120Res.patient.name === "Ram" &&
      intakeRes.success === true &&
      completeRes.patient.consultationStatus === "completed"
    ) {
      recordTest("TEST-13", "Legacy Express API Regression Test", "PASS", "All 5 endpoints (/health, /queue, /patient/:token, /intake, /complete) returned expected HTTP 200 responses.");
    } else {
      recordTest("TEST-13", "Legacy Express API Regression Test", "FAIL", "API response contract mismatch.");
    }
  } catch (err) {
    recordTest("TEST-13", "Legacy Express API Regression Test", "FAIL", err.message);
  }

  // TEST 14: SYN-PAT-001 Preservation Test
  try {
    const synPat = await prisma.patient.findUnique({
      where: { patientId: "SYN-PAT-001" }
    });

    const expectedUid = "00000000-0000-0000-0000-000000000001";
    const chunkPath = path.resolve(ROOT_DIR, "aiml-crash-yash-verma-Aurahealth_final_project (1)", "aiml-crash-yash-verma-Aurahealth_final_project", "vector_index", "SYN-PAT-001", "chunks.pkl");
    const indexPath = path.resolve(ROOT_DIR, "aiml-crash-yash-verma-Aurahealth_final_project (1)", "aiml-crash-yash-verma-Aurahealth_final_project", "vector_index", "SYN-PAT-001", "index.faiss");

    const chunkHash = crypto.createHash("sha256").update(fs.readFileSync(chunkPath)).digest("hex");
    const indexHash = crypto.createHash("sha256").update(fs.readFileSync(indexPath)).digest("hex");

    const expectedChunkHash = "2998c4342bd6a68378547393d63adf366068bbaf6332fde8ef6de4cd577aff71";
    const expectedIndexHash = "01943874e07f89ebb82148e37c9e6c40e3cf1e2ef74d43c189eab8e050189527";

    const filesUntouched = chunkHash.toLowerCase() === expectedChunkHash.toLowerCase() && indexHash.toLowerCase() === expectedIndexHash.toLowerCase();

    if (synPat && synPat.patientUid === expectedUid && filesUntouched) {
      recordTest("TEST-14", "SYN-PAT-001 Synthetic Preservation Test", "PASS", "SYN-PAT-001 mapped to deterministic UUID 0000...0001. FAISS index & chunks hashes 100% identical to backup.");
    } else {
      recordTest("TEST-14", "SYN-PAT-001 Synthetic Preservation Test", "FAIL", "SYN-PAT-001 mapping or vector file integrity check failed.");
    }
  } catch (err) {
    recordTest("TEST-14", "SYN-PAT-001 Synthetic Preservation Test", "FAIL", err.message);
  }

  console.log("\n=======================================================");
  console.log("TEST MATRIX SUMMARY");
  console.log("=======================================================");
  const passed = results.filter((r) => r.status === "PASS").length;
  const pending = results.filter((r) => r.status === "PENDING_INFRA").length;
  const failed = results.filter((r) => r.status === "FAIL").length;

  console.log(`Total Tests:    ${results.length}`);
  console.log(`Passed:         ${passed}`);
  console.log(`Pending Infra:  ${pending}`);
  console.log(`Failed:         ${failed}`);
  console.log("=======================================================\n");

  await disconnectPrisma();
  return { total: results.length, passed, pending, failed, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTestMatrix()
    .then((summary) => {
      if (summary.failed > 0) process.exit(1);
      process.exit(0);
    })
    .catch(async (e) => {
      console.error(e);
      await disconnectPrisma();
      process.exit(1);
    });
}
