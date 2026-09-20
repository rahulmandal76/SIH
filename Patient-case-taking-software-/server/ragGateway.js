/**
 * Production Node.js Gateway for Longitudinal RAG — Phase 5F
 * server/ragGateway.js
 *
 * Implements:
 *   - Browser Request Contract Validation (Strict rejection of patientUid/patientId)
 *   - Context Identity Derivation (Derives patientUid from encounterId or careRelationshipId)
 *   - Authentication & Role Authorization (ms_user_session strictly required; doctor & admin only)
 *   - Clinical Access Gating (Assigned Encounter OR Active CareRelationship)
 *   - Admin Access Reason Enforcement (X-Admin-Access-Reason 5–500 chars)
 *   - Internal Service Call with Server-Side X-Internal-Secret
 *   - Response Validation & Sanitization (Zero leakage of patientUid, file paths, or secrets)
 *   - Citation Schema Normalization (Bounded snippet, document attribution)
 *   - Relational Audit Logging (QUERY_LONGITUDINAL_RAG)
 *   - Deterministic Error Mapping (401, 403, 400, 409, 502, 504, 500)
 */

import { createAuditLog } from "./audit.js";

// ─── Constants & Configuration ───────────────────────────────────────────────
const FORBIDDEN_ID_KEYS = [
  "patientuid",
  "patientid",
  "patient_uid",
  "patient_id",
  "patient_uid_override",
  "patient_id_override"
];

const DEFAULT_RAG_SERVICE_URL = "http://127.0.0.1:8000";
const RAG_GATEWAY_TIMEOUT_MS = 8000;

// Rate limiting store for RAG queries: 60 queries per 10 minutes per IP/user
const RAG_RATE_WINDOW_MS = 10 * 60 * 1000;
const RAG_RATE_MAX = 60;
const ragRateLimitStore = new Map();

export function resetRagRateLimit() {
  ragRateLimitStore.clear();
}

export function ragRateLimiter(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const userKey = req.user?.id ? `user_${req.user.id}` : `ip_${ip}`;
  const now = Date.now();
  const rec = ragRateLimitStore.get(userKey) || { count: 0, windowStart: now };

  if (now - rec.windowStart > RAG_RATE_WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count++;
  ragRateLimitStore.set(userKey, rec);

  if (rec.count > RAG_RATE_MAX) {
    return res.status(429).json({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: `Too many RAG query requests. Limit is ${RAG_RATE_MAX} per 10 minutes.`,
        requestId: res.getHeader("X-Request-Id") || req.requestId || "unknown"
      }
    });
  }
  next();
}

// ─── 1. Browser Request Validation ───────────────────────────────────────────
export function validateBrowserRagQuery(req) {
  // Check body for forbidden identifiers
  if (req.body && typeof req.body === "object") {
    for (const key of Object.keys(req.body)) {
      if (FORBIDDEN_ID_KEYS.includes(key.toLowerCase())) {
        return {
          valid: false,
          error: "VALIDATION_ERROR",
          message: "patientUid and patientId parameters are strictly forbidden in browser requests. Clinical context is derived server-side."
        };
      }
    }
  }

  // Check query parameters for forbidden identifiers
  if (req.query && typeof req.query === "object") {
    for (const key of Object.keys(req.query)) {
      if (FORBIDDEN_ID_KEYS.includes(key.toLowerCase())) {
        return {
          valid: false,
          error: "VALIDATION_ERROR",
          message: "patientUid and patientId query parameters are strictly forbidden. Clinical context is derived server-side."
        };
      }
    }
  }

  // Validate query text
  const rawQuery = req.body?.query;
  if (!rawQuery || typeof rawQuery !== "string" || !rawQuery.trim()) {
    return {
      valid: false,
      error: "VALIDATION_ERROR",
      message: "Query is required and must not be empty."
    };
  }
  const trimmedQuery = rawQuery.trim();
  if (trimmedQuery.length > 2000) {
    return {
      valid: false,
      error: "VALIDATION_ERROR",
      message: "Query exceeds the maximum allowable length of 2000 characters."
    };
  }

  // Validate topK
  let topK = 6;
  if (req.body?.topK !== undefined && req.body?.topK !== null) {
    const parsedTopK = Number(req.body.topK);
    if (!Number.isInteger(parsedTopK) || parsedTopK < 1 || parsedTopK > 20) {
      return {
        valid: false,
        error: "VALIDATION_ERROR",
        message: "topK must be an integer between 1 and 20."
      };
    }
    topK = parsedTopK;
  }

  // Validate year
  let year = null;
  if (req.body?.year !== undefined && req.body?.year !== null && req.body?.year !== "") {
    const parsedYear = Number(req.body.year);
    if (!Number.isInteger(parsedYear) || parsedYear < 1900 || parsedYear > 2100) {
      return {
        valid: false,
        error: "VALIDATION_ERROR",
        message: "year must be a valid calendar year between 1900 and 2100."
      };
    }
    year = parsedYear;
  }

  // Validate retrievalPath
  let retrievalPath = "auto";
  if (req.body?.retrievalPath) {
    const pathLower = String(req.body.retrievalPath).toLowerCase();
    if (!["auto", "semantic", "temporal"].includes(pathLower)) {
      return {
        valid: false,
        error: "VALIDATION_ERROR",
        message: "retrievalPath must be one of: 'auto', 'semantic', 'temporal'."
      };
    }
    retrievalPath = pathLower;
  }

  // Validate clinical context identifiers
  const encounterId = req.body?.encounterId ? String(req.body.encounterId).trim() : null;
  const careRelationshipId = req.body?.careRelationshipId !== undefined && req.body?.careRelationshipId !== null && req.body?.careRelationshipId !== ""
    ? req.body.careRelationshipId
    : null;

  if (!encounterId && !careRelationshipId) {
    return {
      valid: false,
      error: "VALIDATION_ERROR",
      message: "A valid clinical context (encounterId or careRelationshipId) is required to resolve patient identity."
    };
  }

  return {
    valid: true,
    encounterId,
    careRelationshipId,
    query: trimmedQuery,
    topK,
    year,
    retrievalPath
  };
}

// ─── 2. Authentication & Clinical Authorization ──────────────────────────────
export async function authorizeAndResolvePatient(prisma, req, { encounterId, careRelationshipId }) {
  // Reject patient encounter and device terminal sessions explicitly
  if (req.device || req.encounterSession) {
    return {
      authorized: false,
      status: 403,
      error: "CLINICAL_ACCESS_DENIED",
      message: "Longitudinal clinical RAG is restricted to authorized clinicians and administrators. Patient and device sessions are denied."
    };
  }

  // Require valid ms_user_session
  if (!req.user) {
    return {
      authorized: false,
      status: 401,
      error: "RAG_AUTH_REQUIRED",
      message: "User authentication required (ms_user_session)."
    };
  }

  const role = req.user.role;
  if (role !== "doctor" && role !== "admin") {
    return {
      authorized: false,
      status: 403,
      error: "CLINICAL_ACCESS_DENIED",
      message: "User role unauthorized for longitudinal clinical RAG."
    };
  }

  // Admin access requires non-empty X-Admin-Access-Reason header
  let adminReason = null;
  if (role === "admin") {
    const headerReason = req.headers["x-admin-access-reason"];
    if (!headerReason || typeof headerReason !== "string" || headerReason.trim().length < 5 || headerReason.trim().length > 500) {
      return {
        authorized: false,
        status: 403,
        error: "ADMIN_ACCESS_REASON_REQUIRED",
        message: "Administrative access strictly requires non-empty X-Admin-Access-Reason header (5-500 characters)."
      };
    }
    adminReason = headerReason.trim();
  }

  // ── Context 1: Encounter Resolution & Authorization ──
  let encounter = null;
  let encounterPatientUid = null;
  if (encounterId) {
    encounter = await prisma.encounter.findUnique({
      where: { encounterId },
      include: { patient: true }
    });
    if (!encounter) {
      return {
        authorized: false,
        status: 404,
        error: "VALIDATION_ERROR",
        message: `Encounter '${encounterId}' not found.`
      };
    }
    encounterPatientUid = encounter.patientUid;

    if (role === "doctor") {
      // 1. Check if doctor is directly assigned to this encounter
      const isAssigned = (encounter.assignedDoctorId === req.user.id);

      // 2. Check if doctor has an active CareRelationship for this patient
      const activeCareRel = await prisma.careRelationship.findFirst({
        where: {
          patientUid: encounter.patientUid,
          doctorId: req.user.id,
          status: "active",
          endedAt: null,
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } }
          ]
        }
      });

      if (!isAssigned && !activeCareRel) {
        return {
          authorized: false,
          status: 403,
          error: "CLINICAL_ACCESS_DENIED",
          message: "Doctor is not assigned to this encounter and has no active care relationship with the patient."
        };
      }
    }
  }

  // ── Context 2: CareRelationship Resolution & Authorization ──
  let careRel = null;
  let careRelPatientUid = null;
  if (careRelationshipId !== null) {
    const relIdNum = parseInt(careRelationshipId, 10);
    if (isNaN(relIdNum)) {
      return {
        authorized: false,
        status: 400,
        error: "VALIDATION_ERROR",
        message: "careRelationshipId must be an integer."
      };
    }
    careRel = await prisma.careRelationship.findUnique({
      where: { id: relIdNum }
    });
    if (!careRel) {
      return {
        authorized: false,
        status: 404,
        error: "CARE_RELATIONSHIP_NOT_FOUND",
        message: `Care relationship '${relIdNum}' not found.`
      };
    }
    careRelPatientUid = careRel.patientUid;

    // Cross-context consistency check if both encounter and careRelationship are provided
    if (encounterPatientUid && careRelPatientUid && encounterPatientUid !== careRelPatientUid) {
      return {
        authorized: false,
        status: 409,
        error: "CONTEXT_MISMATCH",
        message: "Supplied encounterId and careRelationshipId resolve to different patient records."
      };
    }

    if (role === "doctor") {
      // Must belong to calling doctor
      if (careRel.doctorId !== req.user.id) {
        return {
          authorized: false,
          status: 403,
          error: "CLINICAL_ACCESS_DENIED",
          message: "Care relationship belongs to another clinician."
        };
      }
      // Must be active and not ended
      if (careRel.status !== "active" || careRel.endedAt !== null) {
        return {
          authorized: false,
          status: 403,
          error: "CLINICAL_ACCESS_DENIED",
          message: `Care relationship is ${careRel.status || 'ended'}.`
        };
      }
      // Must not be expired
      if (careRel.expiresAt && new Date(careRel.expiresAt) <= new Date()) {
        return {
          authorized: false,
          status: 403,
          error: "CLINICAL_ACCESS_DENIED",
          message: "Care relationship has expired."
        };
      }
    }
  }

  // ── Cross-Context Consistency Check ──
  if (encounterPatientUid && careRelPatientUid && encounterPatientUid !== careRelPatientUid) {
    return {
      authorized: false,
      status: 409,
      error: "CONTEXT_MISMATCH",
      message: "Supplied encounterId and careRelationshipId resolve to different patient records."
    };
  }

  const targetPatientUid = encounterPatientUid || careRelPatientUid;
  return {
    authorized: true,
    patientUid: targetPatientUid,
    encounter,
    careRel,
    adminReason
  };
}

// ─── 3. Internal FastAPI Call ────────────────────────────────────────────────
export async function executeFastApiRagQuery({
  patientUid,
  query,
  topK,
  year,
  retrievalPath,
  encounter,
  timeoutMs = RAG_GATEWAY_TIMEOUT_MS
}) {
  const secret = (process.env.RAG_SERVICE_INTERNAL_TOKEN || "").trim();
  if (!secret) {
    return {
      success: false,
      status: 500,
      error: "RAG_RESPONSE_INVALID",
      message: "Internal RAG service configuration error: missing internal authentication token."
    };
  }

  const rawUrl = (process.env.RAG_SERVICE_URL || DEFAULT_RAG_SERVICE_URL).trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Invalid protocol");
    }
  } catch {
    return {
      success: false,
      status: 500,
      error: "RAG_RESPONSE_INVALID",
      message: "Internal RAG service configuration error: invalid service URL."
    };
  }
  const baseUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, "");

  const payload = {
    patientUid,
    query,
    topK,
    year: year || null,
    retrievalPath: retrievalPath || "auto"
  };

  if (encounter) {
    payload.currentEncounterContext = {
      tokenNumber: encounter.tokenNumber ? String(encounter.tokenNumber) : null,
      chiefComplaint: encounter.chiefComplaint || null,
      intakeSummary: encounter.hpi || encounter.intakeConversation || null
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${baseUrl}/api/internal/rag/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": secret
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    const status = resp.status;
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }

    if (status === 200 && body && typeof body === "object" && body.success === true) {
      return { success: true, data: body };
    }

    if (status === 401) {
      return {
        success: false,
        status: 500,
        error: "INTERNAL_ERROR",
        message: "Internal RAG service authentication failed."
      };
    }
    if (status === 400 || status === 422) {
      return {
        success: false,
        status: 400,
        error: "VALIDATION_ERROR",
        message: body?.detail?.message || "RAG query validation failed."
      };
    }
    if (status === 504) {
      return {
        success: false,
        status: 504,
        error: "RAG_SERVICE_TIMEOUT",
        message: "Internal RAG service execution timed out."
      };
    }

    return {
      success: false,
      status: 500,
      error: "RAG_RESPONSE_INVALID",
      message: body?.detail?.message || "Internal RAG service returned an error."
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return {
        success: false,
        status: 504,
        error: "RAG_SERVICE_TIMEOUT",
        message: `Internal RAG service timed out (${timeoutMs}ms bound).`
      };
    }
    return {
      success: false,
      status: 502,
      error: "RAG_SERVICE_UNAVAILABLE",
      message: `Internal RAG service is unreachable or offline: ${err.message}`
    };
  }
}

// ─── 4. Response Validation & Sanitization ───────────────────────────────────
export function validateAndSanitizeFastApiResponse(rawData) {
  if (!rawData || typeof rawData !== "object") {
    throw new Error("RAG response must be a valid JSON object.");
  }
  if (typeof rawData.success !== "boolean") {
    throw new Error("RAG response missing boolean 'success' field.");
  }
  if (typeof rawData.answer !== "string") {
    throw new Error("RAG response missing string 'answer' field.");
  }

  // Sanitize citations
  const rawCitations = Array.isArray(rawData.citations) ? rawData.citations : [];
  const sanitizedCitations = rawCitations.map(c => ({
    documentId: String(c.documentId || ""),
    pageNumber: Math.max(1, parseInt(c.pageNumber, 10) || 1),
    documentVersion: Math.max(1, parseInt(c.documentVersion, 10) || 1),
    approvalVersion: Math.max(1, parseInt(c.approvalVersion, 10) || 1),
    clinicalDate: c.clinicalDate ? String(c.clinicalDate) : null,
    clinicalYear: c.clinicalYear ? parseInt(c.clinicalYear, 10) : null,
    provenance: String(c.provenance || "DOCUMENT_EXTRACTED"),
    snippet: String(c.snippet || "").slice(0, 200),
    relevanceScore: typeof c.relevanceScore === "number" ? Math.round(c.relevanceScore * 10000) / 10000 : 0
  }));

  // Clean years covered
  const yearsCovered = Array.isArray(rawData.yearsCovered)
    ? rawData.yearsCovered.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
    : [];

  return {
    success: true,
    historyAvailable: Boolean(rawData.historyAvailable),
    retrievalPath: String(rawData.retrievalPath || "auto"),
    strategy: String(rawData.strategy || "STANDARD_SEMANTIC"),
    answer: String(rawData.answer || ""),
    confidence: String(rawData.confidence || (rawData.historyAvailable ? "medium" : "insufficient_evidence")),
    citations: sanitizedCitations,
    yearsCovered
  };
}

// ─── 5. Relational Audit Trail ───────────────────────────────────────────────
export async function auditRagQuery(prisma, {
  req,
  patientUid,
  encounter,
  careRel,
  success,
  resultData = null,
  error = null,
  adminReason = null
}) {
  try {
    const resourceType = encounter ? "Encounter" : "Patient";
    const resourceId = encounter ? encounter.encounterId : patientUid;

    const metadata = {
      contextType: encounter ? "encounter" : "care_relationship",
      encounterId: encounter?.encounterId || null,
      careRelationshipId: careRel?.id || null,
      success: Boolean(success),
      adminReason: adminReason || null
    };

    if (resultData) {
      metadata.retrievalPath = resultData.retrievalPath;
      metadata.strategy = resultData.strategy;
      metadata.historyAvailable = resultData.historyAvailable;
      metadata.citationsCount = resultData.citations?.length || 0;
      metadata.confidence = resultData.confidence;
    }
    if (error) {
      metadata.errorCode = error.code;
    }

    await createAuditLog(prisma, {
      actorType: "USER",
      actorUserId: req.user?.id || null,
      action: "QUERY_LONGITUDINAL_RAG",
      patientUid,
      resourceType,
      resourceId,
      metadata
    });
  } catch (err) {
    console.error("[RAGGateway:AuditError]", err.message);
  }
}
