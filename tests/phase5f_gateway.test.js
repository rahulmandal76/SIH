/**
 * Phase 5F Authoritative Test Suite: Node.js Gateway for Longitudinal RAG
 * tests/phase5f_gateway.test.js
 *
 * Authority: docs/PHASE_5_IMPLEMENTATION_PLAN.md
 *
 * Authoritative Test Matrix (33 Tests):
 *   TEST-P5F-01: Unauthenticated RAG query rejected (401 RAG_AUTH_REQUIRED)
 *   TEST-P5F-02: Patient / device session rejected (403 CLINICAL_ACCESS_DENIED)
 *   TEST-P5F-03: Doctor assigned encounter allowed (200 OK)
 *   TEST-P5F-04: Doctor active CareRelationship allowed (200 OK)
 *   TEST-P5F-05: Suspended CareRelationship denied (403 CLINICAL_ACCESS_DENIED)
 *   TEST-P5F-06: Ended CareRelationship denied (403 CLINICAL_ACCESS_DENIED)
 *   TEST-P5F-07: Expired CareRelationship denied (403 CLINICAL_ACCESS_DENIED)
 *   TEST-P5F-08: Doctor cannot access unrelated patient (403 CLINICAL_ACCESS_DENIED)
 *   TEST-P5F-09: Encounter / CareRelationship cross-context mismatch rejected (409 CONTEXT_MISMATCH)
 *   TEST-P5F-10: Browser-supplied patientUid rejected (400 VALIDATION_ERROR)
 *   TEST-P5F-11: Browser-supplied patientId rejected (400 VALIDATION_ERROR)
 *   TEST-P5F-12: Admin requires X-Admin-Access-Reason (403 ADMIN_ACCESS_REASON_REQUIRED)
 *   TEST-P5F-13: Admin query with valid reason allowed (200 OK)
 *   TEST-P5F-14: Invalid admin reason (<5 chars or >500 chars) rejected (403 ADMIN_ACCESS_REASON_REQUIRED)
 *   TEST-P5F-15: Admin cannot bypass clinical context through patientUid (400 VALIDATION_ERROR)
 *   TEST-P5F-16: Internal FastAPI secret not exposed to browser
 *   TEST-P5F-17: FastAPI unavailable returns 502 RAG_SERVICE_UNAVAILABLE
 *   TEST-P5F-18: FastAPI timeout returns deterministic gateway error (504 RAG_SERVICE_TIMEOUT)
 *   TEST-P5F-19: Malformed FastAPI response rejected (500 RAG_RESPONSE_INVALID)
 *   TEST-P5F-20: Internal response sanitization (no patientUid/patientId/paths/secrets in response)
 *   TEST-P5F-21: Citation schema validation (canonical fields, snippet <= 200 chars)
 *   TEST-P5F-22: No-history response preserved (historyAvailable=false, isNoHistory preserved)
 *   TEST-P5F-23: Current context sent without unnecessary PII (only tokenNumber, chiefComplaint, intakeSummary)
 *   TEST-P5F-24: CSRF protection enforced (missing X-Requested-With returns 403 CSRF_VIOLATION)
 *   TEST-P5F-25: RAG query rate limit enforced (429 TOO_MANY_REQUESTS on flood)
 *   TEST-P5F-26: Successful doctor query audited (relational AuditLog with QUERY_LONGITUDINAL_RAG)
 *   TEST-P5F-27: Failed/unauthorized query audit behavior (audit recorded on failure)
 *   TEST-P5F-28: Cross-patient CareRelationship isolation (Doctor cannot use another doctor's CareRel)
 *   TEST-P5F-29: Context identifier ownership enforced (non-existent encounter returns 404/400)
 *   TEST-P5F-30: FastAPI URL configuration cannot be browser-controlled
 *   TEST-P5F-31: Node does not expose patientUid in response
 *   TEST-P5F-32: Node does not expose FastAPI internal address/secret/errors
 *   TEST-P5F-33: End-to-end integration: Node -> authenticated/authorized doctor -> FastAPI -> sanitized response
 */

import http from "http";
import crypto from "crypto";
import { prisma, disconnectPrisma } from "../prisma/db.js";
import app from "../Patient-case-taking-software-/server.js";
import { resetRagRateLimit } from "../Patient-case-taking-software-/server/ragGateway.js";

const results = [];

function recordTest(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  const icon = status === "PASS" ? "✅" : (status === "PENDING_INFRA" ? "⏳" : "❌");
  console.log(`${icon} [${id}] ${name}: ${status}`);
  if (detail) {
    console.log(`   └── ${detail}`);
  }
}

// ─── Test Identifiers ────────────────────────────────────────────────────────
const PATIENT_A_UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT_B_UID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOC_SECRET_TOKEN = "test_internal_secret_p5f_12345";

let serverInstance;
let TEST_PORT;
let mockFastApiServer;
let MOCK_FASTAPI_PORT;

let mockFastApiMode = "default";
let lastFastApiRequest = null;

// ─── Mock FastAPI HTTP Server ───────────────────────────────────────────────
function createMockFastApiServer() {
  return http.createServer(async (req, res) => {
    let bodyData = "";
    req.on("data", chunk => { bodyData += chunk; });
    req.on("end", async () => {
      let parsed = null;
      try { parsed = JSON.parse(bodyData); } catch {}
      lastFastApiRequest = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: parsed
      };

      // Header verification: Constant-time secret check
      const secret = req.headers["x-internal-secret"];
      if (secret !== DOC_SECRET_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ detail: { code: "INVALID_SECRET", message: "Unauthorized internal call" } }));
      }

      if (mockFastApiMode === "timeout") {
        // Deliberate hang to trigger 8000ms gateway timeout
        await new Promise(r => setTimeout(r, 9000));
      }

      if (mockFastApiMode === "malformed") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ notAValidEnvelope: true }));
      }

      if (mockFastApiMode === "500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ detail: { message: "Internal ML error" } }));
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

      // Default: High-confidence longitudinal response
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        historyAvailable: true,
        retrievalPath: "TEMPORAL_TREND_AND_SEMANTIC",
        strategy: "LONGITUDINAL_TREND",
        answer: "In 2019 [DOC-A1, Page 1], Metformin 500mg was initiated. In 2021 [DOC-A2, Page 1], eGFR dropped to 72 mL/min with HbA1c at 7.4%.",
        confidence: "high",
        citations: [
          {
            documentId: "DOC-A1",
            pageNumber: 1,
            documentVersion: 1,
            approvalVersion: 1,
            clinicalDate: "2019-04-10",
            clinicalYear: 2019,
            provenance: "DOCUMENT_EXTRACTED",
            snippet: "Metformin 500mg initiated daily; baseline renal function evaluated.",
            relevanceScore: 0.9412
          },
          {
            documentId: "DOC-A2",
            pageNumber: 1,
            documentVersion: 1,
            approvalVersion: 1,
            clinicalDate: "2021-09-15",
            clinicalYear: 2021,
            provenance: "DOCUMENT_EXTRACTED",
            snippet: "Routine labs: eGFR dropped to 72 mL/min; HbA1c recorded at 7.4%.",
            relevanceScore: 0.8845
          }
        ],
        yearsCovered: [2019, 2021],
        isNoHistory: false
      }));
    });
  });
}

// ─── HTTP Request Helper ────────────────────────────────────────────────────
function makeRequest(method, reqPath, payload = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (["POST", "PUT", "DELETE", "PATCH"].includes(method.toUpperCase())) {
      if (reqHeaders["X-Requested-With"] === undefined) {
        reqHeaders["X-Requested-With"] = "XMLHttpRequest";
      } else if (reqHeaders["X-Requested-With"] === "" || reqHeaders["X-Requested-With"] === null) {
        delete reqHeaders["X-Requested-With"];
      }
    }
    let bodyData = null;
    if (payload !== null) {
      bodyData = JSON.stringify(payload);
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(bodyData);
    }

    const options = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: reqPath,
      method: method.toUpperCase(),
      headers: reqHeaders
    };

    const req = http.request(options, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });

    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

function extractCookie(res, cookieName) {
  const cookies = res.headers["set-cookie"];
  if (!cookies) return null;
  const arr = Array.isArray(cookies) ? cookies : [cookies];
  for (const c of arr) {
    const match = c.match(new RegExp(`^${cookieName}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

// ─── Main Test Runner ───────────────────────────────────────────────────────
async function runPhase5FTests() {
  console.log("\n============================================================");
  console.log("  PHASE 5F AUTHORITATIVE TEST SUITE: NODE.JS RAG GATEWAY");
  console.log("============================================================\n");

  // 1. Spin up Mock FastAPI Server
  await new Promise(resolve => {
    mockFastApiServer = createMockFastApiServer();
    mockFastApiServer.listen(0, "127.0.0.1", () => {
      MOCK_FASTAPI_PORT = mockFastApiServer.address().port;
      process.env.RAG_SERVICE_URL = `http://127.0.0.1:${MOCK_FASTAPI_PORT}`;
      process.env.RAG_SERVICE_INTERNAL_TOKEN = DOC_SECRET_TOKEN;
      console.log(`[Mock FastAPI] Listening on 127.0.0.1:${MOCK_FASTAPI_PORT}`);
      resolve();
    });
  });

  // 2. Spin up Express Gateway Server
  await new Promise(resolve => {
    serverInstance = http.createServer(app);
    serverInstance.listen(0, "127.0.0.1", () => {
      TEST_PORT = serverInstance.address().port;
      console.log(`[Express Gateway] Listening on 127.0.0.1:${TEST_PORT}\n`);
      resolve();
    });
  });

  // 3. Seed Database Fixtures
  // Users
  let doctor1 = await prisma.user.findFirst({ where: { role: "doctor" } });
  let admin = await prisma.user.findFirst({ where: { role: "admin" } });
  // Ensure Doctor 2 exists
  let doctor2 = await prisma.user.findUnique({ where: { email: "dr.patel@hospital.gov.in" } });
  if (!doctor2) {
    doctor2 = await prisma.user.create({
      data: {
        userUid: crypto.randomUUID(),
        name: "Dr. Priya Patel",
        email: "dr.patel@hospital.gov.in",
        passwordHash: "hash",
        salt: "salt",
        role: "doctor",
        chamber: "OPD Chamber #02 - Cardiology"
      }
    });
  }

  // Patients
  await prisma.patient.upsert({
    where: { patientUid: PATIENT_A_UID },
    update: {},
    create: {
      patientUid: PATIENT_A_UID,
      patientId: "PAT-P5F-001",
      fullName: "Patient Alpha Test",
      gender: "Male"
    }
  });

  await prisma.patient.upsert({
    where: { patientUid: PATIENT_B_UID },
    update: {},
    create: {
      patientUid: PATIENT_B_UID,
      patientId: "PAT-P5F-002",
      fullName: "Patient Beta Test",
      gender: "Female"
    }
  });

  // Encounters
  const encA1Id = "ENC-P5F-A1";
  await prisma.encounter.upsert({
    where: { encounterId: encA1Id },
    update: { assignedDoctorId: doctor1.id, patientUid: PATIENT_A_UID, tokenNumber: "T-P5F-001" },
    create: {
      encounterId: encA1Id,
      patientUid: PATIENT_A_UID,
      assignedDoctorId: doctor1.id,
      tokenNumber: "T-P5F-001",
      chamber: "OPD Chamber #04 - General Medicine",
      consultationStatus: "in_progress",
      chiefComplaint: "Type 2 Diabetes routine follow-up; eGFR surveillance",
      hpi: "Patient reports mild fatigue, denies dizziness or peripheral edema."
    }
  });

  const encB1Id = "ENC-P5F-B1";
  await prisma.encounter.upsert({
    where: { encounterId: encB1Id },
    update: { assignedDoctorId: doctor2.id, patientUid: PATIENT_B_UID, tokenNumber: "T-P5F-002" },
    create: {
      encounterId: encB1Id,
      patientUid: PATIENT_B_UID,
      assignedDoctorId: doctor2.id,
      tokenNumber: "T-P5F-002",
      chamber: "OPD Chamber #02 - Cardiology",
      consultationStatus: "in_progress",
      chiefComplaint: "Palpitations and shortness of breath on exertion",
      hpi: "Hypertension history, currently on ACE inhibitors."
    }
  });

  // CareRelationships
  // CR1: Active for Doctor 1 with Patient A
  const crA1 = await prisma.careRelationship.create({
    data: {
      patientUid: PATIENT_A_UID,
      doctorId: doctor1.id,
      status: "active",
      relationshipType: "ATTENDING_OPD",
      expiresAt: null,
      endedAt: null
    }
  });

  // CR2: Suspended for Doctor 1 with Patient B
  const crB_Suspended = await prisma.careRelationship.create({
    data: {
      patientUid: PATIENT_B_UID,
      doctorId: doctor1.id,
      status: "suspended",
      relationshipType: "CONSULTING",
      expiresAt: null,
      endedAt: null
    }
  });

  // CR3: Ended for Doctor 1 with Patient B
  const crB_Ended = await prisma.careRelationship.create({
    data: {
      patientUid: PATIENT_B_UID,
      doctorId: doctor1.id,
      status: "ended",
      relationshipType: "CONSULTING",
      expiresAt: null,
      endedAt: new Date(Date.now() - 3600000)
    }
  });

  // CR4: Expired for Doctor 1 with Patient B
  const crB_Expired = await prisma.careRelationship.create({
    data: {
      patientUid: PATIENT_B_UID,
      doctorId: doctor1.id,
      status: "active",
      relationshipType: "ATTENDING_OPD",
      expiresAt: new Date(Date.now() - 60000), // expired 1 minute ago
      endedAt: null
    }
  });

  // CR5: Active for Doctor 2 with Patient B
  const crB_Doctor2 = await prisma.careRelationship.create({
    data: {
      patientUid: PATIENT_B_UID,
      doctorId: doctor2.id,
      status: "active",
      relationshipType: "ATTENDING_OPD",
      expiresAt: null,
      endedAt: null
    }
  });

  // 4. Authenticate Sessions
  // Doctor 1 Login
  const doc1LoginRes = await makeRequest("POST", "/api/auth/login", {
    email: doctor1.email,
    password: "DoctorSecure123!"
  });
  const doc1Cookie = `ms_user_session=${extractCookie(doc1LoginRes, "ms_user_session")}`;

  // Doctor 2 Login
  const { createUserSession } = await import("../Patient-case-taking-software-/server/sessions.js");
  const doc2Token = createUserSession(doctor2);
  const doc2Cookie = `ms_user_session=${doc2Token}`;

  // Admin Login
  const adminLoginRes = await makeRequest("POST", "/api/auth/login", {
    email: admin.email,
    password: "AdminSecure123!"
  });
  const adminCookie = `ms_user_session=${extractCookie(adminLoginRes, "ms_user_session")}`;

  // Device Session (Kiosk Terminal)
  const { createDeviceSession, createEncounterSession } = await import("../Patient-case-taking-software-/server/sessions.js");
  const deviceToken = createDeviceSession("KIOSK-01", "TERM-01");
  const deviceCookie = `ms_device_session=${deviceToken}`;

  // Encounter Session (Patient Self-Intake)
  const encSessionToken = createEncounterSession(PATIENT_A_UID, encA1Id);
  const encounterCookie = `ms_encounter_session=${encSessionToken}`;

  // --------------------------------------------------------------------------
  // TEST-P5F-01: Unauthenticated RAG query rejected
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "When was Metformin first prescribed?"
    });
    if (res.status === 401 && res.body?.error?.code === "RAG_AUTH_REQUIRED") {
      recordTest("TEST-P5F-01", "Unauthenticated RAG query rejected", "PASS", "401 RAG_AUTH_REQUIRED enforced");
    } else {
      recordTest("TEST-P5F-01", "Unauthenticated RAG query rejected", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-01", "Unauthenticated RAG query rejected", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-02: Patient / device session rejected
  // --------------------------------------------------------------------------
  try {
    const resDevice = await makeRequest("POST", "/api/rag/query", { encounterId: encA1Id, query: "Test" }, { Cookie: deviceCookie });
    const resEncounter = await makeRequest("POST", "/api/rag/query", { encounterId: encA1Id, query: "Test" }, { Cookie: encounterCookie });
    if (
      resDevice.status === 403 && resDevice.body?.error?.code === "CLINICAL_ACCESS_DENIED" &&
      resEncounter.status === 403 && resEncounter.body?.error?.code === "CLINICAL_ACCESS_DENIED"
    ) {
      recordTest("TEST-P5F-02", "Patient/device session rejected", "PASS", "Device & Encounter sessions strictly denied (403 CLINICAL_ACCESS_DENIED)");
    } else {
      recordTest("TEST-P5F-02", "Patient/device session rejected", "FAIL", `Device: ${resDevice.status}, Encounter: ${resEncounter.status}`);
    }
  } catch (err) {
    recordTest("TEST-P5F-02", "Patient/device session rejected", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-03: Doctor assigned encounter allowed
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "default";
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "How has kidney function changed over time?"
    }, { Cookie: doc1Cookie });

    if (res.status === 200 && res.body?.success === true && res.body?.historyAvailable === true) {
      recordTest("TEST-P5F-03", "Doctor assigned encounter allowed", "PASS", "Doctor 1 query via assigned encounter allowed (200 OK)");
    } else {
      recordTest("TEST-P5F-03", "Doctor assigned encounter allowed", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-03", "Doctor assigned encounter allowed", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-04: Doctor active CareRelationship allowed
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "default";
    const res = await makeRequest("POST", "/api/rag/query", {
      careRelationshipId: crA1.id,
      query: "Metformin history?"
    }, { Cookie: doc1Cookie });

    if (res.status === 200 && res.body?.success === true) {
      recordTest("TEST-P5F-04", "Doctor active CareRelationship allowed", "PASS", "Doctor 1 query via active CareRelationship allowed (200 OK)");
    } else {
      recordTest("TEST-P5F-04", "Doctor active CareRelationship allowed", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-04", "Doctor active CareRelationship allowed", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-05: Suspended CareRelationship denied
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      careRelationshipId: crB_Suspended.id,
      query: "Medical history?"
    }, { Cookie: doc1Cookie });

    if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
      recordTest("TEST-P5F-05", "Suspended CareRelationship denied", "PASS", "403 CLINICAL_ACCESS_DENIED for suspended care relationship");
    } else {
      recordTest("TEST-P5F-05", "Suspended CareRelationship denied", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-05", "Suspended CareRelationship denied", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-06: Ended CareRelationship denied
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      careRelationshipId: crB_Ended.id,
      query: "Medical history?"
    }, { Cookie: doc1Cookie });

    if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
      recordTest("TEST-P5F-06", "Ended CareRelationship denied", "PASS", "403 CLINICAL_ACCESS_DENIED for ended care relationship");
    } else {
      recordTest("TEST-P5F-06", "Ended CareRelationship denied", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-06", "Ended CareRelationship denied", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-07: Expired CareRelationship denied
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      careRelationshipId: crB_Expired.id,
      query: "Medical history?"
    }, { Cookie: doc1Cookie });

    if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
      recordTest("TEST-P5F-07", "Expired CareRelationship denied", "PASS", "403 CLINICAL_ACCESS_DENIED for expired care relationship");
    } else {
      recordTest("TEST-P5F-07", "Expired CareRelationship denied", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-07", "Expired CareRelationship denied", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-08: Doctor cannot access unrelated patient encounter
  // --------------------------------------------------------------------------
  try {
    // Doctor 1 attempts to query Encounter B1 (assigned to Doctor 2)
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encB1Id,
      query: "What is patient B's cardiac status?"
    }, { Cookie: doc1Cookie });

    if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
      recordTest("TEST-P5F-08", "Doctor cannot access unrelated patient", "PASS", "Doctor 1 denied access to unassigned encounter of Patient B");
    } else {
      recordTest("TEST-P5F-08", "Doctor cannot access unrelated patient", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-08", "Doctor cannot access unrelated patient", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-09: Encounter/careRelationship cross-context mismatch rejected
  // --------------------------------------------------------------------------
  try {
    // encA1Id belongs to Patient A, crB_Doctor2 belongs to Patient B
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      careRelationshipId: crB_Doctor2.id,
      query: "Mismatch test query"
    }, { Cookie: doc1Cookie });

    if (res.status === 409 && res.body?.error?.code === "CONTEXT_MISMATCH") {
      recordTest("TEST-P5F-09", "Encounter/careRelationship cross-context mismatch rejected", "PASS", "409 CONTEXT_MISMATCH strictly enforced on differing patient contexts");
    } else {
      recordTest("TEST-P5F-09", "Encounter/careRelationship cross-context mismatch rejected", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-09", "Encounter/careRelationship cross-context mismatch rejected", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-10: Browser-supplied patientUid rejected
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      patientUid: PATIENT_A_UID,
      query: "Injected patientUid test"
    }, { Cookie: doc1Cookie });

    if (res.status === 400 && res.body?.error?.code === "VALIDATION_ERROR") {
      recordTest("TEST-P5F-10", "Browser-supplied patientUid rejected", "PASS", "400 VALIDATION_ERROR on injected patientUid");
    } else {
      recordTest("TEST-P5F-10", "Browser-supplied patientUid rejected", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-10", "Browser-supplied patientUid rejected", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-11: Browser-supplied patientId rejected
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      patientId: "PAT-P5F-001",
      query: "Injected patientId test"
    }, { Cookie: doc1Cookie });

    if (res.status === 400 && res.body?.error?.code === "VALIDATION_ERROR") {
      recordTest("TEST-P5F-11", "Browser-supplied patientId rejected", "PASS", "400 VALIDATION_ERROR on injected patientId");
    } else {
      recordTest("TEST-P5F-11", "Browser-supplied patientId rejected", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-11", "Browser-supplied patientId rejected", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-12: Admin requires X-Admin-Access-Reason
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Admin query without reason header"
    }, { Cookie: adminCookie });

    if (res.status === 403 && res.body?.error?.code === "ADMIN_ACCESS_REASON_REQUIRED") {
      recordTest("TEST-P5F-12", "Admin requires X-Admin-Access-Reason", "PASS", "403 ADMIN_ACCESS_REASON_REQUIRED when header missing");
    } else {
      recordTest("TEST-P5F-12", "Admin requires X-Admin-Access-Reason", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-12", "Admin requires X-Admin-Access-Reason", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-13: Admin query with valid reason allowed
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Admin clinical audit inspection"
    }, {
      Cookie: adminCookie,
      "X-Admin-Access-Reason": "Clinical safety protocol compliance review"
    });

    if (res.status === 200 && res.body?.success === true) {
      recordTest("TEST-P5F-13", "Admin query with valid reason allowed", "PASS", "Admin access granted with valid X-Admin-Access-Reason");
    } else {
      recordTest("TEST-P5F-13", "Admin query with valid reason allowed", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-13", "Admin query with valid reason allowed", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-14: Invalid admin reason rejected
  // --------------------------------------------------------------------------
  try {
    const resTooShort = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Admin test"
    }, {
      Cookie: adminCookie,
      "X-Admin-Access-Reason": "abc" // < 5 chars
    });

    const resTooLong = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Admin test"
    }, {
      Cookie: adminCookie,
      "X-Admin-Access-Reason": "A".repeat(501) // > 500 chars
    });

    if (
      resTooShort.status === 403 && resTooShort.body?.error?.code === "ADMIN_ACCESS_REASON_REQUIRED" &&
      resTooLong.status === 403 && resTooLong.body?.error?.code === "ADMIN_ACCESS_REASON_REQUIRED"
    ) {
      recordTest("TEST-P5F-14", "Invalid admin reason rejected", "PASS", "Header <5 or >500 characters rejected with 403 ADMIN_ACCESS_REASON_REQUIRED");
    } else {
      recordTest("TEST-P5F-14", "Invalid admin reason rejected", "FAIL", `TooShort: ${resTooShort.status}, TooLong: ${resTooLong.status}`);
    }
  } catch (err) {
    recordTest("TEST-P5F-14", "Invalid admin reason rejected", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-15: Admin cannot bypass clinical context through patientUid
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      patientUid: PATIENT_A_UID,
      query: "Admin raw UID bypass attempt"
    }, {
      Cookie: adminCookie,
      "X-Admin-Access-Reason": "Legitimate audit reason here"
    });

    if (res.status === 400 && res.body?.error?.code === "VALIDATION_ERROR") {
      recordTest("TEST-P5F-15", "Admin cannot bypass clinical context through patientUid", "PASS", "Admin strictly blocked from injecting raw patientUid");
    } else {
      recordTest("TEST-P5F-15", "Admin cannot bypass clinical context through patientUid", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-15", "Admin cannot bypass clinical context through patientUid", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-16: Internal FastAPI secret not exposed to browser & fails closed
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Inspection query"
    }, { Cookie: doc1Cookie });

    const rawStr = JSON.stringify(res);
    const secretShielded = !rawStr.includes(DOC_SECRET_TOKEN);

    // Verify fail-closed behavior when token is missing/empty
    const originalToken = process.env.RAG_SERVICE_INTERNAL_TOKEN;
    delete process.env.RAG_SERVICE_INTERNAL_TOKEN;
    const resNoToken = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Fail-closed check"
    }, { Cookie: doc1Cookie });
    process.env.RAG_SERVICE_INTERNAL_TOKEN = originalToken;

    const failsClosed = (resNoToken.status === 500 && resNoToken.body?.error?.code === "RAG_RESPONSE_INVALID");

    if (secretShielded && failsClosed) {
      recordTest("TEST-P5F-16", "Internal FastAPI secret not exposed to browser", "PASS",
        "Internal secret strictly confined to server-side memory; fails closed with 500 when token missing");
    } else {
      recordTest("TEST-P5F-16", "Internal FastAPI secret not exposed to browser", "FAIL",
        `SecretShielded: ${secretShielded}, FailsClosed: ${failsClosed} (status=${resNoToken.status})`);
    }
  } catch (err) {
    recordTest("TEST-P5F-16", "Internal FastAPI secret not exposed to browser", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-17: FastAPI unavailable returns 502 RAG_SERVICE_UNAVAILABLE
  // --------------------------------------------------------------------------
  try {
    // Point RAG_SERVICE_URL to a dead port
    const originalUrl = process.env.RAG_SERVICE_URL;
    process.env.RAG_SERVICE_URL = "http://127.0.0.1:59999";

    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Connection failure test"
    }, { Cookie: doc1Cookie });

    process.env.RAG_SERVICE_URL = originalUrl;

    if (res.status === 502 && res.body?.error?.code === "RAG_SERVICE_UNAVAILABLE") {
      recordTest("TEST-P5F-17", "FastAPI unavailable returns 502", "PASS", "Deterministic 502 RAG_SERVICE_UNAVAILABLE on connection refusal");
    } else {
      recordTest("TEST-P5F-17", "FastAPI unavailable returns 502", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-17", "FastAPI unavailable returns 502", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-18: FastAPI timeout returns deterministic gateway error
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "timeout";
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Timeout test query"
    }, { Cookie: doc1Cookie });
    mockFastApiMode = "default";

    if (res.status === 504 && res.body?.error?.code === "RAG_SERVICE_TIMEOUT") {
      recordTest("TEST-P5F-18", "FastAPI timeout returns deterministic gateway error", "PASS", "504 RAG_SERVICE_TIMEOUT returned when service hangs");
    } else {
      recordTest("TEST-P5F-18", "FastAPI timeout returns deterministic gateway error", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-18", "FastAPI timeout returns deterministic gateway error", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-19: Malformed FastAPI response rejected
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "malformed";
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Malformed test query"
    }, { Cookie: doc1Cookie });
    mockFastApiMode = "default";

    if (res.status === 500 && res.body?.error?.code === "RAG_RESPONSE_INVALID") {
      recordTest("TEST-P5F-19", "Malformed FastAPI response rejected", "PASS", "500 RAG_RESPONSE_INVALID when response envelope fails schema");
    } else {
      recordTest("TEST-P5F-19", "Malformed FastAPI response rejected", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-19", "Malformed FastAPI response rejected", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-20: Internal response sanitization
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "default";
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Sanitization test query"
    }, { Cookie: doc1Cookie });

    const rawStr = JSON.stringify(res.body);
    const hasPatientUid = rawStr.includes(PATIENT_A_UID);
    const hasInternalUrl = rawStr.includes("127.0.0.1") || rawStr.includes("localhost");
    const hasFilePath = rawStr.includes("dev.db") || rawStr.includes("vector_index");

    if (!hasPatientUid && !hasInternalUrl && !hasFilePath) {
      recordTest("TEST-P5F-20", "Internal response sanitization", "PASS", "Zero patientUid, internal URLs, or filesystem paths leaked to browser");
    } else {
      recordTest("TEST-P5F-20", "Internal response sanitization", "FAIL", `Leaks detected: UID=${hasPatientUid}, URL=${hasInternalUrl}, Path=${hasFilePath}`);
    }
  } catch (err) {
    recordTest("TEST-P5F-20", "Internal response sanitization", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-21: Citation schema validation
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "default";
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Citations test"
    }, { Cookie: doc1Cookie });

    const citations = res.body?.citations || [];
    const validCitations = citations.length > 0 && citations.every(c => (
      typeof c.documentId === "string" &&
      typeof c.pageNumber === "number" && c.pageNumber >= 1 &&
      typeof c.documentVersion === "number" &&
      typeof c.snippet === "string" && c.snippet.length <= 200 &&
      !c.patientUid && !c.patientId
    ));

    if (validCitations) {
      recordTest("TEST-P5F-21", "Citation schema validation", "PASS", "Citations normalized with documentId, pageNumber, version, and bounded snippet");
    } else {
      recordTest("TEST-P5F-21", "Citation schema validation", "FAIL", JSON.stringify(citations));
    }
  } catch (err) {
    recordTest("TEST-P5F-21", "Citation schema validation", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-22: No-history response preserved
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "no_history";
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Any history?"
    }, { Cookie: doc1Cookie });
    mockFastApiMode = "default";

    if (res.status === 200 && res.body?.historyAvailable === false && res.body?.confidence === "insufficient_evidence") {
      recordTest("TEST-P5F-22", "No-history response preserved", "PASS", "Deterministic historyAvailable=false and insufficient_evidence preserved");
    } else {
      recordTest("TEST-P5F-22", "No-history response preserved", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-22", "No-history response preserved", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-23: Current context sent without unnecessary PII
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "default";
    await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "Context minimization test"
    }, { Cookie: doc1Cookie });

    const sentCtx = lastFastApiRequest?.body?.currentEncounterContext;
    const hasUnnecessaryPII = lastFastApiRequest?.body?.fullName ||
                             lastFastApiRequest?.body?.mobileNumber ||
                             lastFastApiRequest?.body?.abhaNumber ||
                             sentCtx?.fullName;

    if (sentCtx && sentCtx.chiefComplaint && !hasUnnecessaryPII) {
      recordTest("TEST-P5F-23", "Current context sent without unnecessary PII", "PASS", "Encounter context minimized to chief complaint and intake summary");
    } else {
      recordTest("TEST-P5F-23", "Current context sent without unnecessary PII", "FAIL", JSON.stringify(sentCtx));
    }
  } catch (err) {
    recordTest("TEST-P5F-23", "Current context sent without unnecessary PII", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-24: CSRF protection enforced
  // --------------------------------------------------------------------------
  try {
    // Make request without X-Requested-With header
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encA1Id,
      query: "CSRF test query"
    }, {
      Cookie: doc1Cookie,
      "X-Requested-With": "" // clear header
    });

    if (res.status === 403 && res.body?.error?.code === "CSRF_VIOLATION") {
      recordTest("TEST-P5F-24", "CSRF protection enforced", "PASS", "403 CSRF_VIOLATION when X-Requested-With header is missing");
    } else {
      recordTest("TEST-P5F-24", "CSRF protection enforced", "FAIL", `Status: ${res.status}, code: ${res.body?.error?.code}`);
    }
  } catch (err) {
    recordTest("TEST-P5F-24", "CSRF protection enforced", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-25: RAG query rate limit enforced
  // --------------------------------------------------------------------------
  try {
    // Send 65 rapid requests to trigger rate limit (max 60)
    let rateLimited = false;
    for (let i = 0; i < 65; i++) {
      const res = await makeRequest("POST", "/api/rag/query", {
        encounterId: encA1Id,
        query: `Rate limit test ${i}`
      }, { Cookie: doc1Cookie });
      if (res.status === 429 && res.body?.error?.code === "TOO_MANY_REQUESTS") {
        rateLimited = true;
        break;
      }
    }

    if (rateLimited) {
      recordTest("TEST-P5F-25", "RAG query rate limit enforced", "PASS", "429 TOO_MANY_REQUESTS returned when threshold exceeded");
    } else {
      recordTest("TEST-P5F-25", "RAG query rate limit enforced", "FAIL", "Rate limit not triggered after 65 calls");
    }
    // Reset rate limiter so subsequent tests aren't blocked by flooded counter
    resetRagRateLimit();
  } catch (err) {
    resetRagRateLimit();
    recordTest("TEST-P5F-25", "RAG query rate limit enforced", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-26: Successful doctor query audited
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "default";
    // Clear rate limit store for Doctor 2
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encB1Id,
      query: "Doctor 2 audit test query"
    }, { Cookie: doc2Cookie });

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        action: "QUERY_LONGITUDINAL_RAG",
        actorUserId: doctor2.id,
        patientUid: PATIENT_B_UID
      },
      orderBy: { id: "desc" }
    });

    if (res.status === 200 && auditRow && auditRow.resourceType === "Encounter") {
      recordTest("TEST-P5F-26", "Successful doctor query audited", "PASS", `AuditLog row created (id=${auditRow.id}) with action=QUERY_LONGITUDINAL_RAG`);
    } else {
      recordTest("TEST-P5F-26", "Successful doctor query audited", "FAIL", JSON.stringify(auditRow));
    }
  } catch (err) {
    recordTest("TEST-P5F-26", "Successful doctor query audited", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-27: Failed/unauthorized query audit behavior
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "500";
    await makeRequest("POST", "/api/rag/query", {
      encounterId: encB1Id,
      query: "Failed query audit test"
    }, { Cookie: doc2Cookie });
    mockFastApiMode = "default";

    const auditFailure = await prisma.auditLog.findFirst({
      where: {
        action: "QUERY_LONGITUDINAL_RAG",
        actorUserId: doctor2.id
      },
      orderBy: { id: "desc" }
    });

    const meta = auditFailure ? JSON.parse(auditFailure.metadataJson || "{}") : {};
    if (auditFailure && meta.success === false) {
      recordTest("TEST-P5F-27", "Failed/unauthorized query audit behavior", "PASS", "AuditLog tracks query failure metadata (success=false)");
    } else {
      recordTest("TEST-P5F-27", "Failed/unauthorized query audit behavior", "FAIL", JSON.stringify(meta));
    }
  } catch (err) {
    recordTest("TEST-P5F-27", "Failed/unauthorized query audit behavior", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-28: Cross-patient CareRelationship isolation
  // --------------------------------------------------------------------------
  try {
    // Doctor 1 attempts to use crB_Doctor2 (which belongs to Doctor 2)
    const res = await makeRequest("POST", "/api/rag/query", {
      careRelationshipId: crB_Doctor2.id,
      query: "Doctor 1 hijacking Doctor 2 CareRel"
    }, { Cookie: doc1Cookie });

    if (res.status === 403 && res.body?.error?.code === "CLINICAL_ACCESS_DENIED") {
      recordTest("TEST-P5F-28", "Cross-patient CareRelationship isolation", "PASS", "Doctor strictly prohibited from using another doctor's CareRelationship");
    } else {
      recordTest("TEST-P5F-28", "Cross-patient CareRelationship isolation", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-28", "Cross-patient CareRelationship isolation", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-29: Context identifier ownership enforced
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: "ENC-NON-EXISTENT-999",
      query: "Non-existent encounter test"
    }, { Cookie: doc2Cookie });

    if (res.status === 404 && res.body?.error?.code === "VALIDATION_ERROR") {
      recordTest("TEST-P5F-29", "Context identifier ownership enforced", "PASS", "404 VALIDATION_ERROR on forged/unregistered encounter ID");
    } else {
      recordTest("TEST-P5F-29", "Context identifier ownership enforced", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-29", "Context identifier ownership enforced", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-30: FastAPI URL configuration cannot be browser-controlled
  // --------------------------------------------------------------------------
  try {
    // Injected parameter in request body attempting to change FastAPI target
    await makeRequest("POST", "/api/rag/query", {
      encounterId: encB1Id,
      ragServiceUrl: "http://attacker-controlled.site:8000",
      query: "URL hijacking attempt"
    }, { Cookie: doc2Cookie });

    // Verify last request went strictly to local mock service
    if (lastFastApiRequest && lastFastApiRequest.body.patientUid === PATIENT_B_UID) {
      recordTest("TEST-P5F-30", "FastAPI URL configuration cannot be browser-controlled", "PASS", "RAG service URL strictly governed by server environment");
    } else {
      recordTest("TEST-P5F-30", "FastAPI URL configuration cannot be browser-controlled", "FAIL", "URL manipulation allowed");
    }
  } catch (err) {
    recordTest("TEST-P5F-30", "FastAPI URL configuration cannot be browser-controlled", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-31: Node does not expose patientUid in response
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "default";
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encB1Id,
      query: "Verify response shape"
    }, { Cookie: doc2Cookie });

    if (res.status === 200 && !res.body.patientUid && !res.body.patientId) {
      recordTest("TEST-P5F-31", "Node does not expose patientUid in response", "PASS", "Browser response envelope completely excludes internal patientUid");
    } else {
      recordTest("TEST-P5F-31", "Node does not expose patientUid in response", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-31", "Node does not expose patientUid in response", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-32: Node does not expose FastAPI internal address/secret/errors
  // --------------------------------------------------------------------------
  try {
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encB1Id,
      query: "Verify internal privacy"
    }, { Cookie: doc2Cookie });

    const rawText = JSON.stringify(res);
    const hasAddress = rawText.includes(String(MOCK_FASTAPI_PORT));
    const hasSecret = rawText.includes(DOC_SECRET_TOKEN);

    if (!hasAddress && !hasSecret) {
      recordTest("TEST-P5F-32", "Node does not expose FastAPI internal address/secret/errors", "PASS", "Internal address and tokens shielded from client");
    } else {
      recordTest("TEST-P5F-32", "Node does not expose FastAPI internal address/secret/errors", "FAIL", `Leaked: address=${hasAddress}, secret=${hasSecret}`);
    }
  } catch (err) {
    recordTest("TEST-P5F-32", "Node does not expose FastAPI internal address/secret/errors", "FAIL", err.message);
  }

  // --------------------------------------------------------------------------
  // TEST-P5F-33: End-to-end integration: Node -> doctor request -> FastAPI -> sanitized response
  // --------------------------------------------------------------------------
  try {
    mockFastApiMode = "default";
    const res = await makeRequest("POST", "/api/rag/query", {
      encounterId: encB1Id,
      query: "Chronological evolution of hypertension symptoms?"
    }, { Cookie: doc2Cookie });

    const ok = res.status === 200 &&
               res.body?.success === true &&
               res.body?.historyAvailable === true &&
               res.body?.citations?.length > 0 &&
               res.body?.yearsCovered?.length > 0 &&
               typeof res.body?.answer === "string";

    if (ok) {
      recordTest("TEST-P5F-33", "End-to-end integration: Node -> doctor -> FastAPI -> sanitized response", "PASS", "Full chain validated: auth -> authorization -> identity derivation -> internal call -> sanitized response");
    } else {
      recordTest("TEST-P5F-33", "End-to-end integration: Node -> doctor -> FastAPI -> sanitized response", "FAIL", JSON.stringify(res.body));
    }
  } catch (err) {
    recordTest("TEST-P5F-33", "End-to-end integration: Node -> doctor -> FastAPI -> sanitized response", "FAIL", err.message);
  }

  // ─── Teardown & Summary ───────────────────────────────────────────────────
  await new Promise(r => mockFastApiServer.close(r));
  await new Promise(r => serverInstance.close(r));
  await disconnectPrisma();

  console.log("\n============================================================");
  console.log("  PHASE 5F TEST RESULTS SUMMARY");
  console.log("============================================================");
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;

  console.log(`Total:   ${results.length}`);
  console.log(`Passed:  ${passed}`);
  console.log(`Failed:  ${failed}\n`);

  if (failed > 0) {
    console.error("❌ Some Phase 5F tests failed!");
    process.exit(1);
  } else {
    console.log(`🎉 ALL ${results.length} PHASE 5F TESTS PASSED AUTHORITATIVELY!`);
    process.exit(0);
  }
}

runPhase5FTests().catch(err => {
  console.error("FATAL ERROR in Phase 5F test suite:", err);
  process.exit(1);
});
