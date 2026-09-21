/**
 * Phase 13 Live AI Smoke Test
 * scripts/test_live_gemini.js
 *
 * Verifies:
 *   - Real communication with Google GenAI API using @google/genai
 *   - Accurate extraction of canonical prescription fields (Date: 25 Oct 2023, Dr. Amit K. Verma)
 *   - Dual-path evidence verification of clinical facts
 *   - Zero synthetic fallback
 *   - Clean skip if GEMINI_API_KEY is not configured
 */

import path from "path";
import dotenv from "dotenv";
import { documentAiExtractor } from "../Patient-case-taking-software-/server/documentAiExtractor.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const CANONICAL_PRESCRIPTION_TEXT = `DISTRICT HOSPITAL CLINICAL OUTPATIENT RECORD
Date: 25 Oct 2023
Doctor: Dr. Amit K. Verma, MD (General Medicine)
Patient: Mr. Rajesh
Age: 42 years
Gender: Male

Clinical Assessment & Findings:
Known case of Type 2 Diabetes Mellitus and Essential Hypertension.
Blood Pressure: 140/90 mmHg, Pulse: 78 bpm.

Rx:
1. Tab. Metformin 500 mg - 1 tablet twice daily after meals (BD)
2. Tab. Telmisartan 40 mg - 1 tablet once daily in morning (OD)
3. Tab. Aspirin 75 mg - 1 tablet once daily after lunch (OD)

Advice: Low carbohydrate and low salt diet. Routine exercise for 30 minutes.
Review after 4 weeks with Fasting Blood Sugar and Lipid Profile.`;

async function runLiveAiTest() {
  console.log("=======================================================");
  console.log("PHASE 13: LIVE GEMINI MULTIMODAL EXTRACTION SMOKE TEST");
  console.log("=======================================================");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey === "your_gemini_api_key_here") {
    console.log("⚠️  SKIPPED: GEMINI_API_KEY is not configured in .env. Skipping live AI test.");
    process.exit(0);
  }

  console.log(`[INIT] Calling Google GenAI with model: ${process.env.DOCUMENT_AI_MODEL || "gemini-flash-latest"}...`);
  const startTime = Date.now();

  try {
    const result = await documentAiExtractor.extractDocument({
      documentId: "DOC-LIVE-TEST-001",
      patientUid: "00000000-0000-0000-0000-000000000001",
      pageNumber: 1,
      rawOcrText: CANONICAL_PRESCRIPTION_TEXT
    });

    const elapsed = Date.now() - startTime;
    console.log(`[SUCCESS] Live AI response received in ${elapsed} ms.`);
    console.log(` - Provider: ${result.provider}`);
    console.log(` - Model: ${result.model}`);
    console.log(` - Prompt Version: ${result.promptVersion}`);
    console.log(` - Clinical Date: ${result.clinicalDate ? result.clinicalDate.toISOString().slice(0, 10) : "NULL"}`);
    console.log(` - Doctor Name: ${result.doctorName}`);
    console.log(` - Patient Name: ${result.patientName} (${result.patientAge})`);
    console.log(` - Facility: ${result.facilityName}`);
    console.log(` - Triage Suggestion: ${result.triageSuggestion}`);
    console.log(` - Facts Extracted: ${result.facts.length}`);

    // Verification 1: True date must be 2023-10-25 (NEVER today's date)
    const dateStr = result.clinicalDate ? result.clinicalDate.toISOString().slice(0, 10) : "";
    if (dateStr !== "2023-10-25") {
      throw new Error(`CANONICAL_DATE_FAIL: Expected 2023-10-25, got ${dateStr}`);
    }
    console.log("✅ [ASSERT 1] Canonical document date (2023-10-25) correctly parsed; zero current-date fallback.");

    // Verification 2: Doctor must be Dr. Amit K. Verma (NEVER Dr. Sharma)
    if (!result.doctorName || !result.doctorName.toLowerCase().includes("verma")) {
      throw new Error(`CANONICAL_DOCTOR_FAIL: Expected Dr. Amit K. Verma, got ${result.doctorName}`);
    }
    if (result.doctorName.toLowerCase().includes("sharma")) {
      throw new Error(`FAKE_DOCTOR_DETECTED: Extracted fake doctor 'Dr. Sharma'`);
    }
    console.log("✅ [ASSERT 2] Canonical physician (Dr. Amit K. Verma) correctly extracted; zero fake doctor substitution.");

    // Verification 3: Metformin extracted with verified evidence
    const metforminFact = result.facts.find(f => f.factKey.toLowerCase().includes("metformin"));
    if (!metforminFact) {
      throw new Error("CANONICAL_MED_FAIL: Metformin fact not extracted");
    }
    if (metforminFact.evidenceStatus !== "VERIFIED") {
      throw new Error(`EVIDENCE_VERIF_FAIL: Metformin evidence status is ${metforminFact.evidenceStatus}, expected VERIFIED`);
    }
    console.log("✅ [ASSERT 3] Medication (Metformin) extracted and evidenceStatus is VERIFIED via dual-path matching.");

    // Verification 4: Provenance must be DOCUMENT_EXTRACTED or OCR_EXTRACTED, never DOCTOR_APPROVED
    for (const f of result.facts) {
      if (f.provenance === "DOCTOR_APPROVED") {
        throw new Error("PROVENANCE_VIOLATION: Fact marked as DOCTOR_APPROVED before physician sign-off");
      }
    }
    console.log("✅ [ASSERT 4] All facts strictly carry non-authoritative provenance (DOCUMENT_EXTRACTED); zero auto-approval.");

    console.log("\n=======================================================");
    console.log("ALL LIVE GEMINI INTEGRATION ASSERTIONS PASSED!");
    console.log("=======================================================");
    process.exit(0);
  } catch (err) {
    console.error("❌ LIVE AI TEST FAILED:", err.message);
    process.exit(1);
  }
}

runLiveAiTest();
