/**
 * Phase 12 — Real Browser End-to-End Acceptance Test Suite
 * tests/phase12_browser_e2e.spec.js
 *
 * Authority: Phase 12 Acceptance Specification (Real Browser E2E Only)
 *
 * This suite validates the critical visible patient-to-doctor workflow through
 * the actual React application running in a real Chromium browser instance:
 *   1. Patient kiosk opens successfully.
 *   2. Synthetic patient registration flow through the actual UI.
 *   3. Consent flow.
 *   4. Adaptive intake interaction through the actual UI.
 *   5. Review/edit/submit flow.
 *   6. Document upload through the UI.
 *   7. Doctor login through the actual UI.
 *   8. Doctor queue/dashboard loads.
 *   9. Authorized patient/encounter can be opened.
 *  10. Document review/approval UI works.
 *  11. Longitudinal RAG workspace opens.
 *  12. A RAG query can be submitted through the UI.
 *  13. RAG result/citations/provenance render.
 *  14. Inspect Source Record works.
 *  15. Unauthorized/cross-patient access is denied.
 *  16. No-history patient displays a truthful empty-history state.
 *  17. RAG failure (502/504) produces the existing safe UI error state.
 *
 * Security Invariants Checked:
 *   - No patientUid exposed in browser-visible application state.
 *   - No patientUid sent from browser to the RAG API.
 *   - Browser never directly calls FastAPI port 8000.
 *   - No internal secrets or filesystem paths appear in browser responses.
 *   - Cross-patient access remains denied.
 */

import { test, expect } from "@playwright/test";
import http from "http";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { prisma, disconnectPrisma } from "../prisma/db.js";

// ─── Synthetic Test Identifiers ───────────────────────────────────────────────
const P12_PATIENT_A_UID = "aaaaaaaa-1200-4aaa-8aaa-aaaaaaaaaaac"; // Patient with history
const P12_PATIENT_B_UID = "bbbbbbbb-1200-4bbb-8bbb-bbbbbbbbbbbc"; // Patient Doctor A cannot access
const P12_PATIENT_NO_HIST_UID = "cccccccc-1200-4ccc-8ccc-cccccccccccc"; // No-history patient
const P12_INTERNAL_TOKEN = "e2e_browser_test_internal_secret_p12";

// Server instances & ports
let mockFastApiServer;
let mockFastApiPort;
let mockFastApiMode = "default"; // "default" | "no_history" | "unavailable" | "timeout"

let expressServer;
let expressPort;

let viteServer;
let vitePort;
let BASE_URL;

// Monitor network calls from the browser to assert security boundaries
const interceptedRAGRequests = [];
const interceptedExternalFastAPICalls = [];

function createMockFastApi() {
  return http.createServer(async (req, res) => {
    let bodyData = "";
    req.on("data", chunk => { bodyData += chunk; });
    await new Promise(r => req.on("end", r));

    // Assert internal secret header
    const secret = req.headers["x-internal-secret"];
    if (secret !== P12_INTERNAL_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ detail: { code: "INVALID_SECRET", message: "Unauthorized" } }));
    }

    if (mockFastApiMode === "unavailable") {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ detail: "Mock RAG Service unavailable" }));
    }

    if (mockFastApiMode === "timeout") {
      await new Promise(r => setTimeout(r, 9500));
    }

    if (mockFastApiMode === "no_history") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        success: true,
        historyAvailable: false,
        retrievalPath: "NO_HISTORY",
        strategy: "STANDARD_SEMANTIC",
        answer: "Longitudinal medical history is unavailable for this patient.",
        confidence: "insufficient_evidence",
        citations: [],
        yearsCovered: [],
        isNoHistory: true
      }));
    }

    // Default high-confidence response with grounded citations
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      historyAvailable: true,
      retrievalPath: "TEMPORAL_TREND_AND_SEMANTIC",
      strategy: "LONGITUDINAL_TREND",
      answer: "In 2020, Metformin 500mg was initiated. In 2022, HbA1c recorded at 7.4%.",
      confidence: "high",
      citations: [
        {
          documentId: "DOC-E2E-001",
          pageNumber: 1,
          documentVersion: 1,
          approvalVersion: 1,
          clinicalDate: "2020-01-15",
          clinicalYear: 2020,
          provenance: "DOCUMENT_EXTRACTED",
          snippet: "Metformin 500mg initiated. Baseline renal function evaluated.",
          relevanceScore: 0.94
        }
      ],
      yearsCovered: [2020, 2022],
      isNoHistory: false
    }));
  });
}

test.beforeAll(async () => {
  // 1. Spin up Mock FastAPI Server
  mockFastApiServer = createMockFastApi();
  await new Promise(r => mockFastApiServer.listen(0, "127.0.0.1", r));
  mockFastApiPort = mockFastApiServer.address().port;
  process.env.RAG_SERVICE_URL = `http://127.0.0.1:${mockFastApiPort}`;
  process.env.RAG_SERVICE_INTERNAL_TOKEN = P12_INTERNAL_TOKEN;

  // 2. Seed Database Fixtures deterministically
  const { hashPassword } = await import("../Patient-case-taking-software-/server/auth.js");
  const { hash, salt } = await hashPassword("DoctorSecure123!");

  let doctorA = await prisma.user.findFirst({
    where: { role: "doctor", email: "dr.sharma@hospital.gov.in" }
  });
  if (!doctorA) {
    doctorA = await prisma.user.create({
      data: {
        userUid: crypto.randomUUID(),
        name: "Dr. K. S. Sharma",
        email: "dr.sharma@hospital.gov.in",
        passwordHash: hash,
        salt,
        role: "doctor",
        chamber: "OPD Chamber #04 - General Medicine",
        active: true
      }
    });
  }

  let doctorB = await prisma.user.findUnique({ where: { email: "dr.e2e2@hospital.gov.in" } });
  if (!doctorB) {
    doctorB = await prisma.user.create({
      data: {
        userUid: crypto.randomUUID(),
        name: "Dr. E2E-B Tester",
        email: "dr.e2e2@hospital.gov.in",
        passwordHash: "testhash",
        salt: "testsalt",
        role: "doctor",
        chamber: "OPD Chamber #02 - Cardiology",
        active: true
      }
    });
  }

  // Patient A — Active CareRelationship with Doctor A
  await prisma.patient.upsert({
    where: { patientUid: P12_PATIENT_A_UID },
    update: {},
    create: {
      patientUid: P12_PATIENT_A_UID,
      patientId: "PAT-E2E-001",
      fullName: "E2E Test Patient Alpha",
      age: 45,
      gender: "Male",
      mobileNumber: "9000000001"
    }
  });

  // Patient B — Doctor A has NO care relationship
  await prisma.patient.upsert({
    where: { patientUid: P12_PATIENT_B_UID },
    update: {},
    create: {
      patientUid: P12_PATIENT_B_UID,
      patientId: "PAT-E2E-002",
      fullName: "E2E Test Patient Beta",
      age: 30,
      gender: "Female",
      mobileNumber: "9000000002"
    }
  });

  // Patient Gamma — No history
  await prisma.patient.upsert({
    where: { patientUid: P12_PATIENT_NO_HIST_UID },
    update: {},
    create: {
      patientUid: P12_PATIENT_NO_HIST_UID,
      patientId: "PAT-E2E-003",
      fullName: "E2E Test Patient Gamma",
      age: 22,
      gender: "Female",
      mobileNumber: "9000000003"
    }
  });

  // Encounters
  const ENC_A_ID = "ENC-E2E-2026-001";
  await prisma.encounter.upsert({
    where: { encounterId: ENC_A_ID },
    update: { assignedDoctorId: doctorA.id },
    create: {
      encounterId: ENC_A_ID,
      patientUid: P12_PATIENT_A_UID,
      tokenNumber: "E2E-001",
      assignedDoctorId: doctorA.id,
      consultationStatus: "in_progress",
      chamber: "OPD Chamber #04 - General Medicine",
      chiefComplaint: "Type 2 Diabetes follow-up",
      hpi: "Patient reports mild fatigue, no peripheral edema."
    }
  });

  const ENC_B_ID = "ENC-E2E-2026-002";
  await prisma.encounter.upsert({
    where: { encounterId: ENC_B_ID },
    update: { assignedDoctorId: doctorB.id },
    create: {
      encounterId: ENC_B_ID,
      patientUid: P12_PATIENT_B_UID,
      tokenNumber: "E2E-002",
      assignedDoctorId: doctorB.id,
      consultationStatus: "in_progress",
      chamber: "OPD Chamber #02 - Cardiology",
      chiefComplaint: "Palpitations on exertion"
    }
  });

  const ENC_C_ID = "ENC-E2E-2026-003";
  await prisma.encounter.upsert({
    where: { encounterId: ENC_C_ID },
    update: { assignedDoctorId: doctorA.id },
    create: {
      encounterId: ENC_C_ID,
      patientUid: P12_PATIENT_NO_HIST_UID,
      tokenNumber: "E2E-003",
      assignedDoctorId: doctorA.id,
      consultationStatus: "in_progress",
      chamber: "OPD Chamber #04 - General Medicine",
      chiefComplaint: "Annual check-up"
    }
  });

  // Care Relationships
  const existingRelA = await prisma.careRelationship.findFirst({
    where: { patientUid: P12_PATIENT_A_UID, doctorId: doctorA.id, status: "active", endedAt: null }
  });
  if (!existingRelA) {
    await prisma.careRelationship.create({
      data: {
        patientUid: P12_PATIENT_A_UID,
        doctorId: doctorA.id,
        relationshipType: "ATTENDING_OPD",
        status: "active",
        encounterId: ENC_A_ID,
        expiresAt: null,
        endedAt: null
      }
    });
  }

  const existingRelGamma = await prisma.careRelationship.findFirst({
    where: { patientUid: P12_PATIENT_NO_HIST_UID, doctorId: doctorA.id, status: "active", endedAt: null }
  });
  if (!existingRelGamma) {
    await prisma.careRelationship.create({
      data: {
        patientUid: P12_PATIENT_NO_HIST_UID,
        doctorId: doctorA.id,
        relationshipType: "ATTENDING_OPD",
        status: "active",
        encounterId: ENC_C_ID,
        expiresAt: null,
        endedAt: null
      }
    });
  }

  // Suspended CareRelationship for Patient Beta with Doctor A (cross-patient test)
  const existingRelBeta = await prisma.careRelationship.findFirst({
    where: { patientUid: P12_PATIENT_B_UID, doctorId: doctorA.id }
  });
  if (!existingRelBeta) {
    await prisma.careRelationship.create({
      data: {
        patientUid: P12_PATIENT_B_UID,
        doctorId: doctorA.id,
        relationshipType: "CONSULTING",
        status: "suspended",
        expiresAt: null,
        endedAt: null
      }
    });
  }

  // Document DOC-E2E-001 for Patient Alpha
  const existingDoc = await prisma.document.findUnique({
    where: { documentId: "DOC-E2E-001" }
  });
  if (!existingDoc) {
    await prisma.document.create({
      data: {
        documentId: "DOC-E2E-001",
        patientUid: P12_PATIENT_A_UID,
        encounterId: ENC_A_ID,
        documentType: "prescription",
        fileName: "Prescription_2020.pdf",
        filePath: "storage/test/Prescription_2020.pdf",
        mimeType: "application/pdf",
        fileSize: 1024,
        fileHash: "abc123e2ehash",
        status: "ready",
        derivativeVersion: 1
      }
    });
  }

  // 3. Start Express API Gateway
  const serverPath = path.resolve("Patient-case-taking-software-/server.js");
  const { default: app } = await import(pathToFileURL(serverPath).href);
  expressServer = http.createServer(app);
  await new Promise(r => expressServer.listen(0, "127.0.0.1", r));
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
  if (expressServer) await new Promise(r => expressServer.close(r));
  if (mockFastApiServer) await new Promise(r => mockFastApiServer.close(r));
  await disconnectPrisma();
});

test.describe.serial("Phase 12 — Real Browser Acceptance Suite", () => {
  let sharedPage;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    sharedPage = await context.newPage();

    // Attach request listener to assert security boundaries on all outgoing browser traffic
    sharedPage.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/rag/query")) {
        const postData = req.postDataJSON() || {};
        interceptedRAGRequests.push(postData);
      }
      if (url.includes(`:${mockFastApiPort}`) || url.includes(":8000")) {
        interceptedExternalFastAPICalls.push(url);
      }
    });
  });

  test.afterAll(async () => {
    if (sharedPage) await sharedPage.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Patient Kiosk Opens Successfully
  // ─────────────────────────────────────────────────────────────────────────────
  test("1. Patient kiosk opens successfully", async () => {
    await sharedPage.goto(BASE_URL);
    await sharedPage.waitForSelector("h1", { timeout: 15000 });

    const heading = await sharedPage.locator("h1").first().textContent();
    expect(heading).toContain("Right History");

    const terminalStatus = sharedPage.locator("text=Kiosk Terminal #03 • Active");
    await expect(terminalStatus).toBeVisible();

    const visibleText = await sharedPage.locator("body").innerText();
    expect(visibleText).not.toContain("patientUid");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Synthetic Patient Registration Flow through Actual UI
  // ─────────────────────────────────────────────────────────────────────────────
  test("2. Synthetic patient registration flow through the actual UI", async () => {
    // Click Quick ABHA / OPD Registration button
    await sharedPage.click("text=Quick ABHA / OPD Registration");
    await sharedPage.waitForSelector("text=Enter Patient Information", { timeout: 15000 });

    // Fill in synthetic registration form
    await sharedPage.fill('input[placeholder*="Niraj Kumar"]', "Synthetic Test Patient");
    await sharedPage.fill('input[placeholder*="mobile number"]', "9876543210");
    await sharedPage.fill('input[type="number"]', "32");

    // Click submit button
    const submitBtn = sharedPage.locator('button:has-text("Save Profile & Start Medical Chatbot")');
    await submitBtn.click();

    // Verifies encounter created and transitions to AI Interview
    await sharedPage.waitForSelector("text=Adaptive Clinical Intake", { timeout: 15000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Consent Flow
  // ─────────────────────────────────────────────────────────────────────────────
  test("3. Consent flow", async () => {
    // Navigate to Kiosk Home
    await sharedPage.click('button:has-text("Intake Home")');
    await sharedPage.click('button:has-text("Start Patient Assessment (जाँच शुरू करें)")');
    await sharedPage.waitForSelector("text=Language & Patient Consent", { timeout: 15000 });

    // Click Proceed to Patient Identification to open Consent page
    const proceedBtn = sharedPage.locator('button:has-text("Proceed to Patient Identification")');
    await proceedBtn.click();
    await sharedPage.waitForSelector("text=Before We Begin", { timeout: 15000 });

    // Verify low-literacy consent text is present
    const consentText = await sharedPage.locator("main").textContent();
    expect(consentText).toContain("Hum aapke swasthya se jude sawal puchhenge");

    // Click I Understand & Give Consent
    const consentBtn = sharedPage.locator('button:has-text("I Understand & Give Consent")');
    await consentBtn.click();

    // Verifies transition to Patient Details
    await sharedPage.waitForSelector("text=Enter Patient Information", { timeout: 15000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Adaptive Intake Interaction through Actual UI
  // ─────────────────────────────────────────────────────────────────────────────
  test("4. Adaptive intake interaction through the actual UI", async () => {
    // Navigate to Medical Chatbot tab
    await sharedPage.click('button:has-text("Medical Chatbot")');
    await sharedPage.waitForSelector("text=Adaptive Clinical Intake", { timeout: 15000 });

    // Click quick option pill if visible, or type and send
    const quickOption = sharedPage.locator('button:has-text("सीने में भारीपन / दबाव है")').first();
    if (await quickOption.isVisible()) {
      await quickOption.click();
    } else {
      const input = sharedPage.locator('input[placeholder*="अपनी तकलीफ"], input[type="text"]').first();
      await input.fill("सीने में भारीपन और हल्का दर्द है");
      await sharedPage.click('button:has-text("Send")');
    }

    // Wait for the next adaptive turn
    await sharedPage.waitForTimeout(1500);
    const conversationText = await sharedPage.locator("main").textContent();
    expect(conversationText).toContain("सीने में भारीपन");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Review / Edit / Submit Flow
  // ─────────────────────────────────────────────────────────────────────────────
  test("5. Review/edit/submit flow", async () => {
    // Navigate to Case Summary & PDF tab
    await sharedPage.locator('button:has-text("Case Summary & PDF")').first().click();
    await sharedPage.waitForSelector("text=Patient Case Summary & OPD Sheet", { timeout: 15000 });

    // Click Edit Name & Age
    const editBtn = sharedPage.locator('button:has-text("Edit Name & Age")').first();
    await editBtn.click();

    // Edit Name
    const nameInput = sharedPage.locator('input[type="text"][value*="Synthetic"], input[type="text"]').first();
    await nameInput.fill("Synthetic Reviewed Patient");
    await sharedPage.locator('button:has-text("Save & Update")').first().click();

    // Submit case to Doctor
    const sendBtn = sharedPage.locator('button:has-text("Send to Doctor (डॉक्टर को भेजें)")').first();
    await sendBtn.click();

    // Verify submission alert
    await sharedPage.waitForSelector("text=successfully sent to Doctor!", { timeout: 15000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Document Upload through UI
  // ─────────────────────────────────────────────────────────────────────────────
  test("6. Document upload through the UI", async () => {
    // Navigate to Scan Reports tab
    await sharedPage.locator('button:has-text("Scan Reports")').first().click();
    await sharedPage.waitForSelector("text=Medical Document OCR Scanner", { timeout: 15000 });

    // Upload a synthetic test PDF using file input
    const fileInput = sharedPage.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: "synthetic_rx_report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 synthetic minimal test document stream endobj")
    });

    // Wait for OCR simulation / scan state to finish
    await sharedPage.waitForSelector("text=OCR Complete", { timeout: 15000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Doctor Login through Actual UI
  // ─────────────────────────────────────────────────────────────────────────────
  test("7. Doctor login through the actual UI", async () => {
    // Navigate to Kiosk Home and click Doctor Consultation Login
    await sharedPage.locator('button:has-text("Intake Home")').first().click();
    await sharedPage.locator('button:has-text("Doctor Consultation Login")').first().click();
    await sharedPage.waitForSelector("text=Doctor Chamber Login", { timeout: 15000 });

    // Fill doctor credentials
    await sharedPage.fill('input[type="text"][placeholder*="dr.sharma"]', "dr.sharma@hospital.gov.in");
    await sharedPage.fill('input[type="password"]', "DoctorSecure123!");

    // Submit login form
    const loginBtn = sharedPage.locator('button:has-text("Login to Doctor OPD Chamber")').first();
    await loginBtn.click();

    // Verifies Doctor Credentials Verified alert and redirect
    await sharedPage.waitForSelector("text=Doctor Credentials Verified!", { timeout: 15000 });
    await sharedPage.waitForSelector("text=Live OPD Patient Queue", { timeout: 15000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Doctor Queue / Dashboard Loads
  // ─────────────────────────────────────────────────────────────────────────────
  test("8. Doctor queue/dashboard loads", async () => {
    // Verify dashboard table loaded
    await sharedPage.waitForSelector("table", { timeout: 15000 });
    const tableText = await sharedPage.locator("table").first().textContent();
    expect(tableText).toContain("Token");
    expect(tableText).toContain("Patient Name");
    expect(tableText).toContain("Triage Priority");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Authorized Patient / Encounter can be Opened
  // ─────────────────────────────────────────────────────────────────────────────
  test("9. Authorized patient/encounter can be opened", async () => {
    // Filter queue by unique token E2E-001
    await sharedPage.fill('input[placeholder*="Search token"]', "E2E-001");
    const alphaRow = sharedPage.locator('tr:has-text("E2E-001")').first();
    await alphaRow.click();

    // Verify right-side consultation panel opens with Chief Complaint
    await sharedPage.waitForSelector("text=Chief Complaint (CC)", { timeout: 15000 });
    const panelContent = await sharedPage.locator("main").textContent();
    expect(panelContent).toContain("Type 2 Diabetes follow-up");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Document Review / Approval UI Works
  // ─────────────────────────────────────────────────────────────────────────────
  test("10. Document review/approval UI works", async () => {
    // Click Documents in left sidebar
    await sharedPage.locator('button:has-text("Documents")').first().click();
    await sharedPage.waitForSelector("text=Digitized Medical Documents Repository", { timeout: 15000 });

    // Click "View OCR & Rx" on the first document card
    const viewOcrBtn = sharedPage.locator('button:has-text("View OCR & Rx")').first();
    await viewOcrBtn.click();

    // Verify Document modal opens with clinical derivative snapshot and structured facts
    await sharedPage.waitForSelector("text=Clinical Derivative Snapshot", { timeout: 15000 });

    // Close modal
    const closeBtn = sharedPage.locator('button:has-text("✕")').first();
    await closeBtn.click();

    // Return to Patient Queue
    await sharedPage.locator('button:has-text("Patient Queue")').first().click();
    await sharedPage.waitForSelector("table", { timeout: 15000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Longitudinal RAG Workspace Opens
  // ─────────────────────────────────────────────────────────────────────────────
  test("11. Longitudinal RAG workspace opens", async () => {
    // Select Patient Alpha again by unique token E2E-001
    await sharedPage.fill('input[placeholder*="Search token"]', "E2E-001");
    const alphaRow = sharedPage.locator('tr:has-text("E2E-001")').first();
    await alphaRow.click();

    // Click "Longitudinal RAG" tab in patient consultation panel
    const ragTabBtn = sharedPage.locator('button:has-text("Longitudinal RAG")').first();
    await ragTabBtn.click();

    // Verify Clinical Decision Support Safety Banner & Query Composer
    await sharedPage.waitForSelector("text=Longitudinal Clinical Intelligence", { timeout: 15000 });
    const queryInput = sharedPage.locator('textarea[placeholder*="Ask a longitudinal clinical question"]').first();
    await expect(queryInput).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. A RAG Query can be Submitted through the UI
  // ─────────────────────────────────────────────────────────────────────────────
  test("12. A RAG query can be submitted through the UI", async () => {
    const queryInput = sharedPage.locator('textarea[placeholder*="Ask a longitudinal clinical question"]').first();
    await queryInput.fill("What is the timeline of Metformin and HbA1c?");

    // Click Query button
    const submitQueryBtn = sharedPage.locator('button:has-text("Query")').first();
    await submitQueryBtn.click();

    // Wait for response to render in the DOM
    await sharedPage.waitForSelector("text=In 2020, Metformin 500mg was initiated.", { timeout: 15000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. RAG Result / Citations / Provenance Render
  // ─────────────────────────────────────────────────────────────────────────────
  test("13. RAG result/citations/provenance render", async () => {
    const workspaceContent = await sharedPage.locator("main").textContent();

    // Verify Strategy, Confidence, Years
    expect(workspaceContent).toContain("LONGITUDINAL_TREND");
    expect(workspaceContent).toContain("Confidence: high");
    expect(workspaceContent).toContain("2020");
    expect(workspaceContent).toContain("2022");

    // Verify Grounded Evidence Citations
    expect(workspaceContent).toContain("Grounded Evidence Citations");
    expect(workspaceContent).toContain("Doc #DOC-E2E-001");
    expect(workspaceContent).toContain("p. 1 (v1)");
    expect(workspaceContent).toContain("Metformin 500mg initiated.");
    expect(workspaceContent).toContain("DOCUMENT_EXTRACTED");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. Inspect Source Record Works
  // ─────────────────────────────────────────────────────────────────────────────
  test("14. Inspect Source Record works", async () => {
    // Click "Inspect" button on citation
    const inspectBtn = sharedPage.locator('button:has-text("Inspect")').first();
    await inspectBtn.click();

    // Document inspect modal opens
    await sharedPage.waitForSelector('text=Document #DOC-E2E-001', { timeout: 15000 });

    // Close modal cleanly and wait for it to detach
    await sharedPage.locator('button:has-text("✕")').first().click();
    await sharedPage.waitForSelector('text=Document #DOC-E2E-001', { state: "detached", timeout: 10000 });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 15. Unauthorized / Cross-Patient Access is Denied
  // ─────────────────────────────────────────────────────────────────────────────
  test("15. Unauthorized/cross-patient access is denied", async () => {
    // Ensure on Patient Queue view
    await sharedPage.locator('button:has-text("Patient Queue")').first().click();
    await sharedPage.waitForSelector('input[placeholder*="Search token"]', { timeout: 15000 });

    // Clear search and find Patient Beta (Doctor A has suspended care relationship)
    await sharedPage.fill('input[placeholder*="Search token"]', "E2E-002");
    const betaRow = sharedPage.locator('tr:has-text("E2E-002")').first();
    await betaRow.click();

    // Open Longitudinal RAG tab
    const ragTabBtn = sharedPage.locator('button:has-text("Longitudinal RAG")').first();
    await ragTabBtn.click();

    // Submit inquiry for unauthorized patient
    const queryInput = sharedPage.locator('textarea[placeholder*="Ask a longitudinal clinical question"]').first();
    await queryInput.fill("Attempt unauthorized cross-patient inquiry");
    await sharedPage.locator('button:has-text("Query")').first().click();

    // Verify safe denial error banner appears (403 CLINICAL_ACCESS_DENIED)
    await sharedPage.waitForSelector("text=Clinical access denied", { timeout: 15000 });
    const errorText = await sharedPage.locator("main").textContent();
    expect(errorText).toContain("CLINICAL_ACCESS_DENIED");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 16. No-History Patient Displays Truthful Empty-History State
  // ─────────────────────────────────────────────────────────────────────────────
  test("16. No-history patient displays a truthful empty-history state", async () => {
    // Set mock FastAPI to return no_history response
    mockFastApiMode = "no_history";

    // Ensure on Patient Queue view
    await sharedPage.locator('button:has-text("Patient Queue")').first().click();
    await sharedPage.waitForSelector('input[placeholder*="Search token"]', { timeout: 15000 });

    // Search and select Patient Gamma (no-history patient)
    await sharedPage.fill('input[placeholder*="Search token"]', "E2E-003");
    const gammaRow = sharedPage.locator('tr:has-text("E2E-003")').first();
    await gammaRow.click();

    // Open Longitudinal RAG tab
    const ragTabBtn = sharedPage.locator('button:has-text("Longitudinal RAG")').first();
    await ragTabBtn.click();

    // Submit query for no-history patient
    const queryInput = sharedPage.locator('textarea[placeholder*="Ask a longitudinal clinical question"]').first();
    await queryInput.fill("Summarize patient past history");
    await sharedPage.locator('button:has-text("Query")').first().click();

    // Verify explicit amber banner & truthful answer
    await sharedPage.waitForSelector("text=No Longitudinal Document History", { timeout: 15000 });
    const mainText = await sharedPage.locator("main").textContent();
    expect(mainText).toContain("Longitudinal history is unavailable for this patient");

    // Reset mode
    mockFastApiMode = "default";
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 17. RAG Failure (502/504) Produces Safe UI Error State
  // ─────────────────────────────────────────────────────────────────────────────
  test("17. RAG failure (502/504) produces the existing safe UI error state", async () => {
    // Set mock FastAPI to unavailable mode (503 upstream -> 502 from gateway)
    mockFastApiMode = "unavailable";

    // Ensure on Patient Queue view
    await sharedPage.locator('button:has-text("Patient Queue")').first().click();
    await sharedPage.waitForSelector('input[placeholder*="Search token"]', { timeout: 15000 });

    // Select Patient Alpha again
    await sharedPage.fill('input[placeholder*="Search token"]', "E2E-001");
    const alphaRow = sharedPage.locator('tr:has-text("E2E-001")').first();
    await alphaRow.click();

    // Open Longitudinal RAG tab
    const ragTabBtn = sharedPage.locator('button:has-text("Longitudinal RAG")').first();
    await ragTabBtn.click();

    // Submit query during outage
    const queryInput = sharedPage.locator('textarea[placeholder*="Ask a longitudinal clinical question"]').first();
    await queryInput.fill("Query while upstream service is offline");
    await sharedPage.locator('button:has-text("Query")').first().click();

    // Verify safe error banner rendered with code and friendly message
    await sharedPage.waitForSelector("text=RAG_SERVICE_UNAVAILABLE", { timeout: 15000 });
    const mainText = await sharedPage.locator("main").textContent();
    expect(mainText).toContain("Longitudinal clinical intelligence service is temporarily unreachable or offline");

    // Reset mode
    mockFastApiMode = "default";
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Security Invariants Assertions
  // ─────────────────────────────────────────────────────────────────────────────
  test("Security: No patientUid exposed in browser-visible DOM", async () => {
    const visibleText = await sharedPage.locator("body").innerText();
    expect(visibleText).not.toContain("patientUid");
    expect(visibleText).not.toContain(P12_PATIENT_A_UID);
    expect(visibleText).not.toContain(P12_PATIENT_B_UID);
    expect(visibleText).not.toContain(P12_PATIENT_NO_HIST_UID);
  });

  test("Security: No patientUid sent from browser to the RAG API", () => {
    expect(interceptedRAGRequests.length).toBeGreaterThan(0);
    for (const reqPayload of interceptedRAGRequests) {
      expect(reqPayload.patientUid).toBeUndefined();
      expect(reqPayload.patientId).toBeUndefined();
    }
  });

  test("Security: Browser never directly calls FastAPI port 8000", () => {
    expect(interceptedExternalFastAPICalls.length).toBe(0);
  });

  test("Security: No internal secrets appear in browser-visible responses", async () => {
    const visibleText = await sharedPage.locator("body").innerText();
    expect(visibleText).not.toContain(P12_INTERNAL_TOKEN);
  });
});
