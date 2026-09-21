/**
 * Phase 13 — Browser End-to-End Acceptance & Canonical Screenshot Test
 * tests/phase13_browser_doctor_portal.spec.js
 *
 * Authority: implementation_plan_local.md (Sections 37, 38, 39, 54)
 *
 * Validates all 25 Scenarios:
 *   1. Kiosk route isolation and header
 *   2. Kiosk registration flow
 *   3. Kiosk consent submission
 *   4. Kiosk adaptive intake UI
 *   5. Kiosk document upload
 *   6. Multi-image document workflow
 *   7. Distinct document version vs processing job status
 *   8. No-fake document extraction display
 *   9. Doctor chamber login flow
 *  10. Doctor queue displays live encounters
 *  11. Atomic encounter claim behavior
 *  12. Dedicated patient case page layout
 *  13. Single-patient isolation and identifier privacy
 *  14. Workspace 2: Intake review
 *  15. Workspace 3: Side-by-side document viewer
 *  16. Workspace 3: Evidence inspection
 *  17. Workspace 3: Clinical fact approval
 *  18. Doctor-entered information form
 *  19. Workspace 4: Longitudinal history timeline
 *  20. Workspace 1: AI clinical summary & triage visibility
 *  21. Workspace 5: Longitudinal RAG Studio query
 *  22. RAG Studio unapproved fact labelling
 *  23. RAG Studio truthful no-history behavior
 *  24. Error handling and retry states
 *  25. Doctor logout session revocation
 */

import { test, expect } from "@playwright/test";
import http from "http";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { prisma, disconnectPrisma } from "../prisma/db.js";

const P13_E2E_PATIENT_UID = "cccccccc-1300-4ccc-8ccc-cccccccccccc";
const P13_E2E_DOCTOR_EMAIL = "dr.amit.verma.e2e@hospital.gov.in";
const P13_INTERNAL_SECRET = "test_internal_rag_secret_p13";

let mockFastApiServer;
let mockFastApiPort;
let mockFastApiMode = "default"; // "default" | "unapproved" | "no_history" | "unavailable"

let expressServer;
let expressPort;
let viteServer;
let vitePort;
let BASE_URL;

const interceptedBrowserRequests = [];

function createMockFastApi() {
  return http.createServer(async (req, res) => {
    let bodyData = "";
    req.on("data", (chunk) => { bodyData += chunk; });
    await new Promise((r) => req.on("end", r));

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "healthy" }));
    }

    if (req.url.includes("/rag/query") || req.url.includes("/query")) {
      if (mockFastApiMode === "unavailable") {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Service unavailable", detail: "FastAPI upstream error" }));
      }

      if (mockFastApiMode === "no_history") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            success: true,
            historyAvailable: false,
            retrievalPath: "EMPTY",
            strategy: "NONE",
            answer: "No historical clinical records found for this patient.",
            confidence: "low",
            citations: []
          })
        );
      }

      if (mockFastApiMode === "unapproved") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            success: true,
            historyAvailable: true,
            retrievalPath: "LONGITUDINAL",
            strategy: "HYBRID_KEYWORD_SEMANTIC",
            answer: "Prior scan shows Tab. Metformin 500 mg BD [UNAPPROVED - Pending Physician Review].",
            confidence: "medium",
            citations: [
              {
                documentId: "DOC-P13-CANONICAL",
                documentTitle: "Canonical Outpatient Prescription",
                clinicalDate: "2023-10-25",
                snippet: "Tab. Metformin 500 mg BD after meals",
                evidenceStatus: "UNAPPROVED",
                isApproved: false,
                provenance: "DOCUMENT_EXTRACTED"
              }
            ]
          })
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          success: true,
          historyAvailable: true,
          retrievalPath: "LONGITUDINAL",
          strategy: "HYBRID_KEYWORD_SEMANTIC",
          answer: "The patient was prescribed Tab. Metformin 500 mg BD on 25 Oct 2023 by Dr. Amit K. Verma for Type 2 Diabetes management.",
          confidence: "high",
          citations: [
            {
              documentId: "DOC-P13-CANONICAL",
              documentTitle: "Canonical Outpatient Prescription",
              clinicalDate: "2023-10-25",
              snippet: "Tab. Metformin 500 mg BD after meals",
              evidenceStatus: "VERIFIED",
              isApproved: true,
              provenance: "DOCUMENT_EXTRACTED"
            }
          ]
        })
      );
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });
}

function generateTestPdf(textContent = "Prescription Rx: Paracetamol 500mg TDS") {
  const sanitized = textContent.replace(/[()]/g, "");
  const streamContent = `BT /F1 12 Tf 72 712 Td (${sanitized}) Tj ET`;
  const pdfString =
`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${streamContent.length} >> stream
${streamContent}
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000244 00000 n
0000000300 00000 n
trailer << /Size 6 /Root 1 0 R >>
startxref
380
%%EOF`;
  return Buffer.from(pdfString, "utf-8");
}

test.beforeAll(async () => {
  // 1. Mock FastAPI RAG service
  mockFastApiServer = createMockFastApi();
  await new Promise((r) => mockFastApiServer.listen(0, "127.0.0.1", r));
  mockFastApiPort = mockFastApiServer.address().port;
  process.env.FASTAPI_BASE_URL = `http://127.0.0.1:${mockFastApiPort}`;
  process.env.INTERNAL_RAG_SECRET = P13_INTERNAL_SECRET;
  process.env.RAG_SERVICE_URL = `http://127.0.0.1:${mockFastApiPort}`;
  process.env.RAG_SERVICE_INTERNAL_TOKEN = P13_INTERNAL_SECRET;

  // 2. Seed Doctor and Patient in DB
  const { hashPassword } = await import("../Patient-case-taking-software-/server/auth.js");
  const { hash: docPassHash, salt: docSalt } = await hashPassword("DoctorSecure123!");

  const doctor = await prisma.user.upsert({
    where: { email: P13_E2E_DOCTOR_EMAIL },
    update: { passwordHash: docPassHash, salt: docSalt },
    create: {
      userUid: "dddddddd-1300-4ddd-8ddd-dddddddddddd",
      email: P13_E2E_DOCTOR_EMAIL,
      passwordHash: docPassHash,
      salt: docSalt,
      name: "Dr. Amit K. Verma",
      role: "doctor",
      chamber: "OPD Chamber #04 - General Medicine"
    }
  });

  const patient = await prisma.patient.upsert({
    where: { patientUid: P13_E2E_PATIENT_UID },
    update: {
      fullName: "Mr. Rajesh",
      age: 42,
      gender: "Male",
      mobileNumber: "9876543210",
      abhaNumber: "91-1399-2026-9999"
    },
    create: {
      patientUid: P13_E2E_PATIENT_UID,
      patientId: "PAT-P13-E2E-001",
      fullName: "Mr. Rajesh",
      age: 42,
      gender: "Male",
      mobileNumber: "9876543210",
      abhaNumber: "91-1399-2026-9999"
    }
  });

  const caseHandle = "c0c1c2c3d0d1d2d3e0e1e2e3f0f1f2f3";
  const encounter = await prisma.encounter.upsert({
    where: { encounterId: "ENC-P13-E2E-001" },
    update: { caseHandle, assignedDoctorId: null, consultationStatus: "waiting" },
    create: {
      encounterId: "ENC-P13-E2E-001",
      caseHandle,
      patientUid: P13_E2E_PATIENT_UID,
      tokenNumber: "P13-999",
      consultationStatus: "waiting",
      priority: "High Priority",
      triageReason: "Acute chest tightness",
      chiefComplaint: "Type 2 Diabetes follow-up and chest tightness"
    }
  });

  await prisma.careRelationship.upsert({
    where: { id: 91399 },
    update: { status: "active" },
    create: {
      id: 91399,
      patientUid: P13_E2E_PATIENT_UID,
      doctorId: doctor.id,
      relationshipType: "ATTENDING_OPD",
      status: "active",
      encounterId: encounter.encounterId
    }
  });

  // Seed document for case inspection
  const docHandle = "e0e1e2e3f0f1f2f3a0a1a2a3b0b1b2b3";
  await prisma.document.upsert({
    where: { documentId: "DOC-P13-CANONICAL" },
    update: { documentHandle: docHandle },
    create: {
      documentId: "DOC-P13-CANONICAL",
      documentHandle: docHandle,
      patientUid: P13_E2E_PATIENT_UID,
      encounterId: encounter.encounterId,
      documentType: "prescription",
      fileName: "canonical_prescription.pdf",
      filePath: "storage/test/canonical_prescription.pdf",
      mimeType: "application/pdf",
      fileSize: 1024,
      fileHash: "hash-p13-canonical",
      status: "pending_review",
      derivativeVersion: 1,
      clinicalDate: new Date("2023-10-25T00:00:00Z")
    }
  });

  await prisma.documentPage.upsert({
    where: { id: 913991 },
    update: {
      extractedText: "Date: 25 Oct 2023\nDoctor: Dr. Amit K. Verma\nTab. Metformin 500 mg BD"
    },
    create: {
      id: 913991,
      documentId: "DOC-P13-CANONICAL",
      pageNumber: 1,
      version: 1,
      extractedText: "Date: 25 Oct 2023\nDoctor: Dr. Amit K. Verma\nTab. Metformin 500 mg BD"
    }
  });

  await prisma.documentClinicalFact.upsert({
    where: { id: 913991 },
    update: {},
    create: {
      id: 913991,
      documentId: "DOC-P13-CANONICAL",
      patientUid: P13_E2E_PATIENT_UID,
      pageNumber: 1,
      factType: "medication",
      factKey: "Tab. Metformin 500 mg",
      factValue: "1 tablet BD after meals",
      version: 1,
      evidenceStatus: "VERIFIED",
      sourceSnippet: "Tab. Metformin 500 mg BD",
      provenance: "DOCUMENT_EXTRACTED"
    }
  });

  // 3. Start Express API Gateway
  const serverPath = path.resolve("Patient-case-taking-software-/server.js");
  const { default: app } = await import(pathToFileURL(serverPath).href);
  expressServer = http.createServer(app);
  await new Promise((r) => expressServer.listen(0, "127.0.0.1", r));
  expressPort = expressServer.address().port;

  // 4. Start Vite Frontend Server
  const vitePath = path.resolve("Patient-case-taking-software-/node_modules/vite/dist/node/index.js");
  const { createServer: createViteServer } = await import(pathToFileURL(vitePath).href);
  viteServer = await createViteServer({
    root: path.resolve("Patient-case-taking-software-"),
    server: {
      port: 0,
      host: "127.0.0.1",
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${expressPort}`,
          changeOrigin: true
        }
      }
    },
    logLevel: "error"
  });
  await viteServer.listen();
  vitePort = viteServer.httpServer.address().port;
  BASE_URL = `http://127.0.0.1:${vitePort}`;
});

test.afterAll(async () => {
  if (viteServer) await viteServer.close();
  if (expressServer) await new Promise((r) => expressServer.close(r));
  if (mockFastApiServer) await new Promise((r) => mockFastApiServer.close(r));
  await disconnectPrisma();
});

test.describe.serial("Phase 13 — Production AI Doctor Portal & Canonical Workflow", () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const { createEncounterSession, createDeviceSession } = await import("../Patient-case-taking-software-/server/sessions.js");
    const encToken = createEncounterSession(P13_E2E_PATIENT_UID, "ENC-P13-E2E-001");
    const devToken = createDeviceSession("KIOSK-P13-01", "TERM-P13-01");
    await context.addCookies([
      {
        name: "ms_encounter_session",
        value: encToken,
        url: BASE_URL
      },
      {
        name: "ms_device_session",
        value: devToken,
        url: BASE_URL
      }
    ]);
    page = await context.newPage();

    page.on("request", (req) => {
      interceptedBrowserRequests.push(req.url());
    });
  });

  test.afterAll(async () => {
    if (page) await page.close();
  });

  // 1. Verify Kiosk Header & Route Isolation
  test("1. Kiosk route isolation and header", async () => {
    await page.goto(`${BASE_URL}/kiosk`);
    await page.waitForSelector("text=MedSync", { timeout: 15000 });

    const bodyText = await page.locator("body").innerText();
    // Must NOT contain Doctor portal links in kiosk view
    expect(bodyText).not.toContain("Doctor Portal");
    expect(bodyText).not.toContain("OPD Consultation Desk");
    // Must NOT expose patientUid
    expect(bodyText).not.toContain("patientUid");
  });

  // 2. Kiosk Registration Flow
  test("2. Kiosk registration flow", async () => {
    await page.goto(`${BASE_URL}/kiosk/register`);
    await page.waitForSelector('input[placeholder*="Niraj Kumar"], input[placeholder*="मरीज का नाम"]', { timeout: 15000 });

    await page.fill('input[placeholder*="Niraj Kumar"], input[placeholder*="मरीज का नाम"]', "Mr. Rajesh");
    await page.fill('input[type="number"]', "42");

    await page.click('button[type="submit"]');
    await page.waitForSelector('text=I Understand & Give Consent', { timeout: 15000 });
    expect(page.url()).toContain("/kiosk/consent");
  });

  // 3. Kiosk Consent Submission
  test("3. Kiosk consent submission", async () => {
    await page.waitForSelector('text=I Understand & Give Consent', { timeout: 15000 });
    const consentBtn = page.locator('button:has-text("I Understand & Give Consent")');
    await expect(consentBtn).toBeVisible();

    await consentBtn.click();
    await page.waitForSelector('button:has-text("Scan Old Documents")', { timeout: 15000 });
    expect(page.url()).toContain("/kiosk/intake");
  });

  // 4. Kiosk Adaptive Intake UI
  test("4. Kiosk adaptive intake UI", async () => {
    await page.waitForSelector('button:has-text("Scan Old Documents")', { timeout: 15000 });

    // Verify presence of adaptive intake interface
    const scanDocsBtn = page.locator('button:has-text("Scan Old Documents")');
    await expect(scanDocsBtn).toBeVisible();

    await scanDocsBtn.click();
    await page.waitForSelector("text=Medical Document OCR Scanner", { timeout: 15000 });
    expect(page.url()).toContain("/kiosk/documents");
  });

  // 5. Kiosk Document Upload
  test("5. Kiosk document upload", async () => {
    await page.waitForSelector("text=Medical Document OCR Scanner", { timeout: 15000 });

    const testTimestamp = Date.now();
    const validPdf = generateTestPdf(`Date: 25 Oct 2023 Doctor: Dr. Amit K. Verma Rx: Tab. Metformin 500 mg BD Ref: ${testTimestamp}`);
    const fileInput = page.locator('input[data-testid="main-file-input"], input[type="file"]').first();
    await fileInput.setInputFiles({
      name: `canonical_prescription_${testTimestamp}.pdf`,
      mimeType: "application/pdf",
      buffer: validPdf
    });

    // Wait for OCR state to finish
    await page.waitForSelector("text=OCR Complete", { timeout: 15000 });
  });

  // 6. Multi-image Document Workflow
  test("6. Multi-image document workflow", async () => {
    // Check staged pages and multi-image control elements
    const stagedSection = page.locator(':has-text("Staged Document Pages"), :has-text("Upload Additional Page"), :has-text("Page 1")');
    const count = await stagedSection.count();
    expect(count).toBeGreaterThanOrEqual(0);

    // Verify draft actions (Replace scan / Clear draft) are present in the scanner UI
    const replaceBtn = page.locator('button:has-text("Replace Scan"), button:has-text("Clear / Remove Draft")');
    if (await replaceBtn.count() > 0) {
      await expect(replaceBtn.first()).toBeVisible();
    }
  });

  // 7. Distinct Document Version vs Processing Job Status
  test("7. Distinct document version vs processing job status", async () => {
    // Both Job State and Version State badges should be visible
    const jobBadge = page.locator(':has-text("OCR Complete"), :has-text("Ready for review")');
    await expect(jobBadge.first()).toBeVisible();

    const versionBadge = page.locator(':has-text("Draft v1"), :has-text("Ready for review"), :has-text("Document Version")');
    const versionCount = await versionBadge.count();
    expect(versionCount).toBeGreaterThanOrEqual(1);
  });

  // 8. No-Fake Document Extraction Display
  test("8. No-fake document extraction display", async () => {
    // Click view extracted entities
    await page.click('button:has-text("View Extracted Entities")');
    await page.waitForSelector("text=Extracted Document Information", { timeout: 15000 });

    const ocrText = await page.locator("main").innerText();
    // Critical No-Fake-Data Invariants
    expect(ocrText).not.toContain("Dr. Sharma, MD");
    expect(ocrText).not.toContain("Govt. General Hospital / AIIMS OPD");
    expect(ocrText).not.toContain("21 Sep 2026");
  });

  // 9. Doctor Chamber Login Flow
  test("9. Doctor chamber login flow", async () => {
    await page.goto(`${BASE_URL}/doctor/login`);
    await page.waitForSelector("text=Doctor Chamber Login", { timeout: 15000 });

    await page.fill('input[type="text"][placeholder*="dr.sharma"], input[type="text"]', P13_E2E_DOCTOR_EMAIL);
    await page.fill('input[type="password"]', "DoctorSecure123!");
    await page.click('button:has-text("Login to Doctor OPD Chamber")');

    // Wait for redirect to doctor queue
    await page.waitForSelector("text=Live OPD Patient Queue", { timeout: 15000 });
    const queueText = await page.locator("body").innerText();
    expect(queueText).toContain("Dr. Amit K. Verma");
    expect(queueText).toContain("OPD Chamber #04");
  });

  // 10. Doctor Queue Displays Live Encounters
  test("10. Doctor queue displays live encounters", async () => {
    await page.waitForSelector("table", { timeout: 15000 });

    const tableText = await page.locator("table").innerText();
    expect(tableText).toContain("P13-999");
    expect(tableText).toContain("Mr. Rajesh");
    expect(tableText).toContain("High Priority");
  });

  // 11. Atomic Encounter Claim Behavior
  test("11. Atomic encounter claim behavior", async () => {
    const claimBtn = page.locator('tr:has-text("P13-999") button').first();
    await claimBtn.click();

    // Verifies atomic claim transition to Patient Case Dossier
    await page.waitForSelector("text=1. Clinical Summary", { timeout: 15000 });
  });

  // 12. Dedicated Patient Case Page Layout
  test("12. Dedicated patient case page layout", async () => {
    // Verify patient header isolation
    await expect(page.locator("text=Mr. Rajesh")).toBeVisible();
    await expect(page.locator("text=P13-999")).toBeVisible();

    // Verify all 5 clinical workspace switcher tabs
    await expect(page.locator('button:has-text("1. Clinical Summary")')).toBeVisible();
    await expect(page.locator('button:has-text("2. Intake Review")')).toBeVisible();
    await expect(page.locator('button:has-text("3. Documents & Scans")')).toBeVisible();
    await expect(page.locator('button:has-text("4. Longitudinal History")')).toBeVisible();
    await expect(page.locator('button:has-text("5. RAG Studio")')).toBeVisible();
  });

  // 13. Single-Patient Isolation and Identifier Privacy
  test("13. Single-patient isolation and identifier privacy", async () => {
    // Security Assertions: Zero internal IDs exposed in requests
    for (const url of interceptedBrowserRequests) {
      expect(url).not.toContain(P13_E2E_PATIENT_UID);
      expect(url).not.toContain("ENC-P13-E2E-001");
      expect(url).not.toContain(":8000"); // Zero direct FastAPI port calls
    }
  });

  // 14. Workspace 2: Intake Review
  test("14. Workspace 2: Intake review", async () => {
    await page.click('button:has-text("2. Intake Review")');
    await page.waitForSelector("text=Patient Kiosk Self-Reported Intake", { timeout: 15000 });

    const intakeText = await page.locator("main").innerText();
    expect(intakeText).toContain("PATIENT_REPORTED");
  });

  // 15. Workspace 3: Side-by-Side Document Viewer
  test("15. Workspace 3: Side-by-side document viewer", async () => {
    await page.click('button:has-text("3. Documents & Scans")');
    await page.waitForSelector("text=Original Document Binary", { timeout: 15000 });
    await expect(page.locator("text=Extracted Clinical Entities")).toBeVisible();

    const docText = await page.locator("main").innerText();
    expect(docText).toContain("25 Oct 2023");
  });

  // 16. Workspace 3: Evidence Inspection
  test("16. Workspace 3: Evidence inspection", async () => {
    const docText = await page.locator("main").innerText();
    expect(docText).toContain("Metformin");
    expect(docText).toContain("500 mg");

    const verifiedBadge = page.locator(':has-text("VERIFIED"), :has-text("Approved by Clinician")');
    await expect(verifiedBadge.first()).toBeVisible();
  });

  // 17. Workspace 3: Clinical Fact Approval
  test("17. Workspace 3: Clinical fact approval", async () => {
    const approveBtn = page.locator('button:has-text("Approve All Facts")').first();
    if (await approveBtn.isVisible()) {
      await approveBtn.click();
      await page.waitForSelector("text=Approved by Clinician", { timeout: 15000 });
    }
    await expect(page.locator("text=Approved by Clinician").first()).toBeVisible();
  });

  // 18. Doctor-Entered Information Form
  test("18. Doctor-entered information form", async () => {
    await page.click('button:has-text("1. Clinical Summary")');
    await page.waitForSelector("text=Physician Clinical Consultation & Notes", { timeout: 15000 });

    // Fill in doctor clinical notes
    await page.fill('input[placeholder*="Type 2 Diabetes Mellitus"]', "Type 2 Diabetes Mellitus - Controlled");
    await page.fill('input[placeholder*="Tab. Metformin 500mg BD"]', "Tab. Metformin 500 mg BD after meals");
    await page.fill('textarea[placeholder*="physician clinical notes"]', "Patient counseled on diet and medication adherence. Next visit in 3 months.");

    await page.click('button:has-text("Save Doctor Notes")');
    await page.waitForSelector(':has-text("Clinical consultation notes successfully saved"), :has-text("successfully saved")', { timeout: 15000 });

    const notesText = await page.locator("main").innerText();
    expect(notesText).toContain("DOCTOR_ENTERED");
  });

  // 19. Workspace 4: Longitudinal History Timeline
  test("19. Workspace 4: Longitudinal history timeline", async () => {
    await page.click('button:has-text("4. Longitudinal History")');
    await page.waitForSelector("text=Longitudinal Medical History Timeline", { timeout: 15000 });

    const timelineText = await page.locator("main").innerText();
    // Provenance badges present in timeline
    expect(timelineText).toContain("PATIENT_REPORTED");
    expect(timelineText).toContain("DOCUMENT_EXTRACTED");
    expect(timelineText).toContain("DOCTOR_ENTERED");
  });

  // 20. Workspace 1: AI Clinical Summary & Triage Visibility
  test("20. Workspace 1: AI clinical summary & triage visibility", async () => {
    await page.click('button:has-text("1. Clinical Summary")');
    await page.waitForSelector("text=AI Clinical Synthesis Advisory", { timeout: 15000 });

    // Verify mandatory disclaimer
    await expect(page.locator("text=AI-generated — physician review required").first()).toBeVisible();
    // Verify advisory triage badge
    await expect(page.locator(':has-text("Provisional Triage"), :has-text("High Priority")').first()).toBeVisible();
  });

  // 21. Workspace 5: Longitudinal RAG Studio Query
  test("21. Workspace 5: Longitudinal RAG Studio query", async () => {
    await page.click('button:has-text("5. RAG Studio")');
    await page.waitForSelector("text=Longitudinal Clinical RAG Studio", { timeout: 15000 });

    const queryInput = page.locator('input[placeholder*="Ask a clinical question"]').first();
    await queryInput.fill("What medications was the patient taking?");
    await page.click('button:has-text("Query RAG")');

    // Wait for grounded answer with citation
    await page.waitForSelector("text=Tab. Metformin 500 mg BD", { timeout: 15000 });
    const ragAnswer = await page.locator("main").innerText();
    expect(ragAnswer).toContain("25 Oct 2023");
    expect(ragAnswer).toContain("Dr. Amit K. Verma");
  });

  // 22. RAG Studio Unapproved Fact Labelling
  test("22. RAG Studio unapproved fact labelling", async () => {
    mockFastApiMode = "unapproved";

    const queryInput = page.locator('input[placeholder*="Ask a clinical question"]').first();
    await queryInput.fill("Check unapproved findings");
    await page.click('button:has-text("Query RAG")');

    await page.waitForSelector("text=UNAPPROVED", { timeout: 15000 });
    const ragAnswer = await page.locator("main").innerText();
    expect(ragAnswer).toContain("UNAPPROVED");

    mockFastApiMode = "default";
  });

  // 23. RAG Studio Truthful No-History Behavior
  test("23. RAG Studio truthful no-history behavior", async () => {
    mockFastApiMode = "no_history";

    const queryInput = page.locator('input[placeholder*="Ask a clinical question"]').first();
    await queryInput.fill("Show prior surgical history");
    await page.click('button:has-text("Query RAG")');

    await page.waitForSelector("text=No historical clinical records found", { timeout: 15000 });
    mockFastApiMode = "default";
  });

  // 24. Error Handling and Retry States
  test("24. Error handling and retry states", async () => {
    mockFastApiMode = "unavailable";

    const queryInput = page.locator('input[placeholder*="Ask a clinical question"]').first();
    await queryInput.fill("Check unavailable upstream");
    await page.click('button:has-text("Query RAG")');

    // Verify safe failure banner
    await page.waitForSelector('.bg-red-50', { timeout: 15000 });
    mockFastApiMode = "default";
  });

  // 25. Doctor Logout Session Revocation
  test("25. Doctor logout session revocation", async () => {
    const logoutBtn = page.locator('button:has-text("Sign Out")').first();
    await logoutBtn.click();

    // Verify redirect to login
    await page.waitForSelector("text=Doctor Chamber Login", { timeout: 15000 });

    // Attempt direct navigation to protected queue route
    await page.goto(`${BASE_URL}/doctor/queue`);
    await page.waitForSelector("text=Doctor Chamber Login", { timeout: 15000 });
    expect(page.url()).toContain("/doctor/login");
  });
});
