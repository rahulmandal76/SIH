import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { getGeminiApiKeys, executeWithGeminiKeyFailover } from "./geminiKeyRotator.js";

// --------------------------------------------------------------------------
// Runtime Configuration for Production Intake AI
// --------------------------------------------------------------------------
export function getIntakeAiConfig() {
  const keys = getGeminiApiKeys();
  return {
    provider: process.env.INTERVIEW_AI_PROVIDER || process.env.DOCUMENT_AI_PROVIDER || "gemini",
    model: process.env.INTERVIEW_AI_MODEL || "gemini-3.5-flash-lite",
    timeoutMs: parseInt(process.env.INTERVIEW_AI_TIMEOUT_MS || process.env.DOCUMENT_AI_TIMEOUT_MS || "15000", 10),
    maxRetries: parseInt(process.env.INTERVIEW_AI_MAX_RETRIES || "2", 10),
    apiKey: keys[0] || "",
    apiKeys: keys
  };
}

// --------------------------------------------------------------------------
// Clinical Domains Framework & Guardrails
// --------------------------------------------------------------------------
export const CLINICAL_DOMAINS = [
  "duration_onset",
  "severity_character",
  "radiation_spread",
  "aggravating_relieving",
  "associated_symptoms",
  "current_medications"
];

// --------------------------------------------------------------------------
// InterviewPlanner: Real Gemini Runtime Intake Engine with Clinical Guardrails
// --------------------------------------------------------------------------
export class InterviewPlanner {
  constructor(prismaClient, options = {}) {
    this.prisma = prismaClient;
    this.MAX_QUESTIONS = 5;
    this.aiConfig = options.aiConfig || null;
    this.genAiClient = options.genAiClient || null; // For deterministic test boundary injection
  }

  setGenAiClient(client) {
    this.genAiClient = client;
  }

  getGenAiClient() {
    return this.genAiClient;
  }

  /**
   * Classify complaint into a clinical category
   * Evaluates Latin, Hinglish, and native Devanagari script
   */
  classifyComplaint(text = "") {
    const lower = text.toLowerCase();

    // 1. Cardiac / Chest / Severe Vascular
    if (
      lower.includes("chest") ||
      lower.includes("seene") ||
      lower.includes("सीने") ||
      lower.includes("छाती") ||
      lower.includes("dil") ||
      lower.includes("दिल") ||
      lower.includes("heart") ||
      lower.includes("ghabrahat") ||
      lower.includes("घबराहट") ||
      lower.includes("left arm") ||
      lower.includes("baayein") ||
      lower.includes("बाएं")
    ) {
      return "CARDIAC_CHEST";
    }

    // 2. Respiratory / Pulmonary
    if (
      lower.includes("khansi") ||
      lower.includes("खांसी") ||
      lower.includes("cough") ||
      lower.includes("jukam") ||
      lower.includes("जुकाम") ||
      lower.includes("cold") ||
      lower.includes("gala") ||
      lower.includes("गला") ||
      lower.includes("throat") ||
      lower.includes("balgam") ||
      lower.includes("बलगम") ||
      lower.includes("phlegm") ||
      lower.includes("saans") ||
      lower.includes("सांस") ||
      lower.includes("breath") ||
      lower.includes("asthma")
    ) {
      return "RESPIRATORY";
    }

    // 3. Gastrointestinal / Abdomen
    if (
      lower.includes("pet") ||
      lower.includes("पेट") ||
      lower.includes("stomach") ||
      lower.includes("ulti") ||
      lower.includes("उल्टी") ||
      lower.includes("vomit") ||
      lower.includes("dast") ||
      lower.includes("दस्त") ||
      lower.includes("loose") ||
      lower.includes("gas") ||
      lower.includes("गैस") ||
      lower.includes("acidity") ||
      lower.includes("jalan") ||
      lower.includes("जलन") ||
      lower.includes("kabz") ||
      lower.includes("कब्ज") ||
      lower.includes("motion")
    ) {
      return "GASTROINTESTINAL";
    }

    return "GENERAL";
  }

  /**
   * Detect pre-covered dimensions directly in text (chief complaint or free-text answers)
   */
  detectPreCoveredDimensions(text = "") {
    const covered = new Set();
    const lower = text.toLowerCase();

    // Duration mentions
    if (
      lower.includes("din") ||
      lower.includes("दिन") ||
      lower.includes("day") ||
      lower.includes("hafte") ||
      lower.includes("हफ्ते") ||
      lower.includes("week") ||
      lower.includes("mahine") ||
      lower.includes("महीने") ||
      lower.includes("month") ||
      lower.includes("subah") ||
      lower.includes("सुबह") ||
      lower.includes("aaj") ||
      lower.includes("आज") ||
      lower.includes("yesterday") ||
      lower.includes("kal") ||
      lower.includes("कल")
    ) {
      covered.add("duration_onset");
    }

    // Severity / Character mentions
    if (
      lower.includes("tez") ||
      lower.includes("तेज") ||
      lower.includes("severe") ||
      lower.includes("halka") ||
      lower.includes("हल्का") ||
      lower.includes("mild") ||
      lower.includes("sookhi") ||
      lower.includes("सूखी") ||
      lower.includes("dabav") ||
      lower.includes("दबाव") ||
      lower.includes("भारी") ||
      lower.includes("dard") ||
      lower.includes("दर्द") ||
      lower.includes("jalan") ||
      lower.includes("जलन")
    ) {
      covered.add("severity_character");
    }

    // Radiation / Spread mentions
    if (
      lower.includes("baayein") ||
      lower.includes("बाएं") ||
      lower.includes("arm") ||
      lower.includes("haath") ||
      lower.includes("हाथ") ||
      lower.includes("peeth") ||
      lower.includes("पीठ") ||
      lower.includes("back") ||
      lower.includes("kandhe") ||
      lower.includes("कंधे") ||
      lower.includes("shoulder") ||
      lower.includes("jabde") ||
      lower.includes("jaw")
    ) {
      covered.add("radiation_spread");
    }

    // Aggravating / Relieving mentions
    if (
      lower.includes("chalne") ||
      lower.includes("चलने") ||
      lower.includes("seedhi") ||
      lower.includes("सीढ़ी") ||
      lower.includes("stairs") ||
      lower.includes("walk") ||
      lower.includes("aaram") ||
      lower.includes("आराम") ||
      lower.includes("rest") ||
      lower.includes("khana") ||
      lower.includes("खाना") ||
      lower.includes("eating")
    ) {
      covered.add("aggravating_relieving");
    }

    // Associated symptoms mentions
    if (
      lower.includes("pasina") ||
      lower.includes("पसीना") ||
      lower.includes("sweat") ||
      lower.includes("ghabrahat") ||
      lower.includes("घबराहट") ||
      lower.includes("palpitation") ||
      lower.includes("chakkar") ||
      lower.includes("चक्कर") ||
      lower.includes("dizzy") ||
      lower.includes("bukhar") ||
      lower.includes("बुखार") ||
      lower.includes("fever")
    ) {
      covered.add("associated_symptoms");
    }

    // Medication mentions
    if (
      lower.includes("dawa") ||
      lower.includes("दवा") ||
      lower.includes("goli") ||
      lower.includes("गोली") ||
      lower.includes("syrup") ||
      lower.includes("सिरप") ||
      lower.includes("tablet") ||
      lower.includes("medicine")
    ) {
      covered.add("current_medications");
    }

    return covered;
  }

  /**
   * Aggregate all covered clinical dimensions across all turns
   */
  detectAllCoveredDimensions(turns = []) {
    const covered = new Set();
    const initialTurn = turns.find(t => t.turnIndex === 0);
    if (initialTurn?.answerText) {
      for (const d of this.detectPreCoveredDimensions(initialTurn.answerText)) {
        covered.add(d);
      }
    }
    for (const t of turns) {
      if (t.turnIndex > 0 && t.questionKey) {
        covered.add(t.questionKey);
        if (t.answerText && t.answerType === "answered") {
          for (const d of this.detectPreCoveredDimensions(t.answerText)) {
            covered.add(d);
          }
        }
      }
    }
    return covered;
  }

  /**
   * Select next uncovered clinical domain based on priority
   */
  selectNextDomain(category, coveredSet) {
    const priority = [
      "duration_onset",
      "severity_character",
      "radiation_spread",
      "aggravating_relieving",
      "associated_symptoms",
      "current_medications"
    ];

    for (const key of priority) {
      if (!coveredSet.has(key)) {
        return key;
      }
    }
    return null; // All core domains covered
  }

  /**
   * Core Gemini AI Question Generation
   * Generates next clinical question adaptively from actual conversation state.
   * Disallows free-form model reasoning; returns structured question object.
   */
  async generateNextQuestionWithGemini({
    chiefComplaint,
    conversationHistory = [],
    latestAnswer = "",
    coveredDomains = [],
    complaintCategory = "GENERAL",
    language = "Hindi",
    currentStep = 1
  }) {
    const config = this.aiConfig || getIntakeAiConfig();
    const remainingDomains = CLINICAL_DOMAINS.filter(d => !coveredDomains.includes(d));
    const targetDomain = this.selectNextDomain(complaintCategory, new Set(coveredDomains)) || "associated_symptoms";

    const activeText = latestAnswer || chiefComplaint || "";
    const isLatinScript = /^[a-zA-Z0-9\s.,!?'"()\-–—]+$/.test(activeText.trim());
    const isHinglish = language === "Hinglish" || (language !== "English" && isLatinScript);

    const languageInstruction = language === "English"
      ? "English: Generate question and options in clear, empathetic clinical English."
      : isHinglish
        ? "Hinglish: The patient communicates in conversational Hinglish (Roman script). Ask the question and provide quick-tap options in natural, conversational Hinglish (Roman script, e.g. 'Aapko ulti jaisa kab se feel ho raha hai?')."
        : "Hindi: The patient communicates in Hindi (Devanagari script). Ask the question and provide quick-tap options in natural, conversational Hindi using Devanagari script (e.g. 'यह उल्टी की समस्या कब से महसूस हो रही है?').";

    const systemInstruction = `You are the Gemini Clinical Intake AI for an intelligent hospital kiosk.
Your task is to generate the single NEXT clinical question for a patient check-in interview.

CORE CLINICAL & ETHICAL RULES:
1. The uploaded/user-provided patient responses are trusted as patient-reported content.
2. Generate the next question using the actual conversation context and previous patient answers.
3. Do not invent patient symptoms.
4. Do not invent patient answers.
5. Do not assume an unreported symptom.
6. Do not repeat already answered questions or already covered clinical domains.
7. Stay strictly within the defined clinical framework (focus on: duration_onset, severity_character, radiation_spread, aggravating_relieving, associated_symptoms, current_medications).
8. Ask exactly ONE appropriate, concise, and empathetic next question at a time.
9. Prefer continuity with the latest patient response (e.g. if the patient reports nausea or vomiting, focus your next clinical question directly on that reported symptom).
10. LANGUAGE & SCRIPT INSTRUCTION: ${languageInstruction}
11. Do not provide a diagnosis as if it were established.
12. Do not convert AI inference into PATIENT_REPORTED information.

OUTPUT SCHEMA (JSON ONLY):
{
  "questionText": "Single clear next clinical question to ask the patient",
  "questionKey": "${targetDomain}",
  "clinicalDomain": "${targetDomain}",
  "options": ["Up to 4 short contextual options for quick tap matching the patient's language style, or empty array []"]
}
DO NOT include any free-form 'reasoning' or chain-of-thought field in the response. Return strictly valid JSON.`;

    const formattedHistory = conversationHistory.map(turn => {
      const q = turn.questionText || "Initial chief complaint inquiry";
      const a = turn.answerText || "";
      const prov = turn.provenance || "PATIENT_REPORTED";
      return `[Turn ${turn.turnIndex}] Question: "${q}" -> Patient Answer (${prov}): "${a}"`;
    }).join("\n");

    const userPrompt = `PATIENT INTERVIEW STATE:
- Primary Chief Complaint (PATIENT_REPORTED): "${chiefComplaint}"
- Clinical Category: ${complaintCategory}
- Current Interview Step: ${currentStep} of ${this.MAX_QUESTIONS}
- Clinical Domains Already Covered: [${coveredDomains.join(", ")}]
- Clinically Relevant Domains Remaining: [${remainingDomains.join(", ")}]
- Target Clinical Domain for this Turn: ${targetDomain}
- Latest Patient Response (PATIENT_REPORTED): "${latestAnswer || chiefComplaint}"
- Preferred Language Mode: ${isHinglish ? "Hinglish (Roman Script)" : language}

FULL CONVERSATION HISTORY TO DATE:
${formattedHistory || `[Turn 0] Patient Answer (PATIENT_REPORTED): "${chiefComplaint}"`}

TASK:
Based on the patient's actual reported statements, generate the single NEXT question within the clinical framework targeting ${targetDomain}. Ensure continuity with the latest patient statement and match the patient's language (${isHinglish ? "conversational Hinglish in Roman script" : language}).`;

    try {
      let responseText = "";

      if (this.genAiClient) {
        // Injected mock client for tests (requirement 7)
        const res = await this.genAiClient.models.generateContent({
          model: config.model || "gemini-3.8-flash",
          contents: [{ text: userPrompt }],
          config: {
            systemInstruction,
            temperature: 0.2,
            responseMimeType: "application/json"
          }
        });
        responseText = res.text || "{}";
      } else {
        const availableKeys = (config.apiKeys && config.apiKeys.length > 0)
          ? config.apiKeys
          : getGeminiApiKeys();

        if (availableKeys.length === 0) {
          const err = new Error("AI_UNAVAILABLE: No Gemini API keys configured for production intake");
          err.code = "AI_UNAVAILABLE";
          throw err;
        }

        const candidateModels = [
          config.model || "gemini-2.5-flash",
          "gemini-2.5-flash",
          "gemini-2.0-flash",
          "gemini-1.5-flash",
          "gemini-flash-latest",
          "gemini-3.5-flash-lite"
        ];
        const modelsToTry = [...new Set(candidateModels)];

        responseText = await executeWithGeminiKeyFailover(async (activeApiKey, keyIdx, totalKeys) => {
          let lastModelError = null;
          for (const currentModel of modelsToTry) {
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                const ai = new GoogleGenAI({ apiKey: activeApiKey });
                const res = await ai.models.generateContent({
                  model: currentModel,
                  contents: [{ text: userPrompt }],
                  config: {
                    systemInstruction,
                    temperature: 0.2,
                    responseMimeType: "application/json"
                  }
                });
                return res.text || "{}";
              } catch (err) {
                lastModelError = err;
                const isSpike = err.status === 503 || err.message?.includes("503") || err.message?.includes("high demand") || err.message?.includes("temporary");
                if (isSpike && attempt < 2) {
                  await new Promise(r => setTimeout(r, 1200));
                  continue;
                }
                break;
              }
            }
          }
          throw lastModelError || new Error("All candidate models failed for key");
        }, { explicitKeys: availableKeys });
      }

      const cleaned = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (!parsed.questionText || typeof parsed.questionText !== "string") {
        throw new Error("Invalid Gemini response: missing questionText");
      }

      // Explicitly sanitize output: DO NOT expose or persist reasoning
      return {
        questionKey: parsed.questionKey || targetDomain,
        clinicalDomain: parsed.clinicalDomain || targetDomain,
        text: parsed.questionText.trim(),
        options: Array.isArray(parsed.options) ? parsed.options.slice(0, 4) : []
      };
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") {
        throw err;
      }
      const error = new Error(`AI_UNAVAILABLE: Failed to generate question via Gemini runtime (${err.message})`);
      error.code = "AI_UNAVAILABLE";
      error.originalError = err;
      throw error;
    }
  }

  /**
   * Start a new dynamic interview session
   * Idempotent: If an active session exists for this encounterId, returns it without creating a duplicate.
   */
  async startSession({ patientUid, encounterId, chiefComplaint, language = "Hindi" }) {
    if (!patientUid || !encounterId) {
      throw new Error("patientUid and encounterId are required to start an interview session");
    }

    // Idempotency check: Look for existing active or completed session on this encounter
    const existingSession = await this.prisma.interviewSession.findFirst({
      where: {
        encounterId,
        status: { in: ["in_progress", "review_dirty", "completed"] }
      },
      include: { turns: { orderBy: { turnIndex: "asc" } } }
    });

    if (existingSession) {
      const allCovered = this.detectAllCoveredDimensions(existingSession.turns);
      if (existingSession.status === "completed") {
        const turns = await this.getReview(existingSession.sessionId);
        return {
          sessionId: existingSession.sessionId,
          status: "completed",
          category: existingSession.complaintCategory,
          currentStep: existingSession.totalQuestions,
          totalQuestions: this.MAX_QUESTIONS,
          coveredDomains: Array.from(allCovered),
          nextQuestion: null,
          isComplete: true,
          isExisting: true,
          reviewSummary: turns
        };
      }

      // Existing in-progress or review_dirty session
      const chiefTurn = existingSession.turns.find(t => t.turnIndex === 0);
      const lastTurn = existingSession.turns[existingSession.turns.length - 1];
      const nextQuestion = await this.generateNextQuestionWithGemini({
        chiefComplaint: chiefTurn?.answerText || "",
        conversationHistory: existingSession.turns,
        latestAnswer: lastTurn?.answerText || chiefTurn?.answerText || "",
        coveredDomains: Array.from(allCovered),
        complaintCategory: existingSession.complaintCategory,
        language,
        currentStep: Math.min(existingSession.totalQuestions + 1, this.MAX_QUESTIONS)
      });

      return {
        sessionId: existingSession.sessionId,
        status: existingSession.status,
        category: existingSession.complaintCategory,
        currentStep: Math.min(existingSession.totalQuestions + 1, this.MAX_QUESTIONS),
        totalQuestions: this.MAX_QUESTIONS,
        coveredDomains: Array.from(allCovered),
        nextQuestion,
        isComplete: false,
        isExisting: true
      };
    }

    const sessionId = `intv_${crypto.randomUUID()}`;
    const category = this.classifyComplaint(chiefComplaint);
    const preCovered = this.detectPreCoveredDimensions(chiefComplaint);

    // Create new session record in database
    const session = await this.prisma.interviewSession.create({
      data: {
        sessionId,
        patientUid,
        encounterId,
        complaintCategory: category,
        status: "in_progress",
        totalQuestions: 0
      }
    });

    // Record initial chief complaint as Turn 0 with exact patient-reported provenance
    const turn0 = await this.prisma.interviewTurn.create({
      data: {
        sessionId,
        turnIndex: 0,
        questionKey: "chief_complaint",
        questionText: "आज आपको क्या तकलीफ है? कृपया अपनी परेशानी बताइए।",
        answerText: chiefComplaint || "",
        answerType: "answered",
        provenance: "PATIENT_REPORTED"
      }
    });

    // Generate Turn 1 question genuinely via configured Gemini runtime
    const questionObj = await this.generateNextQuestionWithGemini({
      chiefComplaint: chiefComplaint || "",
      conversationHistory: [turn0],
      latestAnswer: chiefComplaint || "",
      coveredDomains: Array.from(preCovered),
      complaintCategory: category,
      language,
      currentStep: 1
    });

    return {
      sessionId: session.sessionId,
      status: session.status,
      category,
      currentStep: 1,
      totalQuestions: this.MAX_QUESTIONS,
      coveredDomains: Array.from(preCovered),
      nextQuestion: questionObj,
      isComplete: false,
      isExisting: false
    };
  }

  /**
   * Process patient response (answer, skip, or unknown / "Pata Nahi")
   * Idempotent on retries; strictly enforces lifecycle boundaries.
   * Generates the next question genuinely via Gemini runtime.
   */
  async processStep({ sessionId, questionKey, questionText, answerText, action = "answer", language = "Hindi" }) {
    const session = await this.prisma.interviewSession.findUnique({
      where: { sessionId },
      include: { turns: { orderBy: { turnIndex: "asc" } } }
    });

    if (!session) {
      const err = new Error(`Interview session not found: ${sessionId}`);
      err.code = "NOT_FOUND";
      throw err;
    }

    // Lifecycle Guard: Abandoned sessions cannot accept steps
    if (session.status === "abandoned") {
      const err = new Error("LIFECYCLE_ABANDONED: Cannot advance an abandoned interview session");
      err.code = "INVALID_LIFECYCLE_TRANSITION";
      throw err;
    }

    // Lifecycle Guard: Completed sessions cannot accept steps (must use review/edit)
    if (session.status === "completed") {
      const err = new Error("LIFECYCLE_COMPLETED: Interview session is already completed. Use edit to modify turns.");
      err.code = "INVALID_LIFECYCLE_TRANSITION";
      throw err;
    }

    // Canonical Provenance Reconciliation
    let answerType = "answered";
    let provenance = "PATIENT_REPORTED";
    let finalAnswerText = answerText ? String(answerText).trim() : "";

    if (action === "skip") {
      answerType = "skipped";
      provenance = "NOT_REPORTED";
      finalAnswerText = "[Skipped by patient]";
    } else if (
      action === "unknown" ||
      finalAnswerText.toLowerCase().includes("pata nahi") ||
      finalAnswerText.toLowerCase().includes("don't know")
    ) {
      answerType = "unknown";
      provenance = "MISSING_OR_UNKNOWN";
      finalAnswerText = "[Patient does not know / Pata nahi]";
    }

    // Idempotency / Retry Guard: Did the client retry the exact same questionKey?
    const existingTurn = session.turns.find(t => t.questionKey === questionKey && t.turnIndex > 0);
    if (existingTurn) {
      // Idempotently update the turn without incrementing question count or creating duplicates
      await this.prisma.interviewTurn.update({
        where: { id: existingTurn.id },
        data: { answerText: finalAnswerText, answerType, provenance }
      });

      const allTurns = await this.prisma.interviewTurn.findMany({
        where: { sessionId },
        orderBy: { turnIndex: "asc" }
      });
      const allCovered = this.detectAllCoveredDimensions(allTurns);
      const chiefTurn = allTurns.find(t => t.turnIndex === 0);

      const nextQuestion = await this.generateNextQuestionWithGemini({
        chiefComplaint: chiefTurn?.answerText || "",
        conversationHistory: allTurns,
        latestAnswer: finalAnswerText,
        coveredDomains: Array.from(allCovered),
        complaintCategory: session.complaintCategory,
        language,
        currentStep: Math.min(session.totalQuestions + 1, this.MAX_QUESTIONS)
      });

      return {
        sessionId,
        status: session.status,
        isComplete: false,
        currentStep: Math.min(session.totalQuestions + 1, this.MAX_QUESTIONS),
        totalQuestions: this.MAX_QUESTIONS,
        coveredDomains: Array.from(allCovered),
        nextQuestion,
        isRetry: true
      };
    }

    const nextTurnIndex = session.turns.length;

    // Record new turn in database with exact verbatim answer and provenance
    await this.prisma.interviewTurn.create({
      data: {
        sessionId,
        turnIndex: nextTurnIndex,
        questionKey: questionKey || "followup",
        questionText: questionText || `Clinical inquiry for ${questionKey || "symptom"}`,
        answerText: finalAnswerText,
        answerType,
        provenance
      }
    });

    const newQuestionCount = session.totalQuestions + 1;

    // Aggregate all covered domains
    const covered = new Set();
    for (const t of session.turns) {
      if (t.questionKey) covered.add(t.questionKey);
    }
    if (questionKey) covered.add(questionKey);

    const initialTurn = session.turns.find(t => t.turnIndex === 0);
    if (initialTurn?.answerText) {
      for (const d of this.detectPreCoveredDimensions(initialTurn.answerText)) {
        covered.add(d);
      }
    }
    if (finalAnswerText && answerType === "answered") {
      for (const d of this.detectPreCoveredDimensions(finalAnswerText)) {
        covered.add(d);
      }
    }

    // Termination criteria: max 5 questions reached
    const isTerminated = newQuestionCount >= this.MAX_QUESTIONS;

    if (isTerminated) {
      await this.prisma.interviewSession.update({
        where: { sessionId },
        data: {
          status: "completed",
          totalQuestions: newQuestionCount,
          completedAt: new Date()
        }
      });

      const turns = await this.getReview(sessionId);
      return {
        sessionId,
        status: "completed",
        isComplete: true,
        currentStep: newQuestionCount,
        totalQuestions: this.MAX_QUESTIONS,
        nextQuestion: null,
        coveredDomains: Array.from(covered),
        reviewSummary: turns
      };
    }

    // Prepare updated turn history for Gemini
    const allTurns = await this.prisma.interviewTurn.findMany({
      where: { sessionId },
      orderBy: { turnIndex: "asc" }
    });
    const chiefTurn = allTurns.find(t => t.turnIndex === 0);

    // Advance session in DB
    await this.prisma.interviewSession.update({
      where: { sessionId },
      data: { totalQuestions: newQuestionCount }
    });

    // Generate next question with real Gemini runtime
    const nextQuestion = await this.generateNextQuestionWithGemini({
      chiefComplaint: chiefTurn?.answerText || "",
      conversationHistory: allTurns,
      latestAnswer: finalAnswerText,
      coveredDomains: Array.from(covered),
      complaintCategory: session.complaintCategory,
      language,
      currentStep: newQuestionCount + 1
    });

    return {
      sessionId,
      status: "in_progress",
      isComplete: false,
      currentStep: newQuestionCount + 1,
      totalQuestions: this.MAX_QUESTIONS,
      coveredDomains: Array.from(covered),
      nextQuestion
    };
  }

  /**
   * Retrieve structured review summary for patient verification
   */
  async getReview(sessionId) {
    const turns = await this.prisma.interviewTurn.findMany({
      where: { sessionId },
      orderBy: { turnIndex: "asc" }
    });

    return turns.map(t => ({
      turnIndex: t.turnIndex,
      questionKey: t.questionKey,
      questionText: t.questionText,
      answerText: t.answerText,
      answerType: t.answerType,
      provenance: t.provenance,
      timestamp: t.timestamp
    }));
  }

  /**
   * Patient edits a previously recorded turn
   * Revalidates dependencies: marks session dirty and recomputes category and covered domains.
   */
  async editTurn({ sessionId, turnIndex, newAnswerText }) {
    const session = await this.prisma.interviewSession.findUnique({
      where: { sessionId },
      include: { turns: { orderBy: { turnIndex: "asc" } } }
    });

    if (!session) {
      const err = new Error(`Interview session not found: ${sessionId}`);
      err.code = "NOT_FOUND";
      throw err;
    }

    if (session.status === "abandoned") {
      const err = new Error("LIFECYCLE_ABANDONED: Cannot edit an abandoned interview session");
      err.code = "INVALID_LIFECYCLE_TRANSITION";
      throw err;
    }

    const existing = await this.prisma.interviewTurn.findFirst({
      where: { sessionId, turnIndex: parseInt(turnIndex, 10) }
    });

    if (!existing) {
      throw new Error(`Turn not found at index ${turnIndex}`);
    }

    let answerType = "answered";
    let provenance = "PATIENT_REPORTED";
    let finalAnswerText = String(newAnswerText).trim();

    if (finalAnswerText === "[Skipped by patient]" || finalAnswerText.toLowerCase() === "skip") {
      answerType = "skipped";
      provenance = "NOT_REPORTED";
      finalAnswerText = "[Skipped by patient]";
    } else if (
      finalAnswerText.toLowerCase().includes("pata nahi") ||
      finalAnswerText.toLowerCase().includes("don't know") ||
      finalAnswerText === "[Patient does not know / Pata nahi]"
    ) {
      answerType = "unknown";
      provenance = "MISSING_OR_UNKNOWN";
      finalAnswerText = "[Patient does not know / Pata nahi]";
    }

    const updated = await this.prisma.interviewTurn.update({
      where: { id: existing.id },
      data: {
        answerText: finalAnswerText,
        answerType,
        provenance
      }
    });

    // Revalidate and recompute downstream dependency state
    const allTurns = await this.prisma.interviewTurn.findMany({
      where: { sessionId },
      orderBy: { turnIndex: "asc" }
    });

    let complaintCategory = session.complaintCategory;
    if (parseInt(turnIndex, 10) === 0) {
      complaintCategory = this.classifyComplaint(finalAnswerText);
    }

    const recomputedCovered = this.detectAllCoveredDimensions(allTurns);

    // Mark session review_dirty to prevent stale downstream assumptions
    await this.prisma.interviewSession.update({
      where: { sessionId },
      data: {
        status: "review_dirty",
        complaintCategory
      }
    });

    return {
      success: true,
      turn: {
        turnIndex: updated.turnIndex,
        questionKey: updated.questionKey,
        answerText: updated.answerText,
        answerType: updated.answerType,
        provenance: updated.provenance
      },
      revalidatedState: {
        status: "review_dirty",
        isDirty: true,
        complaintCategory,
        coveredDimensions: Array.from(recomputedCovered)
      }
    };
  }

  /**
   * Finalize intake interview and compile narrative into Encounter
   * Idempotent on repeated calls; re-synthesizes from freshly revalidated turns.
   */
  async submitIntake(sessionId) {
    const session = await this.prisma.interviewSession.findUnique({
      where: { sessionId },
      include: { turns: { orderBy: { turnIndex: "asc" } } }
    });

    if (!session) {
      const err = new Error(`Session ${sessionId} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }

    if (session.status === "abandoned") {
      const err = new Error("LIFECYCLE_ABANDONED: Cannot submit an abandoned interview session");
      err.code = "INVALID_LIFECYCLE_TRANSITION";
      throw err;
    }

    // Repeated submit idempotency: If already completed and not modified (review_dirty), return existing state
    if (session.status === "completed") {
      const chiefComplaint = session.turns.find(t => t.turnIndex === 0)?.answerText || "Clinical visit";
      const turns = session.turns.filter(t => t.answerType === "answered" && t.answerText && !t.answerText.startsWith("["));
      const hpiNarrative = turns.map(t => `${t.questionText}: ${t.answerText}`).join("\n");

      return {
        success: true,
        sessionId,
        encounterId: session.encounterId,
        chiefComplaint,
        hpi: hpiNarrative,
        totalAnswered: turns.length,
        alreadySubmitted: true
      };
    }

    // Build synthesized narrative HPI from validated turns
    const turns = session.turns.filter(t => t.answerType === "answered" && t.answerText && !t.answerText.startsWith("["));
    const chiefComplaint = session.turns.find(t => t.turnIndex === 0)?.answerText || null;

    const hpiLines = turns.map(t => `${t.questionText}: ${t.answerText}`);
    const hpiNarrative = hpiLines.length > 0 ? hpiLines.join("\n") : null;

    const medTurn = session.turns.find(t => t.questionKey === "current_medications" && t.answerType === "answered");
    const currentMedsJson = medTurn?.answerText ? JSON.stringify([medTurn.answerText]) : null;

    // Atomically persist to Encounter and mark InterviewSession completed
    await this.prisma.$transaction([
      this.prisma.encounter.updateMany({
        where: { encounterId: session.encounterId },
        data: {
          chiefComplaint: chiefComplaint || "General check-in",
          hpi: hpiNarrative,
          currentMedsJson,
          intakeConversation: JSON.stringify(session.turns)
        }
      }),
      this.prisma.interviewSession.update({
        where: { sessionId },
        data: {
          status: "completed",
          completedAt: new Date()
        }
      })
    ]);

    return {
      success: true,
      sessionId,
      encounterId: session.encounterId,
      chiefComplaint,
      hpi: hpiNarrative,
      totalAnswered: turns.length,
      revalidated: true
    };
  }
}
