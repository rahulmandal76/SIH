/**
 * Phase 5C Test Suite: Clinical Fact Extraction, Complete Version Snapshots,
 * Clinical Review, Versioned Corrections & Doctor Approval Gate
 *
 * Authority: docs/PHASE_5_IMPLEMENTATION_PLAN.md
 *
 * Authoritative Test Matrix:
 *   TEST-P5C-01: Structured extraction
 *   TEST-P5C-02: Schema validation across all 6 categories
 *   TEST-P5C-03: Exact source page attribution
 *   TEST-P5C-04: DOCUMENT_EXTRACTED vs OCR_EXTRACTED provenance
 *   TEST-P5C-05: Clinical date vs upload date
 *   TEST-P5C-06: Malformed fact rejection
 *   TEST-P5C-07: Cross-patient fact isolation
 *   TEST-P5C-08: Unauthorized doctor access
 *   TEST-P5C-09: Suspended CareRelationship rejection
 *   TEST-P5C-10: Authorized review bundle
 *   TEST-P5C-11: Assigned doctor approval
 *   TEST-P5C-12: CareRelationship doctor approval
 *   TEST-P5C-13: Patient/device approval denied
 *   TEST-P5C-14: Approval exact-version binding
 *   TEST-P5C-15: Page edit creates new version and invalidates approval
 *   TEST-P5C-16: Stale version not RAG-eligible
 *   TEST-P5C-17: Fact edit creates DOCTOR_ENTERED lineage
 *   TEST-P5C-18: Fresh approval required after correction
 *   TEST-P5C-19: Audit event coverage
 *   TEST-P5C-20: Browser zero-ID invariant + immutable original binary
 *   TEST-P5C-21: Complete page snapshot after page edit
 *   TEST-P5C-22: Complete fact snapshot + historical immutability
 *   TEST-P5C-23: Fact extraction idempotency
 *   TEST-P5C-24: Admin governance boundary
 *   TEST-P5C-25: Stale page edit returns VERSION_CONFLICT
 *   TEST-P5C-26: Stale fact edit returns VERSION_CONFLICT
 *   TEST-P5C-27: Stale approval returns VERSION_CONFLICT
 *   TEST-P5C-28: Concurrent edit race — one succeeds, one VERSION_CONFLICT
 *   TEST-P5C-29: Snapshot transaction rollback leaves no partial version
 *   TEST-P5C-30: Admin clinical-fact editing denied
 *   TEST-P5C-31: Historical source provenance remains immutable after approval
 *   TEST-P5C-32: Fact removal/void creates valid next snapshot without deleting history
 */

import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma, disconnectPrisma } from "../prisma/db.js";
import app, { clinicalFactExtractor, isDocumentRAGEligible } from "../Patient-case-taking-software-/server.js";
import { ClinicalFactSchema } from "../Patient-case-taking-software-/server/clinicalFactExtractor.js";
import { createEncounterSession, createUserSession } from "../Patient-case-taking-software-/server/sessions.js";

let serverInstance;
let TEST_PORT;

const results = [];

function recordTest(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  const icon = status === "PASS" ? "✅" : (status === "PENDING_INFRA" ? "⏳" : "❌");
  console.log(`${icon} [${id}] ${name}: ${status}`);
  if (detail) {
    console.log(`   └── ${detail}`);
  }
}

function makeRequest(method, reqPath, payload = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };

    if (["POST", "PUT", "DELETE", "PATCH"].includes(method.toUpperCase())) {
      if (!reqHeaders["X-Requested-With"]) {
        reqHeaders["X-Requested-With"] = "XMLHttpRequest";
      }
    }

    let payloadBuffer = null;
    if (payload) {
      if (Buffer.isBuffer(payload)) {
        payloadBuffer = payload;
        reqHeaders["Content-Length"] = payloadBuffer.length;
      } else if (typeof payload === "object") {
        payloadBuffer = Buffer.from(JSON.stringify(payload), "utf-8");
        reqHeaders["Content-Type"] = "application/json";
        reqHeaders["Content-Length"] = payloadBuffer.length;
      } else {
        payloadBuffer = Buffer.from(String(payload), "utf-8");
        reqHeaders["Content-Length"] = payloadBuffer.length;
      }
    }

    const req = http.request({
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: reqPath,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on("error", reject);

    if (payloadBuffer) {
      req.write(payloadBuffer);
    }
    req.end();
  });
}

// Global fixtures
const P1_UID = "66666666-6666-6666-6666-000000000001";
const P2_UID = "66666666-6666-6666-6666-000000000002";

let docDoctor1User;
let docDoctor2User;
let docUnrelatedDoctor;
let docAdminUser;

let doctor1Session;
let doctor2Session;
let unrelatedDoctorSession;
let adminSession;
let patient1EncounterSession;

let testDoc1;
let testDoc2;
let doc1BinaryPath;
let doc1InitialSha256;

async function setupFixtures() {
  // Clean prior Phase 5C test records
  await prisma.documentApproval.deleteMany({
    where: { documentId: { startsWith: "DOC-P5C-" } }
  }).catch(() => {});

  await prisma.documentClinicalFact.deleteMany({
    where: { documentId: { startsWith: "DOC-P5C-" } }
  }).catch(() => {});

  await prisma.documentPage.deleteMany({
    where: { documentId: { startsWith: "DOC-P5C-" } }
  }).catch(() => {});

  await prisma.document.deleteMany({
    where: { documentId: { startsWith: "DOC-P5C-" } }
  }).catch(() => {});

  await prisma.careRelationship.deleteMany({
    where: { patientUid: { in: [P1_UID, P2_UID] } }
  }).catch(() => {});

  await prisma.encounter.deleteMany({
    where: { encounterId: { startsWith: "ENC-P5C-" } }
  }).catch(() => {});

  await prisma.patient.deleteMany({
    where: { patientUid: { in: [P1_UID, P2_UID] } }
  }).catch(() => {});

  await prisma.user.deleteMany({
    where: { email: { in: ["p5c_doc1@medsync.local", "p5c_doc2@medsync.local", "p5c_doc3@medsync.local", "p5c_admin@medsync.local"] } }
  }).catch(() => {});

  // Create Users
  docDoctor1User = await prisma.user.create({
    data: {
      userUid: "usr-p5c-doc1",
      name: "Dr. P5C Attending",
      email: "p5c_doc1@medsync.local",
      passwordHash: "dummy",
      salt: "dummy",
      role: "doctor",
      chamber: "Chamber 1"
    }
  });

  docDoctor2User = await prisma.user.create({
    data: {
      userUid: "usr-p5c-doc2",
      name: "Dr. P5C CareRel",
      email: "p5c_doc2@medsync.local",
      passwordHash: "dummy",
      salt: "dummy",
      role: "doctor",
      chamber: "Chamber 2"
    }
  });

  docUnrelatedDoctor = await prisma.user.create({
    data: {
      userUid: "usr-p5c-doc3",
      name: "Dr. P5C Unrelated",
      email: "p5c_doc3@medsync.local",
      passwordHash: "dummy",
      salt: "dummy",
      role: "doctor",
      chamber: "Chamber 3"
    }
  });

  docAdminUser = await prisma.user.create({
    data: {
      userUid: "usr-p5c-admin",
      name: "P5C Admin User",
      email: "p5c_admin@medsync.local",
      passwordHash: "dummy",
      salt: "dummy",
      role: "admin"
    }
  });

  // Create Patients
  await prisma.patient.create({
    data: {
      patientUid: P1_UID,
      patientId: "PAT-P5C-001",
      fullName: "P5C Test Patient 1",
      age: 45,
      gender: "Male"
    }
  });

  await prisma.patient.create({
    data: {
      patientUid: P2_UID,
      patientId: "PAT-P5C-002",
      fullName: "P5C Test Patient 2",
      age: 38,
      gender: "Female"
    }
  });

  // Create Encounter for Patient 1 assigned to Doctor 1
  await prisma.encounter.create({
    data: {
      encounterId: "ENC-P5C-001",
      patientUid: P1_UID,
      tokenNumber: "P5C-T01",
      assignedDoctorId: docDoctor1User.id,
      consultationStatus: "waiting"
    }
  });

  // Create active CareRelationship for Doctor 2 with Patient 1
  await prisma.careRelationship.create({
    data: {
      patientUid: P1_UID,
      doctorId: docDoctor2User.id,
      relationshipType: "PRIMARY_PHYSICIAN",
      status: "active"
    }
  });

  // Create suspended CareRelationship for Doctor 3 with Patient 1
  await prisma.careRelationship.create({
    data: {
      patientUid: P1_UID,
      doctorId: docUnrelatedDoctor.id,
      relationshipType: "SPECIALIST_REFERRAL",
      status: "suspended"
    }
  });

  // Create sessions
  doctor1Session = createUserSession(docDoctor1User);
  doctor2Session = createUserSession(docDoctor2User);
  unrelatedDoctorSession = createUserSession(docUnrelatedDoctor);
  adminSession = createUserSession(docAdminUser);
  patient1EncounterSession = createEncounterSession(P1_UID, "ENC-P5C-001");

  // Create Physical file for Document 1 to test byte-level immutability
  const storageDir = path.resolve(process.cwd(), "data", "documents", P1_UID);
  fs.mkdirSync(storageDir, { recursive: true });
  doc1BinaryPath = path.join(storageDir, "DOC-P5C-001.pdf");
  const dummyBinary = Buffer.from("%PDF-1.4 TEST BINARY PAYLOAD FOR IMMUTABILITY VERIFICATION", "utf-8");
  fs.writeFileSync(doc1BinaryPath, dummyBinary);
  doc1InitialSha256 = crypto.createHash("sha256").update(dummyBinary).digest("hex");

  // Create Document 1 (Status: ready, derivativeVersion: 1)
  testDoc1 = await prisma.document.create({
    data: {
      documentId: "DOC-P5C-001",
      patientUid: P1_UID,
      encounterId: "ENC-P5C-001",
      fileName: "DOC-P5C-001.pdf",
      filePath: doc1BinaryPath,
      fileSize: dummyBinary.length,
      mimeType: "application/pdf",
      documentType: "prescription",
      fileHash: doc1InitialSha256,
      totalPages: 2,
      derivativeVersion: 1,
      status: "ready",
      clinicalDate: new Date("2023-05-15T00:00:00.000Z")
    }
  });

  // Create Pages for Document 1
  await prisma.documentPage.create({
    data: {
      documentId: testDoc1.documentId,
      pageNumber: 1,
      version: 1,
      extractedText: "Date: 15/05/2023\nDiagnosis: Type 2 Diabetes Mellitus, Essential Hypertension\nRx: Tab Metformin 500mg OD\nSymptoms: Presenting with Fever and Cough",
      ocrStatus: "native_text",
      ocrConfidence: 1.0
    }
  });

  await prisma.documentPage.create({
    data: {
      documentId: testDoc1.documentId,
      pageNumber: 2,
      version: 1,
      extractedText: "Investigations & Labs:\nHbA1c: 7.2 %\nSerum Creatinine: 1.1 mg/dl\nBlood Pressure: 130/85 mmHg\nProcedure: ECG performed",
      ocrStatus: "ocr_processed",
      ocrConfidence: 0.92
    }
  });

  // Create Document 2 for Patient 2 (cross-patient isolation)
  testDoc2 = await prisma.document.create({
    data: {
      documentId: "DOC-P5C-002",
      patientUid: P2_UID,
      fileName: "DOC-P5C-002.pdf",
      filePath: "data/dummy2.pdf",
      fileSize: 100,
      mimeType: "application/pdf",
      documentType: "lab_report",
      totalPages: 1,
      derivativeVersion: 1,
      status: "ready"
    }
  });

  await prisma.documentPage.create({
    data: {
      documentId: testDoc2.documentId,
      pageNumber: 1,
      version: 1,
      extractedText: "Diagnosis: Bronchial Asthma\nRx: Inhaler Budecort",
      ocrStatus: "native_text",
      ocrConfidence: 1.0
    }
  });
}

async function runTests() {
  console.log("=======================================================");
  console.log("PHASE 5C AUTHORITATIVE TEST SUITE");
  console.log("Clinical Fact Extraction, Versioning & Approval Gate");
  console.log("=======================================================\n");

  try {
    // -------------------------------------------------------------------
    // TEST-P5C-01: Structured extraction
    // -------------------------------------------------------------------
    {
      const text = "Date: 12/04/2023\nDiagnosis: Type 2 Diabetes Mellitus\nRx: Metformin 500mg OD\nHbA1c: 7.4 %\nBP: 125/80\nProcedure: ECG\nChief Complaints: Fever, Cough";
      const facts = clinicalFactExtractor.extractFactsFromText(text, {
        documentId: "DOC-P5C-TEST",
        patientUid: P1_UID,
        pageNumber: 1,
        provenance: "DOCUMENT_EXTRACTED",
        version: 1,
        confidence: 1.0
      });

      const types = facts.map(f => f.factType);
      const hasAll6 = ["diagnosis", "medication", "lab_result", "vital", "procedure", "symptom"].every(t => types.includes(t));

      if (hasAll6 && facts.length >= 6) {
        recordTest("TEST-P5C-01", "Structured extraction", "PASS", `Extracted ${facts.length} facts covering all 6 canonical types`);
      } else {
        recordTest("TEST-P5C-01", "Structured extraction", "FAIL", `Missing types: got ${JSON.stringify(types)}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-02: Schema validation across all 6 categories
    // -------------------------------------------------------------------
    {
      const categories = [
        { factType: "diagnosis", factKey: "Hypertension", factValue: "confirmed" },
        { factType: "medication", factKey: "Paracetamol", factValue: "500mg BD" },
        { factType: "lab_result", factKey: "HbA1c", factValue: "6.8", unit: "%" },
        { factType: "vital", factKey: "Blood Pressure", factValue: "120/80", unit: "mmHg" },
        { factType: "procedure", factKey: "Chest X-Ray", factValue: "performed" },
        { factType: "symptom", factKey: "Headache", factValue: "present" }
      ];

      let allValid = true;
      for (const cat of categories) {
        const parsed = ClinicalFactSchema.safeParse({
          documentId: "DOC-001",
          patientUid: P1_UID,
          pageNumber: 1,
          ...cat,
          provenance: "DOCUMENT_EXTRACTED",
          version: 1
        });
        if (!parsed.success) {
          allValid = false;
          break;
        }
      }

      if (allValid) {
        recordTest("TEST-P5C-02", "Schema validation across all 6 categories", "PASS", "Strict Zod schema successfully validates all 6 categories");
      } else {
        recordTest("TEST-P5C-02", "Schema validation across all 6 categories", "FAIL", "Failed validating one or more categories");
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-03: Exact source page attribution
    // -------------------------------------------------------------------
    {
      const page1Facts = clinicalFactExtractor.extractFactsFromText("Diagnosis: Malaria", {
        documentId: "DOC-P5C-001",
        patientUid: P1_UID,
        pageNumber: 1,
        provenance: "DOCUMENT_EXTRACTED",
        version: 1
      });
      const page2Facts = clinicalFactExtractor.extractFactsFromText("Rx: Tab Chloroquine 250mg", {
        documentId: "DOC-P5C-001",
        patientUid: P1_UID,
        pageNumber: 2,
        provenance: "DOCUMENT_EXTRACTED",
        version: 1
      });

      const p1Match = page1Facts.every(f => f.pageNumber === 1);
      const p2Match = page2Facts.every(f => f.pageNumber === 2);

      if (p1Match && p2Match && page1Facts.length > 0 && page2Facts.length > 0) {
        recordTest("TEST-P5C-03", "Exact source page attribution", "PASS", "Source pageNumber 1 and 2 accurately bound to extracted facts");
      } else {
        recordTest("TEST-P5C-03", "Exact source page attribution", "FAIL", "Incorrect page attribution");
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-04: DOCUMENT_EXTRACTED vs OCR_EXTRACTED provenance
    // -------------------------------------------------------------------
    {
      const nativeFacts = clinicalFactExtractor.extractFromDocumentPages(testDoc1, [
        { pageNumber: 1, extractedText: "Diagnosis: Dengue", ocrStatus: "native_text", ocrConfidence: 1.0 }
      ]);
      const ocrFacts = clinicalFactExtractor.extractFromDocumentPages(testDoc1, [
        { pageNumber: 1, extractedText: "Diagnosis: Dengue", ocrStatus: "ocr_processed", ocrConfidence: 0.85 }
      ]);

      const nativeProv = nativeFacts[0]?.provenance === "DOCUMENT_EXTRACTED";
      const ocrProv = ocrFacts[0]?.provenance === "OCR_EXTRACTED";

      if (nativeProv && ocrProv) {
        recordTest("TEST-P5C-04", "DOCUMENT_EXTRACTED vs OCR_EXTRACTED provenance", "PASS", "DOCUMENT_EXTRACTED assigned for native text, OCR_EXTRACTED for OCR");
      } else {
        recordTest("TEST-P5C-04", "DOCUMENT_EXTRACTED vs OCR_EXTRACTED provenance", "FAIL", `Mismatch: native=${nativeFacts[0]?.provenance}, ocr=${ocrFacts[0]?.provenance}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-05: Clinical date vs upload date
    // -------------------------------------------------------------------
    {
      const datedFacts = clinicalFactExtractor.extractFactsFromText("Date: 2021-08-10\nDiagnosis: Typhoid", {
        documentId: "DOC-001",
        patientUid: P1_UID,
        pageNumber: 1,
        provenance: "DOCUMENT_EXTRACTED",
        version: 1
      });
      const undatedFacts = clinicalFactExtractor.extractFactsFromText("Diagnosis: Typhoid", {
        documentId: "DOC-001",
        patientUid: P1_UID,
        pageNumber: 1,
        provenance: "DOCUMENT_EXTRACTED",
        version: 1,
        clinicalDate: null
      });

      const datePreserved = datedFacts[0]?.clinicalDate instanceof Date && datedFacts[0].clinicalDate.toISOString().startsWith("2021-08-10");
      const noFabrication = undatedFacts[0]?.clinicalDate === null;

      if (datePreserved && noFabrication) {
        recordTest("TEST-P5C-05", "Clinical date vs upload date", "PASS", "Explicit date 2021-08-10 parsed; undated fact correctly defaults to null (no fabrication)");
      } else {
        recordTest("TEST-P5C-05", "Clinical date vs upload date", "FAIL", "Failed date distinction");
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-06: Malformed fact rejection
    // -------------------------------------------------------------------
    {
      const invalidType = ClinicalFactSchema.safeParse({
        documentId: "DOC-001",
        patientUid: P1_UID,
        pageNumber: 1,
        factType: "conjecture", // invalid type
        factKey: "Key",
        factValue: "Value",
        provenance: "DOCUMENT_EXTRACTED"
      });

      const invalidConfidence = ClinicalFactSchema.safeParse({
        documentId: "DOC-001",
        patientUid: P1_UID,
        pageNumber: 1,
        factType: "diagnosis",
        factKey: "Key",
        factValue: "Value",
        confidence: 1.5, // out of range
        provenance: "DOCUMENT_EXTRACTED"
      });

      const invalidUuid = ClinicalFactSchema.safeParse({
        documentId: "DOC-001",
        patientUid: "not-a-uuid", // invalid uuid
        pageNumber: 1,
        factType: "diagnosis",
        factKey: "Key",
        factValue: "Value",
        provenance: "DOCUMENT_EXTRACTED"
      });

      if (!invalidType.success && !invalidConfidence.success && !invalidUuid.success) {
        recordTest("TEST-P5C-06", "Malformed fact rejection", "PASS", "Strict schema rejected invalid factType, confidence > 1.0, and malformed patientUid");
      } else {
        recordTest("TEST-P5C-06", "Malformed fact rejection", "FAIL", "One or more malformed facts incorrectly accepted");
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-07: Cross-patient fact isolation
    // -------------------------------------------------------------------
    {
      // Doctor 1 (assigned to P1) attempts to access P2's document facts
      const res = await makeRequest("GET", `/api/documents/${testDoc2.documentId}/facts`, null, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
        recordTest("TEST-P5C-07", "Cross-patient fact isolation", "PASS", "Doctor 1 denied access to Patient 2 document facts (403 CLINICAL_ACCESS_DENIED)");
      } else {
        recordTest("TEST-P5C-07", "Cross-patient fact isolation", "FAIL", `Expected 403 CLINICAL_ACCESS_DENIED, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-08: Unauthorized doctor access
    // -------------------------------------------------------------------
    {
      // Unrelated doctor attempts to view P1's document review bundle
      const res = await makeRequest("GET", `/api/documents/${testDoc1.documentId}/review`, null, {
        Cookie: `ms_user_session=${unrelatedDoctorSession}`
      });

      if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
        recordTest("TEST-P5C-08", "Unauthorized doctor access", "PASS", "Unrelated doctor with no assignment denied access to review bundle (403)");
      } else {
        recordTest("TEST-P5C-08", "Unauthorized doctor access", "FAIL", `Expected 403 CLINICAL_ACCESS_DENIED, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-09: Suspended CareRelationship rejection
    // -------------------------------------------------------------------
    {
      // Doctor 3 has status: "suspended" with Patient 1
      const res = await makeRequest("POST", `/api/documents/${testDoc1.documentId}/extract`, {}, {
        Cookie: `ms_user_session=${unrelatedDoctorSession}`
      });

      if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
        recordTest("TEST-P5C-09", "Suspended CareRelationship rejection", "PASS", "Doctor with suspended CareRelationship strictly rejected (403 CLINICAL_ACCESS_DENIED)");
      } else {
        recordTest("TEST-P5C-09", "Suspended CareRelationship rejection", "FAIL", `Expected 403 CLINICAL_ACCESS_DENIED, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-10: Authorized review bundle
    // -------------------------------------------------------------------
    {
      // First extract facts for Doc 1 as Doctor 1
      const extractRes = await makeRequest("POST", `/api/documents/${testDoc1.documentId}/extract`, {}, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const res = await makeRequest("GET", `/api/documents/${testDoc1.documentId}/review`, null, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const body = res.body;
      const validBundle = res.status === 200 &&
        body.document &&
        body.currentVersion === 1 &&
        Array.isArray(body.pages) &&
        Array.isArray(body.facts) &&
        body.facts.length > 0 &&
        body.patientUid === undefined &&
        body.patientId === undefined &&
        body.document.patientUid === undefined;

      if (validBundle) {
        recordTest("TEST-P5C-10", "Authorized review bundle", "PASS", `Review bundle returned 200 with ${body.pages.length} pages, ${body.facts.length} facts; zero patient UID leaked`);
      } else {
        recordTest("TEST-P5C-10", "Authorized review bundle", "FAIL", `Status: ${res.status}, body valid: ${validBundle}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-11: Assigned doctor approval
    // -------------------------------------------------------------------
    {
      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: 1,
        action: "APPROVED",
        comments: "All facts clinically verified"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      if (res.status === 200 && res.body?.status === "approved" && res.body?.approvedVersion === 1) {
        recordTest("TEST-P5C-11", "Assigned doctor approval", "PASS", "Assigned Doctor 1 approved document version 1; Document.status='approved'");
      } else {
        recordTest("TEST-P5C-11", "Assigned doctor approval", "FAIL", `Expected 200 approved, got ${res.status}: ${JSON.stringify(res.body)}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-12: CareRelationship doctor approval
    // -------------------------------------------------------------------
    {
      // Reset doc to pending_review for CareRel test
      await prisma.document.update({
        where: { documentId: testDoc1.documentId },
        data: { status: "pending_review" }
      });

      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: 1,
        action: "APPROVED",
        comments: "Approved via CareRelationship"
      }, {
        Cookie: `ms_user_session=${doctor2Session}`
      });

      if (res.status === 200 && res.body?.status === "approved") {
        recordTest("TEST-P5C-12", "CareRelationship doctor approval", "PASS", "Doctor 2 with active CareRelationship successfully approved document");
      } else {
        recordTest("TEST-P5C-12", "CareRelationship doctor approval", "FAIL", `Expected 200 approved, got ${res.status}: ${JSON.stringify(res.body)}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-13: Patient/device approval denied
    // -------------------------------------------------------------------
    {
      // Patient encounter session attempts approval
      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: 1,
        action: "APPROVED"
      }, {
        Cookie: `ms_encounter_session=${patient1EncounterSession}`
      });

      if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
        recordTest("TEST-P5C-13", "Patient/device approval denied", "PASS", "Patient encounter session denied approval operation (403 CLINICAL_ACCESS_DENIED)");
      } else {
        recordTest("TEST-P5C-13", "Patient/device approval denied", "FAIL", `Expected 403 CLINICAL_ACCESS_DENIED, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-14: Approval exact-version binding
    // -------------------------------------------------------------------
    {
      // Doc is at version 1; supply stale expectedVersion: 99
      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: 99,
        action: "APPROVED"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      if (res.status === 409 && res.body?.error?.code === "VERSION_CONFLICT") {
        recordTest("TEST-P5C-14", "Approval exact-version binding", "PASS", "Stale expectedVersion=99 rejected with 409 VERSION_CONFLICT");
      } else {
        recordTest("TEST-P5C-14", "Approval exact-version binding", "FAIL", `Expected 409 VERSION_CONFLICT, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-15: Page edit creates new version and invalidates approval
    // -------------------------------------------------------------------
    {
      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/pages/1`, {
        expectedVersion: 1,
        extractedText: "Date: 15/05/2023\nDiagnosis: Type 2 Diabetes Mellitus, Essential Hypertension\nRx: Tab Metformin 1000mg OD\nSymptoms: Resolved"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const docAfter = await prisma.document.findUnique({
        where: { documentId: testDoc1.documentId }
      });

      if (res.status === 200 && res.body?.newVersion === 2 && docAfter.status === "pending_review") {
        recordTest("TEST-P5C-15", "Page edit creates new version and invalidates approval", "PASS", "Created complete version 2; Document.status reset to 'pending_review'");
      } else {
        recordTest("TEST-P5C-15", "Page edit creates new version and invalidates approval", "FAIL", `Expected v2 pending_review, got ${res.status}, v=${docAfter?.derivativeVersion}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-16: Stale version not RAG-eligible
    // -------------------------------------------------------------------
    {
      const reviewRes = await makeRequest("GET", `/api/documents/${testDoc1.documentId}/review`, null, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const isEligible = reviewRes.body?.isRAGEligible;
      const contractCheck = isDocumentRAGEligible(
        { status: reviewRes.body?.status, derivativeVersion: reviewRes.body?.currentVersion },
        reviewRes.body?.latestApproval
      );

      if (isEligible === false && contractCheck === false) {
        recordTest("TEST-P5C-16", "Stale version not RAG-eligible", "PASS", "isRAGEligible=false confirmed after page edit bumped version to v2");
      } else {
        recordTest("TEST-P5C-16", "Stale version not RAG-eligible", "FAIL", `isRAGEligible was true on unapproved v2`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-17: Fact edit creates DOCTOR_ENTERED lineage
    // -------------------------------------------------------------------
    let editedFactResult = null;
    {
      const v2Facts = await prisma.documentClinicalFact.findMany({
        where: { documentId: testDoc1.documentId, version: 2 },
        orderBy: { id: "asc" }
      });

      const targetFact = v2Facts[0];

      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/facts/${targetFact.id}`, {
        expectedVersion: 2,
        factKey: targetFact.factKey,
        factValue: "confirmed_severe",
        factType: targetFact.factType
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      editedFactResult = res.body?.fact;

      const v3Fact = await prisma.documentClinicalFact.findFirst({
        where: { documentId: testDoc1.documentId, version: 3, provenance: "DOCTOR_ENTERED" }
      });

      if (res.status === 200 && res.body?.newVersion === 3 && v3Fact?.parentFactId === targetFact.id) {
        recordTest("TEST-P5C-17", "Fact edit creates DOCTOR_ENTERED lineage", "PASS", `v3 fact created with provenance='DOCTOR_ENTERED', parentFactId=${targetFact.id}`);
      } else {
        recordTest("TEST-P5C-17", "Fact edit creates DOCTOR_ENTERED lineage", "FAIL", `Expected v3 DOCTOR_ENTERED, got status ${res.status}: ${JSON.stringify(res.body)}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-18: Fresh approval required after correction
    // -------------------------------------------------------------------
    {
      const approveV3 = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: 3,
        action: "APPROVED",
        comments: "Version 3 verified after fact correction"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const reviewRes = await makeRequest("GET", `/api/documents/${testDoc1.documentId}/review`, null, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      if (approveV3.status === 200 && reviewRes.body?.isRAGEligible === true && reviewRes.body?.status === "approved") {
        recordTest("TEST-P5C-18", "Fresh approval required after correction", "PASS", "Fresh approval on v3 accepted; isRAGEligible restored to true");
      } else {
        recordTest("TEST-P5C-18", "Fresh approval required after correction", "FAIL", `Approval status ${approveV3.status}, isRAGEligible: ${reviewRes.body?.isRAGEligible}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-19: Audit event coverage
    // -------------------------------------------------------------------
    {
      const auditActions = await prisma.auditLog.findMany({
        where: { patientUid: P1_UID },
        select: { action: true, actorType: true, actorUserId: true }
      });

      const actionNames = auditActions.map(a => a.action);
      const expectedActions = [
        "EXTRACT_CLINICAL_FACTS",
        "EDIT_DOCUMENT_PAGE",
        "EDIT_CLINICAL_FACT",
        "APPROVE_DOCUMENT",
        "INVALIDATE_DOCUMENT_APPROVAL"
      ];

      const allPresent = expectedActions.every(ea => actionNames.includes(ea));
      const doctorActor = auditActions.find(a => a.action === "EDIT_CLINICAL_FACT")?.actorUserId === docDoctor1User.id;

      if (allPresent && doctorActor) {
        recordTest("TEST-P5C-19", "Audit event coverage", "PASS", `Audit logs verified for ${expectedActions.join(", ")}; doctor actor ID bound`);
      } else {
        recordTest("TEST-P5C-19", "Audit event coverage", "FAIL", `Missing audit actions. Recorded: ${JSON.stringify(actionNames)}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-20: Browser zero-ID invariant + immutable original binary
    // -------------------------------------------------------------------
    {
      // 1. Invariant: reject patientUid in body
      const bodyReject = await makeRequest("POST", `/api/documents/${testDoc1.documentId}/extract`, {
        patientUid: P1_UID
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      // 2. Invariant: reject patientUid in query
      const queryReject = await makeRequest("GET", `/api/documents/${testDoc1.documentId}/facts?patientUid=${P1_UID}`, null, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      // 3. Binary hash integrity
      const currentBinary = fs.readFileSync(doc1BinaryPath);
      const currentHash = crypto.createHash("sha256").update(currentBinary).digest("hex");
      const binaryUntouched = currentHash === doc1InitialSha256;

      if (bodyReject.status === 400 && queryReject.status === 400 && binaryUntouched) {
        recordTest("TEST-P5C-20", "Browser zero-ID invariant + immutable original binary", "PASS", "Zero-ID injection rejected (400); original binary SHA-256 byte-identical");
      } else {
        recordTest("TEST-P5C-20", "Browser zero-ID invariant + immutable original binary", "FAIL", `Body reject: ${bodyReject.status}, Query reject: ${queryReject.status}, Binary untouched: ${binaryUntouched}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-21: Complete page snapshot after page edit
    // -------------------------------------------------------------------
    {
      const v1Pages = await prisma.documentPage.findMany({
        where: { documentId: testDoc1.documentId, version: 1 },
        orderBy: { pageNumber: "asc" }
      });
      const v2Pages = await prisma.documentPage.findMany({
        where: { documentId: testDoc1.documentId, version: 2 },
        orderBy: { pageNumber: "asc" }
      });

      const sameCount = v1Pages.length === 2 && v2Pages.length === 2;
      const p1Edited = v2Pages[0].extractedText.includes("1000mg");
      const p2Unchanged = v2Pages[1].extractedText === v1Pages[1].extractedText;

      if (sameCount && p1Edited && p2Unchanged) {
        recordTest("TEST-P5C-21", "Complete page snapshot after page edit", "PASS", "Version 2 contains all pages; page 1 updated, page 2 cloned forward identically");
      } else {
        recordTest("TEST-P5C-21", "Complete page snapshot after page edit", "FAIL", `Page snapshot mismatch: count=${v2Pages.length}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-22: Complete fact snapshot + historical immutability
    // -------------------------------------------------------------------
    {
      const v1Facts = await prisma.documentClinicalFact.findMany({
        where: { documentId: testDoc1.documentId, version: 1 }
      });
      const v2Facts = await prisma.documentClinicalFact.findMany({
        where: { documentId: testDoc1.documentId, version: 2 }
      });

      const v1Untouched = v1Facts.every(f => f.version === 1 && f.provenance !== "DOCTOR_ENTERED");
      const sameCount = v1Facts.length === v2Facts.length && v1Facts.length > 0;

      if (v1Untouched && sameCount) {
        recordTest("TEST-P5C-22", "Complete fact snapshot + historical immutability", "PASS", "Historical v1 facts unmodified; complete set copied forward into v2 snapshot");
      } else {
        recordTest("TEST-P5C-22", "Complete fact snapshot + historical immutability", "FAIL", `Fact snapshot counts: v1=${v1Facts.length}, v2=${v2Facts.length}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-23: Fact extraction idempotency
    // -------------------------------------------------------------------
    {
      // Put doc into pending_review at v3
      await prisma.document.update({
        where: { documentId: testDoc1.documentId },
        data: { status: "pending_review" }
      });

      const factsBefore = await prisma.documentClinicalFact.count({
        where: { documentId: testDoc1.documentId, version: 3 }
      });

      const res = await makeRequest("POST", `/api/documents/${testDoc1.documentId}/extract`, {}, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const factsAfter = await prisma.documentClinicalFact.count({
        where: { documentId: testDoc1.documentId, version: 3 }
      });

      if (res.status === 200 && res.body?.alreadyExtracted === true && factsBefore === factsAfter) {
        recordTest("TEST-P5C-23", "Fact extraction idempotency", "PASS", "Repeat extraction returned alreadyExtracted=true; duplicate rows prevented");
      } else {
        recordTest("TEST-P5C-23", "Fact extraction idempotency", "FAIL", `Status: ${res.status}, alreadyExtracted: ${res.body?.alreadyExtracted}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-24: Admin governance boundary
    // -------------------------------------------------------------------
    {
      // 1. Admin attempt to APPROVE is forbidden
      const adminApprove = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: 3,
        action: "APPROVED"
      }, {
        Cookie: `ms_user_session=${adminSession}`,
        "X-Admin-Access-Reason": "Admin attempting clinical approval"
      });

      // 2. Admin CAN reject with reason
      const adminReject = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: 3,
        action: "REJECTED",
        comments: "Unreadable or corrupted administrative record"
      }, {
        Cookie: `ms_user_session=${adminSession}`,
        "X-Admin-Access-Reason": "Authorized administrative quality rejection"
      });

      if (adminApprove.status === 403 && adminApprove.body?.error?.code === "CLINICAL_APPROVAL_REQUIRES_DOCTOR" && adminReject.status === 200) {
        recordTest("TEST-P5C-24", "Admin governance boundary", "PASS", "Admin APPROVED blocked (403 CLINICAL_APPROVAL_REQUIRES_DOCTOR); REJECTED allowed with audit reason");
      } else {
        recordTest("TEST-P5C-24", "Admin governance boundary", "FAIL", `Admin approve status: ${adminApprove.status}, admin reject status: ${adminReject.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-25: Stale page edit returns VERSION_CONFLICT
    // -------------------------------------------------------------------
    {
      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/pages/1`, {
        expectedVersion: 1, // doc is at version 3
        extractedText: "Stale edit attempt"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      if (res.status === 409 && res.body?.error?.code === "VERSION_CONFLICT") {
        recordTest("TEST-P5C-25", "Stale page edit returns VERSION_CONFLICT", "PASS", "Page edit with expectedVersion=1 on v3 document rejected with 409 VERSION_CONFLICT");
      } else {
        recordTest("TEST-P5C-25", "Stale page edit returns VERSION_CONFLICT", "FAIL", `Expected 409, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-26: Stale fact edit returns VERSION_CONFLICT
    // -------------------------------------------------------------------
    {
      const v3Facts = await prisma.documentClinicalFact.findMany({
        where: { documentId: testDoc1.documentId, version: 3 }
      });

      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/facts/${v3Facts[0].id}`, {
        expectedVersion: 2, // doc is at version 3
        factKey: "New Key",
        factValue: "New Value"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      if (res.status === 409 && res.body?.error?.code === "VERSION_CONFLICT") {
        recordTest("TEST-P5C-26", "Stale fact edit returns VERSION_CONFLICT", "PASS", "Fact edit with expectedVersion=2 on v3 document rejected with 409 VERSION_CONFLICT");
      } else {
        recordTest("TEST-P5C-26", "Stale fact edit returns VERSION_CONFLICT", "FAIL", `Expected 409, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-27: Stale approval returns VERSION_CONFLICT
    // -------------------------------------------------------------------
    {
      await prisma.document.update({
        where: { documentId: testDoc1.documentId },
        data: { status: "pending_review" }
      });

      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: 2, // doc is at version 3
        action: "APPROVED"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      if (res.status === 409 && res.body?.error?.code === "VERSION_CONFLICT") {
        recordTest("TEST-P5C-27", "Stale approval returns VERSION_CONFLICT", "PASS", "Approval with expectedVersion=2 on v3 document rejected with 409 VERSION_CONFLICT");
      } else {
        recordTest("TEST-P5C-27", "Stale approval returns VERSION_CONFLICT", "FAIL", `Expected 409, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-28: Concurrent edit race — one succeeds, one VERSION_CONFLICT
    // -------------------------------------------------------------------
    {
      // Both requests send expectedVersion: 3 simultaneously
      const p1 = makeRequest("PUT", `/api/documents/${testDoc1.documentId}/pages/1`, {
        expectedVersion: 3,
        extractedText: "Concurrent candidate A"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const p2 = makeRequest("PUT", `/api/documents/${testDoc1.documentId}/pages/1`, {
        expectedVersion: 3,
        extractedText: "Concurrent candidate B"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const [resA, resB] = await Promise.all([p1, p2]);
      const statuses = [resA.status, resB.status].sort();

      if (statuses[0] === 200 && statuses[1] === 409) {
        recordTest("TEST-P5C-28", "Concurrent edit race — one succeeds, one VERSION_CONFLICT", "PASS", "Race test: exactly one edit won (200 OK), competitor received 409 VERSION_CONFLICT");
      } else {
        recordTest("TEST-P5C-28", "Concurrent edit race — one succeeds, one VERSION_CONFLICT", "FAIL", `Statuses: ${JSON.stringify(statuses)}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-29: Snapshot transaction rollback leaves no partial version
    // -------------------------------------------------------------------
    {
      const currentDoc = await prisma.document.findUnique({
        where: { documentId: testDoc1.documentId }
      });
      const versionBefore = currentDoc.derivativeVersion;

      // Attempt editing non-existent page 999 inside transaction
      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/pages/999`, {
        expectedVersion: versionBefore,
        extractedText: "Will fail because page 999 does not exist"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const docAfter = await prisma.document.findUnique({
        where: { documentId: testDoc1.documentId }
      });
      const partialPages = await prisma.documentPage.findMany({
        where: { documentId: testDoc1.documentId, version: versionBefore + 1 }
      });

      if (res.status === 400 && docAfter.derivativeVersion === versionBefore && partialPages.length === 0) {
        recordTest("TEST-P5C-29", "Snapshot transaction rollback leaves no partial version", "PASS", `Rollback verified: version remains ${versionBefore}; 0 orphaned pages at v${versionBefore + 1}`);
      } else {
        recordTest("TEST-P5C-29", "Snapshot transaction rollback leaves no partial version", "FAIL", `Status: ${res.status}, vAfter: ${docAfter.derivativeVersion}, orphaned: ${partialPages.length}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-30: Admin clinical-fact editing denied
    // -------------------------------------------------------------------
    {
      const currentDoc = await prisma.document.findUnique({
        where: { documentId: testDoc1.documentId }
      });
      const fact = await prisma.documentClinicalFact.findFirst({
        where: { documentId: testDoc1.documentId, version: currentDoc.derivativeVersion }
      });

      const res = await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/facts/${fact.id}`, {
        expectedVersion: currentDoc.derivativeVersion,
        factKey: "Admin Attempt"
      }, {
        Cookie: `ms_user_session=${adminSession}`,
        "X-Admin-Access-Reason": "Admin trying to edit clinical fact"
      });

      if (res.status === 403 && res.body?.error?.code === "ADMIN_CANNOT_EDIT_CLINICAL_FACTS") {
        recordTest("TEST-P5C-30", "Admin clinical-fact editing denied", "PASS", "Admin denied fact editing (403 ADMIN_CANNOT_EDIT_CLINICAL_FACTS); clinical integrity preserved");
      } else {
        recordTest("TEST-P5C-30", "Admin clinical-fact editing denied", "FAIL", `Expected 403 ADMIN_CANNOT_EDIT_CLINICAL_FACTS, got ${res.status}`);
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-31: Historical source provenance remains immutable after approval
    // -------------------------------------------------------------------
    {
      const currentDoc = await prisma.document.findUnique({
        where: { documentId: testDoc1.documentId }
      });

      // Approve current version
      await prisma.document.update({
        where: { documentId: testDoc1.documentId },
        data: { status: "pending_review" }
      });

      await makeRequest("PUT", `/api/documents/${testDoc1.documentId}/approve`, {
        expectedVersion: currentDoc.derivativeVersion,
        action: "APPROVED"
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      // Query database directly to verify fact.provenance was NOT mutated to DOCTOR_APPROVED
      const facts = await prisma.documentClinicalFact.findMany({
        where: { documentId: testDoc1.documentId, version: currentDoc.derivativeVersion }
      });

      const noMutatedProvenance = facts.every(f => f.provenance !== "DOCTOR_APPROVED");
      const hasOriginalTaxonomy = facts.every(f => ["DOCUMENT_EXTRACTED", "OCR_EXTRACTED", "DOCTOR_ENTERED"].includes(f.provenance));

      if (noMutatedProvenance && hasOriginalTaxonomy) {
        recordTest("TEST-P5C-31", "Historical source provenance remains immutable after approval", "PASS", "Provenance taxonomy preserved; facts retain DOCUMENT_EXTRACTED/OCR_EXTRACTED/DOCTOR_ENTERED");
      } else {
        recordTest("TEST-P5C-31", "Historical source provenance remains immutable after approval", "FAIL", "Provenance mutated or corrupted");
      }
    }

    // -------------------------------------------------------------------
    // TEST-P5C-32: Fact removal/void creates valid next snapshot without deleting history
    // -------------------------------------------------------------------
    {
      const currentDoc = await prisma.document.findUnique({
        where: { documentId: testDoc1.documentId }
      });
      const vCurrentFacts = await prisma.documentClinicalFact.findMany({
        where: { documentId: testDoc1.documentId, version: currentDoc.derivativeVersion },
        orderBy: { id: "asc" }
      });

      const factToRemove = vCurrentFacts[0];
      const countBefore = vCurrentFacts.length;

      const res = await makeRequest("DELETE", `/api/documents/${testDoc1.documentId}/facts/${factToRemove.id}`, {
        expectedVersion: currentDoc.derivativeVersion
      }, {
        Cookie: `ms_user_session=${doctor1Session}`
      });

      const nextVersion = res.body?.newVersion;
      const vNextFacts = await prisma.documentClinicalFact.findMany({
        where: { documentId: testDoc1.documentId, version: nextVersion }
      });

      // Verify prior fact still exists in historical database record
      const historicalFactStillExists = await prisma.documentClinicalFact.findUnique({
        where: { id: factToRemove.id }
      });

      const omittedFromNext = !vNextFacts.some(f => f.factKey === factToRemove.factKey && f.factValue === factToRemove.factValue);
      const auditLog = await prisma.auditLog.findFirst({
        where: { patientUid: P1_UID, action: "REMOVE_CLINICAL_FACT" }
      });

      if (res.status === 200 && vNextFacts.length === countBefore - 1 && omittedFromNext && historicalFactStillExists && auditLog) {
        recordTest("TEST-P5C-32", "Fact removal/void creates valid next snapshot without deleting history", "PASS", `v${nextVersion} created with ${vNextFacts.length} facts (omitted removed fact); historical row ${factToRemove.id} preserved intact`);
      } else {
        recordTest("TEST-P5C-32", "Fact removal/void creates valid next snapshot without deleting history", "FAIL", `Status: ${res.status}, vNextCount: ${vNextFacts.length}, historicalExists: ${Boolean(historicalFactStillExists)}`);
      }
    }

  } catch (err) {
    console.error("\n[FATAL_TEST_ERROR]", err);
  } finally {
    // Teardown
    if (serverInstance) {
      serverInstance.close();
    }
    await disconnectPrisma();

    console.log("\n=======================================================");
    console.log("PHASE 5C TEST SUMMARY");
    console.log("=======================================================");
    const passed = results.filter(r => r.status === "PASS").length;
    const failed = results.filter(r => r.status === "FAIL").length;
    const pending = results.filter(r => r.status === "PENDING_INFRA").length;
    console.log(`Total Tests: ${results.length} | Passed: ${passed} | Failed: ${failed} | Pending Infra: ${pending}\n`);

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

// Start temporary test server
serverInstance = app.listen(0, async () => {
  TEST_PORT = serverInstance.address().port;
  await setupFixtures();
  await runTests();
});
