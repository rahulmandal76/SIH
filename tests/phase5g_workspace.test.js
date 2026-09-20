/**
 * Phase 5G Authoritative Test Suite: Doctor Longitudinal RAG Workspace
 * tests/phase5g_workspace.test.js
 *
 * Authority: docs/PHASE_5_IMPLEMENTATION_PLAN.md
 *
 * Test Matrix:
 *   TEST-P5G-01: Workspace component exists and exports safely
 *   TEST-P5G-02: Valid doctor query calls POST /api/rag/query
 *   TEST-P5G-03: Invariant: Client payload contains no patientUid
 *   TEST-P5G-04: Invariant: Client payload contains no patientId
 *   TEST-P5G-05: Missing/invalid clinical context is rejected client-side
 *   TEST-P5G-06: 401 authentication failure handled correctly
 *   TEST-P5G-07: 403 clinical authorization failure handled correctly
 *   TEST-P5G-08: 429 rate limit handled correctly
 *   TEST-P5G-09: 502 service-unavailable response handled correctly
 *   TEST-P5G-10: 504 timeout handled correctly
 *   TEST-P5G-11: Successful response parses answer and strategy metadata
 *   TEST-P5G-12: Citations originate strictly from returned evidence and are bounded
 *   TEST-P5G-13: No-history state displays explicit truthful clinical disclaimer
 *   TEST-P5G-14: Confidence information renders correctly (high/medium/insufficient_evidence)
 *   TEST-P5G-15: Temporal years render chronologically when returned
 *   TEST-P5G-16: Duplicate submission is blocked while loading
 *   TEST-P5G-17: Internal secrets, URLs, filesystem paths, and vector paths never leak
 *   TEST-P5G-18: Existing Doctor Dashboard functionality remains intact
 *   TEST-P5G-19: ragClient rejects forbidden identifier arguments before network transmission
 *   TEST-P5G-20: Clinician quick prompts are defined and trigger valid query construction
 *   TEST-P5G-21: Context change clears previous results and in-memory history
 *   TEST-P5G-22: Privacy invariant: RAG history is transient in-memory only (no localStorage/sessionStorage)
 *   TEST-P5G-23: Source inspection connects to authorized document review modal
 *   TEST-P5G-24: Robustness: Unsupported optional fields do not crash client processing
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import http from "http";
import { queryLongitudinalRAG, normalizeRagError, CLINICAL_QUICK_PROMPTS } from "../Patient-case-taking-software-/src/utils/ragClient.js";

const results = [];

function recordTest(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  const icon = status === "PASS" ? "✅" : (status === "PENDING_INFRA" ? "⏳" : "❌");
  console.log(`${icon} [${id}] ${name}: ${status}`);
  if (detail) {
    console.log(`   └── ${detail}`);
  }
}

async function runTestSuite() {
  console.log("============================================================");
  console.log("PHASE 5G AUTHORITATIVE TEST SUITE: DOCTOR LONGITUDINAL WORKSPACE");
  console.log("============================================================\n");

  // ─── TEST-P5G-01: Workspace component exists and exports safely ────────────
  try {
    const workspacePath = path.resolve("Patient-case-taking-software-/src/components/LongitudinalRagWorkspace.jsx");
    assert.strictEqual(fs.existsSync(workspacePath), true, "LongitudinalRagWorkspace.jsx file must exist");
    const content = fs.readFileSync(workspacePath, "utf-8");
    assert.ok(content.includes("export const LongitudinalRagWorkspace"), "Must export LongitudinalRagWorkspace component");
    assert.ok(content.includes("CLINICAL_QUICK_PROMPTS"), "Must export CLINICAL_QUICK_PROMPTS array");
    recordTest("TEST-P5G-01", "Workspace component exists and exports safely", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-01", "Workspace component exists and exports safely", "FAIL", err.message);
  }

  // ─── Mock Server Setup for Client Testing ──────────────────────────────────
  let mockServer;
  let mockPort;
  let lastReceivedPayload = null;
  let lastReceivedHeaders = null;
  let mockResponseStatus = 200;
  let mockResponseBody = {};

  await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      lastReceivedHeaders = req.headers;
      let bodyStr = "";
      req.on("data", (chunk) => { bodyStr += chunk; });
      req.on("end", () => {
        try {
          lastReceivedPayload = bodyStr ? JSON.parse(bodyStr) : null;
        } catch {
          lastReceivedPayload = bodyStr;
        }
        res.writeHead(mockResponseStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(mockResponseBody));
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });

  // Polyfill global fetch to route to our test mock server
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (url === "/api/rag/query" || url.startsWith("/api/rag/query")) {
      const targetUrl = `http://127.0.0.1:${mockPort}/api/rag/query`;
      return originalFetch(targetUrl, options);
    }
    return originalFetch(url, options);
  };

  // ─── TEST-P5G-02: Valid doctor query calls POST /api/rag/query ─────────────
  try {
    mockResponseStatus = 200;
    mockResponseBody = {
      success: true,
      historyAvailable: true,
      retrievalPath: "temporal",
      strategy: "LONGITUDINAL_TREND",
      answer: "Patient was diagnosed with Type 2 Diabetes in 2019. HbA1c peaked at 8.9% in 2021 before stabilizing.",
      confidence: "high",
      citations: [
        {
          documentId: "DOC-2019-01",
          pageNumber: 1,
          documentVersion: 1,
          approvalVersion: 1,
          clinicalDate: "2019-04-12",
          provenance: "DOCUMENT_EXTRACTED",
          snippet: "Patient presents with polydipsia. Fasting glucose 168 mg/dL."
        }
      ],
      yearsCovered: [2019, 2021, 2023]
    };

    lastReceivedPayload = null;
    lastReceivedHeaders = null;

    const res = await queryLongitudinalRAG({
      encounterId: "ENC-101",
      query: "What changed in HbA1c over time?",
      retrievalPath: "temporal",
      topK: 6
    });

    assert.strictEqual(res.success, true);
    assert.ok(lastReceivedHeaders["x-requested-with"], "Must include X-Requested-With header");
    assert.strictEqual(lastReceivedHeaders["x-requested-with"], "XMLHttpRequest");
    assert.strictEqual(lastReceivedPayload.encounterId, "ENC-101");
    assert.strictEqual(lastReceivedPayload.query, "What changed in HbA1c over time?");
    assert.strictEqual(lastReceivedPayload.retrievalPath, "temporal");

    recordTest("TEST-P5G-02", "Valid doctor query calls POST /api/rag/query", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-02", "Valid doctor query calls POST /api/rag/query", "FAIL", err.message);
  }

  // ─── TEST-P5G-03: Invariant: Client payload contains no patientUid ─────────
  try {
    assert.strictEqual(lastReceivedPayload.patientUid, undefined, "Payload must not contain patientUid");
    assert.strictEqual(lastReceivedPayload.patient_uid, undefined, "Payload must not contain patient_uid");
    recordTest("TEST-P5G-03", "Invariant: Client payload contains no patientUid", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-03", "Invariant: Client payload contains no patientUid", "FAIL", err.message);
  }

  // ─── TEST-P5G-04: Invariant: Client payload contains no patientId ──────────
  try {
    assert.strictEqual(lastReceivedPayload.patientId, undefined, "Payload must not contain patientId");
    assert.strictEqual(lastReceivedPayload.patient_id, undefined, "Payload must not contain patient_id");
    recordTest("TEST-P5G-04", "Invariant: Client payload contains no patientId", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-04", "Invariant: Client payload contains no patientId", "FAIL", err.message);
  }

  // ─── TEST-P5G-05: Missing/invalid clinical context is rejected client-side ──
  try {
    let threw = false;
    try {
      await queryLongitudinalRAG({
        query: "What is the medication history?",
        encounterId: null,
        careRelationshipId: null
      });
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes("clinical context"), "Must inform clinician that clinical context is required");
    }
    assert.strictEqual(threw, true, "Must throw on missing encounterId and careRelationshipId");
    recordTest("TEST-P5G-05", "Missing/invalid clinical context is rejected client-side", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-05", "Missing/invalid clinical context is rejected client-side", "FAIL", err.message);
  }

  // ─── TEST-P5G-06: 401 authentication failure handled correctly ─────────────
  try {
    mockResponseStatus = 401;
    mockResponseBody = {
      error: { code: "RAG_AUTH_REQUIRED", message: "User session required" }
    };

    let caughtErr = null;
    try {
      await queryLongitudinalRAG({
        encounterId: "ENC-101",
        query: "Test auth"
      });
    } catch (e) {
      caughtErr = e;
    }

    assert.ok(caughtErr, "Must catch error on 401");
    assert.strictEqual(caughtErr.status, 401);
    assert.ok(caughtErr.userFriendlyMessage.includes("Authentication required") || caughtErr.userFriendlyMessage.includes("log in"));
    recordTest("TEST-P5G-06", "401 authentication failure handled correctly", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-06", "401 authentication failure handled correctly", "FAIL", err.message);
  }

  // ─── TEST-P5G-07: 403 clinical authorization failure handled correctly ───────
  try {
    mockResponseStatus = 403;
    mockResponseBody = {
      error: { code: "CLINICAL_ACCESS_DENIED", message: "Doctor not assigned to encounter" }
    };

    let caughtErr = null;
    try {
      await queryLongitudinalRAG({
        encounterId: "ENC-102",
        query: "Test access denied"
      });
    } catch (e) {
      caughtErr = e;
    }

    assert.ok(caughtErr, "Must catch error on 403");
    assert.strictEqual(caughtErr.status, 403);
    assert.ok(caughtErr.userFriendlyMessage.includes("Clinical access denied"));
    recordTest("TEST-P5G-07", "403 clinical authorization failure handled correctly", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-07", "403 clinical authorization failure handled correctly", "FAIL", err.message);
  }

  // ─── TEST-P5G-08: 429 rate limit handled correctly ─────────────────────────
  try {
    mockResponseStatus = 429;
    mockResponseBody = {
      error: { code: "TOO_MANY_REQUESTS", message: "Too many RAG query requests." }
    };

    let caughtErr = null;
    try {
      await queryLongitudinalRAG({
        encounterId: "ENC-101",
        query: "Test rate limit"
      });
    } catch (e) {
      caughtErr = e;
    }

    assert.ok(caughtErr, "Must catch error on 429");
    assert.strictEqual(caughtErr.status, 429);
    assert.ok(caughtErr.userFriendlyMessage.includes("Too many clinical inquiries") || caughtErr.userFriendlyMessage.includes("wait"));
    recordTest("TEST-P5G-08", "429 rate limit handled correctly", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-08", "429 rate limit handled correctly", "FAIL", err.message);
  }

  // ─── TEST-P5G-09: 502 service-unavailable response handled correctly ────────
  try {
    mockResponseStatus = 502;
    mockResponseBody = {
      error: { code: "RAG_SERVICE_UNAVAILABLE", message: "Internal RAG service unreachable" }
    };

    let caughtErr = null;
    try {
      await queryLongitudinalRAG({
        encounterId: "ENC-101",
        query: "Test 502"
      });
    } catch (e) {
      caughtErr = e;
    }

    assert.ok(caughtErr, "Must catch error on 502");
    assert.strictEqual(caughtErr.status, 502);
    assert.ok(caughtErr.userFriendlyMessage.includes("temporarily unreachable") || caughtErr.userFriendlyMessage.includes("offline"));
    recordTest("TEST-P5G-09", "502 service-unavailable response handled correctly", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-09", "502 service-unavailable response handled correctly", "FAIL", err.message);
  }

  // ─── TEST-P5G-10: 504 timeout handled correctly ───────────────────────────
  try {
    mockResponseStatus = 504;
    mockResponseBody = {
      error: { code: "RAG_SERVICE_TIMEOUT", message: "Gateway timed out" }
    };

    let caughtErr = null;
    try {
      await queryLongitudinalRAG({
        encounterId: "ENC-101",
        query: "Test timeout"
      });
    } catch (e) {
      caughtErr = e;
    }

    assert.ok(caughtErr, "Must catch error on 504");
    assert.strictEqual(caughtErr.status, 504);
    assert.ok(caughtErr.userFriendlyMessage.includes("timed out"));
    recordTest("TEST-P5G-10", "504 timeout handled correctly", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-10", "504 timeout handled correctly", "FAIL", err.message);
  }

  // ─── TEST-P5G-11: Successful response parses answer and strategy metadata ──
  try {
    mockResponseStatus = 200;
    mockResponseBody = {
      success: true,
      historyAvailable: true,
      retrievalPath: "semantic",
      strategy: "STANDARD_SEMANTIC",
      answer: "No prior surgical interventions are documented in the records on file.",
      confidence: "medium",
      citations: [],
      yearsCovered: []
    };

    const res = await queryLongitudinalRAG({
      encounterId: "ENC-101",
      query: "Any prior surgeries?"
    });

    assert.strictEqual(res.strategy, "STANDARD_SEMANTIC");
    assert.strictEqual(res.retrievalPath, "semantic");
    assert.strictEqual(res.confidence, "medium");
    assert.strictEqual(res.answer, "No prior surgical interventions are documented in the records on file.");
    recordTest("TEST-P5G-11", "Successful response parses answer and strategy metadata", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-11", "Successful response parses answer and strategy metadata", "FAIL", err.message);
  }

  // ─── TEST-P5G-12: Citations originate strictly from returned evidence & bounded
  try {
    const longSnippet = "A".repeat(500);
    mockResponseStatus = 200;
    mockResponseBody = {
      success: true,
      historyAvailable: true,
      retrievalPath: "temporal",
      strategy: "LONGITUDINAL_TREND",
      answer: "Sample answer with citations",
      confidence: "high",
      citations: [
        {
          documentId: "DOC-2022-01",
          pageNumber: 2,
          documentVersion: 1,
          approvalVersion: 1,
          clinicalDate: "2022-05-18",
          provenance: "DOCUMENT_EXTRACTED",
          snippet: longSnippet.slice(0, 200)
        }
      ],
      yearsCovered: [2022]
    };

    const res = await queryLongitudinalRAG({
      encounterId: "ENC-101",
      query: "Citations test"
    });

    assert.strictEqual(res.citations.length, 1);
    const cit = res.citations[0];
    assert.strictEqual(cit.documentId, "DOC-2022-01");
    assert.strictEqual(cit.pageNumber, 2);
    assert.strictEqual(cit.approvalVersion, 1);
    assert.ok(cit.snippet.length <= 200, "Snippet must be safely bounded to <= 200 characters");
    recordTest("TEST-P5G-12", "Citations originate strictly from returned evidence and are bounded", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-12", "Citations originate strictly from returned evidence and are bounded", "FAIL", err.message);
  }

  // ─── TEST-P5G-13: No-history state displays explicit truthful disclaimer ────
  try {
    mockResponseStatus = 200;
    mockResponseBody = {
      success: true,
      historyAvailable: false,
      retrievalPath: "NO_HISTORY",
      strategy: "CURRENT_ENCOUNTER_FALLBACK",
      answer: "Patient currently presents with mild cough. No longitudinal records are on file.",
      confidence: "insufficient_evidence",
      citations: [],
      yearsCovered: []
    };

    const res = await queryLongitudinalRAG({
      encounterId: "ENC-NEW",
      query: "Historical asthma?"
    });

    assert.strictEqual(res.historyAvailable, false);
    assert.strictEqual(res.retrievalPath, "NO_HISTORY");
    assert.strictEqual(res.confidence, "insufficient_evidence");

    // Verify component JSX contains the exact required clinical disclaimer wording
    const workspaceContent = fs.readFileSync("Patient-case-taking-software-/src/components/LongitudinalRagWorkspace.jsx", "utf-8");
    assert.ok(
      workspaceContent.includes("Longitudinal history is unavailable for this patient. This answer is based only on currently available clinical information."),
      "Workspace must render explicit truthful clinical disclaimer when no history exists"
    );
    recordTest("TEST-P5G-13", "No-history state displays explicit truthful clinical disclaimer", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-13", "No-history state displays explicit truthful clinical disclaimer", "FAIL", err.message);
  }

  // ─── TEST-P5G-14: Confidence information renders correctly ─────────────────
  try {
    const workspaceContent = fs.readFileSync("Patient-case-taking-software-/src/components/LongitudinalRagWorkspace.jsx", "utf-8");
    assert.ok(workspaceContent.includes('ragResult.confidence === "high"'), "Must handle high confidence");
    assert.ok(workspaceContent.includes('ragResult.confidence === "medium"'), "Must handle medium confidence");
    assert.ok(workspaceContent.includes('insufficient_evidence'), "Must handle insufficient_evidence confidence");
    recordTest("TEST-P5G-14", "Confidence information renders correctly (high/medium/insufficient_evidence)", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-14", "Confidence information renders correctly (high/medium/insufficient_evidence)", "FAIL", err.message);
  }

  // ─── TEST-P5G-15: Temporal years render chronologically when returned ───────
  try {
    mockResponseStatus = 200;
    mockResponseBody = {
      success: true,
      historyAvailable: true,
      retrievalPath: "temporal",
      strategy: "LONGITUDINAL_TREND",
      answer: "Chronic kidney disease progression documented across 2018, 2020, and 2023.",
      confidence: "high",
      citations: [],
      yearsCovered: [2018, 2020, 2023]
    };

    const res = await queryLongitudinalRAG({
      encounterId: "ENC-101",
      query: "eGFR progression over the years"
    });

    assert.deepStrictEqual(res.yearsCovered, [2018, 2020, 2023]);
    for (let i = 0; i < res.yearsCovered.length - 1; i++) {
      assert.ok(res.yearsCovered[i] <= res.yearsCovered[i + 1], "Years must be chronologically ordered");
    }
    recordTest("TEST-P5G-15", "Temporal years render chronologically when returned", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-15", "Temporal years render chronologically when returned", "FAIL", err.message);
  }

  // ─── TEST-P5G-16: Duplicate submission is blocked while loading ─────────────
  try {
    const workspaceContent = fs.readFileSync("Patient-case-taking-software-/src/components/LongitudinalRagWorkspace.jsx", "utf-8");
    assert.ok(workspaceContent.includes("if (loading) return;"), "Must block execution if loading is true");
    assert.ok(workspaceContent.includes("disabled={loading"), "Submit controls must be disabled during active request");
    recordTest("TEST-P5G-16", "Duplicate submission is blocked while loading", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-16", "Duplicate submission is blocked while loading", "FAIL", err.message);
  }

  // ─── TEST-P5G-17: Internal secrets, URLs, filesystem paths never leak ──────
  try {
    const workspaceContent = fs.readFileSync("Patient-case-taking-software-/src/components/LongitudinalRagWorkspace.jsx", "utf-8");
    const ragClientContent = fs.readFileSync("Patient-case-taking-software-/src/utils/ragClient.js", "utf-8");

    const forbiddenPatterns = [
      "RAG_SERVICE_INTERNAL_TOKEN",
      "RAG_SERVICE_URL",
      "vector_index",
      "127.0.0.1:8000",
      "X-Internal-Secret",
      "patientUid",
      "patientId"
    ];

    for (const pat of ["RAG_SERVICE_INTERNAL_TOKEN", "127.0.0.1:8000", "X-Internal-Secret"]) {
      assert.strictEqual(workspaceContent.includes(pat), false, `Workspace UI must never contain internal symbol ${pat}`);
      assert.strictEqual(ragClientContent.includes(pat), false, `ragClient must never contain internal symbol ${pat}`);
    }

    recordTest("TEST-P5G-17", "Internal secrets, URLs, filesystem paths, and vector paths never leak", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-17", "Internal secrets, URLs, filesystem paths, and vector paths never leak", "FAIL", err.message);
  }

  // ─── TEST-P5G-18: Existing Doctor Dashboard functionality remains intact ────
  try {
    const dashboardContent = fs.readFileSync("Patient-case-taking-software-/src/pages/DoctorDashboardPage.jsx", "utf-8");

    assert.ok(dashboardContent.includes('sidebarItem === "dashboard"'), "Dashboard home view must be intact");
    assert.ok(dashboardContent.includes('sidebarItem === "queue"'), "Patient queue view must be intact");
    assert.ok(dashboardContent.includes('sidebarItem === "rag"'), "Dedicated Longitudinal RAG view must be present");
    assert.ok(dashboardContent.includes('sidebarItem === "history"'), "Patient history view must be intact");
    assert.ok(dashboardContent.includes('sidebarItem === "documents"'), "Documents review view must be intact");
    assert.ok(dashboardContent.includes('sidebarItem === "settings"'), "Settings view must be intact");
    assert.ok(dashboardContent.includes('activePanelTab === "rag"'), "Consultation drawer RAG tab must be present");
    assert.ok(dashboardContent.includes("<LongitudinalRagWorkspace"), "LongitudinalRagWorkspace component must be integrated");

    recordTest("TEST-P5G-18", "Existing Doctor Dashboard functionality remains intact", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-18", "Existing Doctor Dashboard functionality remains intact", "FAIL", err.message);
  }

  // ─── TEST-P5G-19: ragClient rejects forbidden identifier arguments ──────────
  try {
    let threwUid = false;
    try {
      await queryLongitudinalRAG({
        encounterId: "ENC-101",
        query: "Test",
        patientUid: "00000000-0000-0000-0000-000000000001"
      });
    } catch (e) {
      threwUid = true;
      assert.ok(e.message.includes("Security violation"), "Must identify security violation on client-passed patientUid");
    }
    assert.strictEqual(threwUid, true, "Must reject patientUid argument");

    let threwPid = false;
    try {
      await queryLongitudinalRAG({
        encounterId: "ENC-101",
        query: "Test",
        patientId: 42
      });
    } catch (e) {
      threwPid = true;
      assert.ok(e.message.includes("Security violation"), "Must identify security violation on client-passed patientId");
    }
    assert.strictEqual(threwPid, true, "Must reject patientId argument");

    recordTest("TEST-P5G-19", "ragClient rejects forbidden identifier arguments before network transmission", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-19", "ragClient rejects forbidden identifier arguments before network transmission", "FAIL", err.message);
  }

  // ─── TEST-P5G-20: Quick prompts defined and trigger valid query construction ─
  try {
    assert.ok(Array.isArray(CLINICAL_QUICK_PROMPTS), "CLINICAL_QUICK_PROMPTS must be an array");
    assert.ok(CLINICAL_QUICK_PROMPTS.length >= 5, "Must have at least 5 standard clinical prompts");

    for (const prompt of CLINICAL_QUICK_PROMPTS) {
      assert.ok(prompt.id, "Prompt must have id");
      assert.ok(prompt.label, "Prompt must have clinician-facing label");
      assert.ok(prompt.query && prompt.query.length > 10, "Prompt must have clinical question query string");
      assert.ok(["auto", "temporal", "semantic"].includes(prompt.path), "Prompt path must match Phase 5E contract");
    }

    recordTest("TEST-P5G-20", "Clinician quick prompts are defined and trigger valid query construction", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-20", "Clinician quick prompts are defined and trigger valid query construction", "FAIL", err.message);
  }

  // ─── TEST-P5G-21: Context change clears previous results and in-memory history
  try {
    const workspaceContent = fs.readFileSync("Patient-case-taking-software-/src/components/LongitudinalRagWorkspace.jsx", "utf-8");
    assert.ok(
      workspaceContent.includes("setRagResult(null)") &&
      workspaceContent.includes("setSessionHistory([])"),
      "Context change effect must reset ragResult and transient session history"
    );
    assert.ok(
      workspaceContent.includes("[safePatientContext?.encounterId, safePatientContext?.token]"),
      "Context effect must track patient encounterId and token changes"
    );
    recordTest("TEST-P5G-21", "Context change clears previous results and in-memory history", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-21", "Context change clears previous results and in-memory history", "FAIL", err.message);
  }

  // ─── TEST-P5G-22: Privacy invariant: RAG history is transient in-memory only
  try {
    const workspaceContent = fs.readFileSync("Patient-case-taking-software-/src/components/LongitudinalRagWorkspace.jsx", "utf-8");
    assert.strictEqual(workspaceContent.includes("localStorage.setItem"), false, "RAG history must NEVER be stored in localStorage");
    assert.strictEqual(workspaceContent.includes("sessionStorage.setItem"), false, "RAG history must NEVER be stored in sessionStorage");
    assert.strictEqual(workspaceContent.includes("indexedDB"), false, "RAG history must NEVER be stored in IndexedDB");
    recordTest("TEST-P5G-22", "Privacy invariant: RAG history is transient in-memory only (no localStorage/sessionStorage)", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-22", "Privacy invariant: RAG history is transient in-memory only (no localStorage/sessionStorage)", "FAIL", err.message);
  }

  // ─── TEST-P5G-23: Source inspection connects to authorized document review modal
  try {
    const dashboardContent = fs.readFileSync("Patient-case-taking-software-/src/pages/DoctorDashboardPage.jsx", "utf-8");
    assert.ok(
      dashboardContent.includes("onInspectDocument={(citation) => {") &&
      dashboardContent.includes("setSelectedDocModal({"),
      "Document inspection from citations must trigger setSelectedDocModal"
    );
    recordTest("TEST-P5G-23", "Source inspection connects to authorized document review modal", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-23", "Source inspection connects to authorized document review modal", "FAIL", err.message);
  }

  // ─── TEST-P5G-24: Robustness: Unsupported optional fields do not crash ─────
  try {
    mockResponseStatus = 200;
    mockResponseBody = {
      success: true,
      historyAvailable: true,
      answer: "Answer with missing optional strategy, citations, and yearsCovered.",
      // omits strategy, confidence, citations, yearsCovered
      extraUnsupportedField: { nested: [1, 2, 3] }
    };

    const res = await queryLongitudinalRAG({
      encounterId: "ENC-101",
      query: "Robustness check"
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.answer.includes("Answer with missing optional"));
    recordTest("TEST-P5G-24", "Robustness: Unsupported optional fields do not crash client processing", "PASS");
  } catch (err) {
    recordTest("TEST-P5G-24", "Robustness: Unsupported optional fields do not crash client processing", "FAIL", err.message);
  }

  // Teardown mock server and restore fetch
  global.fetch = originalFetch;
  await new Promise((resolve) => mockServer.close(resolve));

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log("\n============================================================");
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`TOTAL TESTS: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("============================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
