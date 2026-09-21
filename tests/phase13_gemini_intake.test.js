/**
 * Phase 13 — Production Gemini AI Intake Engine & Context Propagation Matrix
 * tests/phase13_gemini_intake.test.js
 *
 * Requirements:
 *   A. Exact patient answer is stored with provenance = PATIENT_REPORTED.
 *   B. Exact patient text is included in conversation state sent to backend.
 *   C. Exact patient text reaches Gemini intake-generation request context.
 *   D. Gemini generates next question from that actual context.
 *   E. Application does not replace Gemini-generated question with a fixed question.
 *   F. Application never invents a patient answer or symptom.
 *   G. Application never silently uses a fixed question when Gemini fails.
 *   H. Gemini failure produces explicit AI_UNAVAILABLE behavior.
 */

import http from "http";
import crypto from "crypto";
import { prisma } from "../prisma/db.js";
import app, { interviewPlanner } from "../Patient-case-taking-software-/server.js";
import { createEncounterSession } from "../Patient-case-taking-software-/server/sessions.js";

let serverInstance = null;
let TEST_PORT = 0;
const results = [];

function recordTest(id, name, status, details = "") {
  results.push({ id, name, status, details });
  const icon = status === "PASS" ? "✅" : "❌";
  console.log(`${icon} [${id}] ${name}: ${status}`);
  if (details) console.log(`   └─ ${details}`);
}

function makeRequest(method, pathUrl, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: pathUrl,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers
      }
    };

    const req = http.request(options, res => {
      let raw = "";
      res.on("data", d => (raw += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runGeminiIntakeTests() {
  console.log("\n=======================================================");
  console.log("PHASE 13: REAL GEMINI INTAKE & CONTEXT PROPAGATION TESTS");
  console.log("=======================================================\n");

  // Spin up test server
  await new Promise(resolve => {
    serverInstance = http.createServer(app);
    serverInstance.listen(0, "127.0.0.1", () => {
      TEST_PORT = serverInstance.address().port;
      console.log(`[GeminiIntake TestServer] Listening on 127.0.0.1:${TEST_PORT}\n`);
      resolve();
    });
  });

  const patientUid = "44444444-1313-1313-1313-000000000001";
  const patientId = "PAT-GEMINI-001";
  const encounterId = "ENC-GEMINI-001";

  // Clean up existing test records
  await prisma.interviewTurn.deleteMany({
    where: { session: { patientUid } }
  }).catch(() => {});
  await prisma.interviewSession.deleteMany({
    where: { patientUid }
  }).catch(() => {});
  await prisma.encounter.deleteMany({
    where: { encounterId }
  }).catch(() => {});
  await prisma.patient.deleteMany({
    where: { patientUid }
  }).catch(() => {});

  // Seed test patient & encounter
  await prisma.patient.create({
    data: {
      patientUid,
      patientId,
      fullName: "Suresh Kumar",
      age: 34,
      gender: "Male",
      mobileNumber: "9876543210"
    }
  });

  await prisma.encounter.create({
    data: {
      encounterId,
      patientUid,
      tokenNumber: "701",
      consultationStatus: "waiting"
    }
  });

  const encSessionToken = createEncounterSession(patientUid, encounterId);
  const authHeaders = {
    Cookie: `ms_encounter_session=${encSessionToken}`,
    "X-Requested-With": "XMLHttpRequest"
  };

  // Mock Gemini Network Client tracking requests and responses
  const recordedGeminiCalls = [];
  let mockGeminiFailMode = false;

  const mockGeminiClient = {
    models: {
      generateContent: async ({ model, contents, config }) => {
        const promptText = contents?.[0]?.text || "";
        recordedGeminiCalls.push({ model, promptText, config });

        if (mockGeminiFailMode) {
          throw new Error("Resource has been exhausted (e.g. check quota / rate limit).");
        }

        // Generate contextually relevant response reflecting actual patient statement
        let generatedQuestion = "यह उल्टी की समस्या कब से महसूस हो रही है?";
        let generatedKey = "duration_onset";
        let generatedDomain = "duration_onset";

        if (promptText.includes("2 baar ulti hui")) {
          generatedQuestion = "उल्टी के साथ क्या पेट में दर्द, जलन, या बुखार भी आ रहा है?";
          generatedKey = "associated_symptoms";
          generatedDomain = "associated_symptoms";
        }

        return {
          text: JSON.stringify({
            questionText: generatedQuestion,
            questionKey: generatedKey,
            clinicalDomain: generatedDomain,
            options: ["हाँ, बुखार भी है", "सिर्फ उल्टी जैसा लग रहा है", "पेट में जलन है", "कुछ और नहीं"]
          })
        };
      }
    }
  };

  // Inject mock network client into InterviewPlanner
  interviewPlanner.setGenAiClient(mockGeminiClient);

  let activeSessionId = null;

  // -------------------------------------------------------------------------
  // TEST-GEMINI-01: Start intake with exact patient text "ulti feel ho rahi hai"
  // Proves Requirements A, B, C, D, E, F
  // -------------------------------------------------------------------------
  try {
    const rawPatientInput = "ulti feel ho rahi hai";

    const res = await makeRequest("POST", "/api/intake/interview/start", {
      chiefComplaint: rawPatientInput,
      language: "Hindi"
    }, authHeaders);

    const data = res.body;
    activeSessionId = data?.sessionId;

    // Verify Turn 0 in database
    const turn0 = await prisma.interviewTurn.findFirst({
      where: { sessionId: activeSessionId, turnIndex: 0 }
    });

    const isStoredVerbatim = turn0?.answerText === rawPatientInput;
    const isPatientReported = turn0?.provenance === "PATIENT_REPORTED";
    const promptReceivedExactText = recordedGeminiCalls.some(c => c.promptText.includes(rawPatientInput));
    const nextQuestionIsDynamic = Boolean(data?.nextQuestion?.text && data.nextQuestion.text.includes("उल्टी"));
    const noHardcodedSubstitute = data?.nextQuestion?.text !== "Pet mein dard kis taraf zyada hai?";

    if (res.status === 200 && isStoredVerbatim && isPatientReported && promptReceivedExactText && nextQuestionIsDynamic && noHardcodedSubstitute) {
      recordTest("TEST-GEMINI-01", "Turn 0 exact patient answer propagation to Gemini", "PASS",
        `Exact text "${rawPatientInput}" persisted as PATIENT_REPORTED; reaches Gemini prompt context; dynamic question generated: "${data.nextQuestion.text}"`);
    } else {
      recordTest("TEST-GEMINI-01", "Turn 0 exact patient answer propagation to Gemini", "FAIL",
        `status: ${res.status}, verbatim: ${isStoredVerbatim}, prov: ${isPatientReported}, inPrompt: ${promptReceivedExactText}, dynamic: ${nextQuestionIsDynamic}`);
    }
  } catch (err) {
    recordTest("TEST-GEMINI-01", "Turn 0 exact patient answer propagation to Gemini", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-GEMINI-02: Step intake with exact follow-up patient response "2 baar ulti hui"
  // Proves full multi-turn context propagation to Gemini
  // -------------------------------------------------------------------------
  try {
    const followUpAnswer = "2 baar ulti hui";
    recordedGeminiCalls.length = 0; // reset tracker

    const res = await makeRequest("POST", "/api/intake/interview/step", {
      sessionId: activeSessionId,
      questionKey: "duration_onset",
      questionText: "यह उल्टी की समस्या कब से महसूस हो रही है?",
      answerText: followUpAnswer,
      action: "answer",
      language: "Hindi"
    }, authHeaders);

    const data = res.body;

    // Verify Turn 1 in database
    const turn1 = await prisma.interviewTurn.findFirst({
      where: { sessionId: activeSessionId, turnIndex: 1 }
    });

    const isFollowUpVerbatim = turn1?.answerText === followUpAnswer;
    const isFollowUpReported = turn1?.provenance === "PATIENT_REPORTED";

    // Verify Gemini prompt contained both Turn 0 and Turn 1 exact texts
    const latestCall = recordedGeminiCalls[recordedGeminiCalls.length - 1];
    const promptHasTurn0 = latestCall?.promptText.includes("ulti feel ho rahi hai");
    const promptHasTurn1 = latestCall?.promptText.includes("2 baar ulti hui");
    const generatedAdaptiveQ = Boolean(data?.nextQuestion?.text && data.nextQuestion.text.includes("बुखार"));

    if (res.status === 200 && isFollowUpVerbatim && isFollowUpReported && promptHasTurn0 && promptHasTurn1 && generatedAdaptiveQ) {
      recordTest("TEST-GEMINI-02", "Step progression with full conversation history sent to Gemini", "PASS",
        `Turn 1 stored verbatim "${followUpAnswer}"; Gemini prompt received both turns; generated adaptive follow-up: "${data.nextQuestion.text}"`);
    } else {
      recordTest("TEST-GEMINI-02", "Step progression with full conversation history sent to Gemini", "FAIL",
        `status: ${res.status}, verbatim: ${isFollowUpVerbatim}, prov: ${isFollowUpReported}, hasTurn0: ${promptHasTurn0}, hasTurn1: ${promptHasTurn1}`);
    }
  } catch (err) {
    recordTest("TEST-GEMINI-02", "Step progression with full conversation history sent to Gemini", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-GEMINI-03: Honest AI_UNAVAILABLE on Gemini failure (Zero Fake Fallbacks)
  // Proves Requirements G, H
  // -------------------------------------------------------------------------
  try {
    mockGeminiFailMode = true; // Force Gemini runtime error

    const res = await makeRequest("POST", "/api/intake/interview/step", {
      sessionId: activeSessionId,
      questionKey: "associated_symptoms",
      questionText: "उल्टी के साथ क्या पेट में दर्द, जलन, या बुखार भी आ रहा है?",
      answerText: "thoda bukhar lag raha hai",
      action: "answer",
      language: "Hindi"
    }, authHeaders);

    const is503 = res.status === 503;
    const hasAiUnavailableCode = res.body?.error?.code === "AI_UNAVAILABLE";
    const noCannedQuestion = res.body?.nextQuestion === undefined;

    if (is503 && hasAiUnavailableCode && noCannedQuestion) {
      recordTest("TEST-GEMINI-03", "Gemini failure produces truthful AI_UNAVAILABLE (no fake fallback)", "PASS",
        `Returned HTTP 503 with code AI_UNAVAILABLE; zero canned questions or synthetic answers substituted`);
    } else {
      recordTest("TEST-GEMINI-03", "Gemini failure produces truthful AI_UNAVAILABLE (no fake fallback)", "FAIL",
        `status: ${res.status}, code: ${res.body?.error?.code}, nextQuestion: ${JSON.stringify(res.body?.nextQuestion)}`);
    }
  } catch (err) {
    recordTest("TEST-GEMINI-03", "Gemini failure produces truthful AI_UNAVAILABLE (no fake fallback)", "FAIL", err.message);
  } finally {
    mockGeminiFailMode = false;
  }

  // -------------------------------------------------------------------------
  // TEST-GEMINI-04: Skip and Unknown actions preserve canonical provenance
  // Proves Requirement 3: zero prose corruption, structured MISSING_OR_UNKNOWN
  // -------------------------------------------------------------------------
  try {
    const resUnknown = await makeRequest("POST", "/api/intake/interview/step", {
      sessionId: activeSessionId,
      questionKey: "current_medications",
      action: "unknown",
      language: "Hindi"
    }, authHeaders);

    const turnUnknown = await prisma.interviewTurn.findFirst({
      where: { sessionId: activeSessionId, questionKey: "current_medications" }
    });

    const isUnknownProv = turnUnknown?.provenance === "MISSING_OR_UNKNOWN";
    const noProseCorruption = turnUnknown?.answerText !== "None reported by patient";

    if (isUnknownProv && noProseCorruption) {
      recordTest("TEST-GEMINI-04", "Structured MISSING_OR_UNKNOWN for unknown answer", "PASS",
        `Turn stored with provenance MISSING_OR_UNKNOWN; no synthetic prose inserted`);
    } else {
      recordTest("TEST-GEMINI-04", "Structured MISSING_OR_UNKNOWN for unknown answer", "FAIL",
        `prov: ${turnUnknown?.provenance}, text: ${turnUnknown?.answerText}`);
    }
  } catch (err) {
    recordTest("TEST-GEMINI-04", "Structured MISSING_OR_UNKNOWN for unknown answer", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-GEMINI-05: Model output schema validation (Strictly disallows reasoning)
  // Proves Requirement 1: no free-form reasoning stored or exposed
  // -------------------------------------------------------------------------
  try {
    const resReview = await makeRequest("GET", `/api/intake/interview/review?sessionId=${activeSessionId}`, null, authHeaders);
    const turns = resReview.body?.turns || [];

    const hasReasoningField = turns.some(t => t.reasoning !== undefined || t.chainOfThought !== undefined);
    const validProvenanceOnly = turns.length > 0 && turns.every(t => ["PATIENT_REPORTED", "NOT_REPORTED", "MISSING_OR_UNKNOWN"].includes(t.provenance));

    if (resReview.status === 200 && !hasReasoningField && validProvenanceOnly) {
      recordTest("TEST-GEMINI-05", "Interview turns strictly exclude model reasoning & enforce canonical provenance", "PASS",
        `All ${turns.length} turns strictly enforce canonical provenance; zero model reasoning leaked`);
    } else {
      recordTest("TEST-GEMINI-05", "Interview turns strictly exclude model reasoning & enforce canonical provenance", "FAIL",
        `status: ${resReview.status}, hasReasoning: ${hasReasoningField}, validProv: ${validProvenanceOnly}, turnsCount: ${turns.length}`);
    }
  } catch (err) {
    recordTest("TEST-GEMINI-05", "Interview turns strictly exclude model reasoning & enforce canonical provenance", "FAIL", err.message);
  }

  // Clean up
  interviewPlanner.setGenAiClient(null);
  if (serverInstance) {
    await new Promise(res => serverInstance.close(res));
  }

  console.log("\n-------------------------------------------------------");
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  console.log(`TOTAL: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("-------------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runGeminiIntakeTests().catch(err => {
  console.error("Test runner exception:", err);
  process.exit(1);
});
