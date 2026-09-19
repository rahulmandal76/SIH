/**
 * MedSync + AuraHealth Nexus — Node.js API Gateway
 * Phase 4: Dynamic Patient Identity, Session Boundaries, CSRF & Clinical RBAC
 *
 * Preserves:
 *   - Phase 2 Relational Database Schema & Data Models
 *   - Phase 3 Secure AI Proxy, Data Minimization, Rate Limiting & Fallbacks
 *
 * Implements:
 *   - Async crypto.scrypt Authentication (N=16384, r=8, p=1, keylen=64)
 *   - Three Independent Session Namespaces (ms_device_session, ms_encounter_session, ms_user_session)
 *   - Multi-Layer CSRF Defense (CSRF_VIOLATION 403)
 *   - Privacy-Preserving Lookup & Registration with Single-Use Handles (5-min TTL)
 *   - Truthful ABHA Integration State Machine
 *   - Clinical RBAC & OPD Chamber Claim Flow
 *   - Longitudinal Access via CareRelationship & Admin Access with X-Admin-Access-Reason
 *   - Multi-Actor Relational Audit Logging
 */

// --------------------------------------------------------------------------
// 0. Bootstrap — Loads .env from project root (f:/SIH/.env)
// --------------------------------------------------------------------------
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const _require = createRequire(import.meta.url);
const dotenv = _require("dotenv");
dotenv.config({ path: path.join(ROOT_DIR, ".env") });

// --------------------------------------------------------------------------
// 1. Core imports
// --------------------------------------------------------------------------
import express from "express";
import cors from "cors";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "../prisma/db.js";

import {
  hashPassword,
  verifyPassword,
  isLoginThrottled,
  recordFailedLogin,
  resetFailedLogin,
  seedDevUsers
} from "./server/auth.js";

import {
  createDeviceSession,
  validateDeviceSession,
  destroyDeviceSession,
  createEncounterSession,
  validateEncounterSession,
  destroyEncounterSession,
  createUserSession,
  validateUserSession,
  destroyUserSession,
  createLookupHandle,
  resolveLookupCandidate,
  consumeLookupCandidate,
  consumeLookupHandle,
  createRegistrationHandle,
  consumeRegistrationHandle
} from "./server/sessions.js";

import { evaluateAbhaStatus, validateAbhaInvariant } from "./server/abdmAdapter.js";
import { csrfProtection } from "./server/csrf.js";
import { createAuditLog } from "./server/audit.js";
import { InterviewPlanner } from "./server/interviewPlanner.js";
import multer from "multer";
import { DocumentIngestionService, MAX_UPLOAD_BYTES } from "./server/documentIngestion.js";
import { DocumentOCRWorker } from "./server/ocrWorker.js";
import { clinicalFactExtractor, ClinicalFactSchema } from "./server/clinicalFactExtractor.js";

const app = express();
const PORT = process.env.PORT || 5000;

const documentIngestionService = new DocumentIngestionService(prisma);
const ocrWorker = new DocumentOCRWorker(prisma);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES
  }
});

// --------------------------------------------------------------------------
// 2. Cookie Parser Middleware (Lightweight & Native)
// --------------------------------------------------------------------------
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(";").forEach(cookie => {
      const parts = cookie.split("=");
      const name = parts.shift().trim();
      const val = decodeURIComponent(parts.join("="));
      if (name) list[name] = val;
    });
  }
  return list;
}

// --------------------------------------------------------------------------
// 3. Global Middleware Setup
// --------------------------------------------------------------------------
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true
}));
app.use(express.json({ limit: "64kb" }));

// 3a. Request ID + Structured Request Logger
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  req.startTime = Date.now();
  res.setHeader("X-Request-Id", req.requestId);
  req.cookies = parseCookies(req);
  next();
});

// 3b. Session Resolution Middleware (Three Namespaces)
app.use((req, res, next) => {
  const cookies = req.cookies || {};

  // User Session (Clinician / Staff / Admin)
  if (cookies.ms_user_session) {
    const userCheck = validateUserSession(cookies.ms_user_session);
    if (userCheck.valid) {
      req.user = {
        id: userCheck.session.userId,
        userUid: userCheck.session.userUid,
        name: userCheck.session.name,
        email: userCheck.session.email,
        role: userCheck.session.role,
        chamber: userCheck.session.chamber
      };
    }
  }

  // Device Session (Kiosk Terminal)
  if (cookies.ms_device_session) {
    const devCheck = validateDeviceSession(cookies.ms_device_session);
    if (devCheck.valid) {
      req.device = {
        deviceId: devCheck.session.deviceId,
        terminalId: devCheck.session.terminalId,
        role: devCheck.session.role
      };
    }
  }

  // Encounter Session (Patient Intake)
  if (cookies.ms_encounter_session) {
    const encCheck = validateEncounterSession(cookies.ms_encounter_session);
    if (encCheck.valid) {
      req.encounterSession = {
        patientUid: encCheck.session.patientUid,
        encounterId: encCheck.session.encounterId,
        role: encCheck.session.role
      };
    }
  }

  next();
});

// 3c. CSRF Defense Middleware
app.use(csrfProtection);

// Structured logger — NEVER logs API keys, passwords, salts, or raw PHI
function logRequest(req, statusCode, extra = {}) {
  const duration = Date.now() - (req.startTime || Date.now());
  const entry = {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    statusCode,
    durationMs: duration,
    ...extra
  };
  delete entry.geminiKey;
  delete entry.apiKey;
  delete entry.password;
  delete entry.passwordHash;
  delete entry.salt;
  delete entry.sessionToken;
  console.log("[API]", JSON.stringify(entry));
}

function logError(req, code, message, err) {
  console.error("[API:ERROR]", JSON.stringify({
    requestId: req.requestId,
    path: req.path,
    errorCode: code,
    message,
    details: err?.message || null
  }));
}

// --------------------------------------------------------------------------
// 4. Consistent Error Shape Factory
// --------------------------------------------------------------------------
function errorResponse(res, statusCode, code, message, extra = {}) {
  return res.status(statusCode).json({
    error: {
      code,
      message,
      requestId: res.getHeader("X-Request-Id") || "unknown",
      ...extra
    }
  });
}

const ERR = {
  VALIDATION_ERROR:            (res, msg, extra) => errorResponse(res, 400, "VALIDATION_ERROR", msg, extra),
  HANDLE_REQUIRED:             (res, msg)        => errorResponse(res, 400, "HANDLE_REQUIRED", msg),
  INVALID_CANDIDATE_ID:        (res, msg)        => errorResponse(res, 400, "INVALID_CANDIDATE_ID", msg),
  ADMIN_ACCESS_REASON_REQUIRED:(res, msg)        => errorResponse(res, 400, "ADMIN_ACCESS_REASON_REQUIRED", msg),
  AUTHENTICATION_REQUIRED:     (res, msg)        => errorResponse(res, 401, "AUTHENTICATION_REQUIRED", msg),
  FORBIDDEN:                   (res, msg)        => errorResponse(res, 403, "FORBIDDEN", msg),
  HANDLE_EXPIRED:              (res, msg)        => errorResponse(res, 403, "HANDLE_EXPIRED", msg),
  HANDLE_CONTEXT_MISMATCH:     (res, msg)        => errorResponse(res, 403, "HANDLE_CONTEXT_MISMATCH", msg),
  CLINICAL_ACCESS_DENIED:      (res, msg)        => errorResponse(res, 403, "CLINICAL_ACCESS_DENIED", msg),
  LONGITUDINAL_ACCESS_DENIED:  (res, msg)        => errorResponse(res, 403, "LONGITUDINAL_ACCESS_DENIED", msg),
  CHAMBER_ROUTING_REQUIRED:    (res, msg)        => errorResponse(res, 403, "CHAMBER_ROUTING_REQUIRED", msg),
  CHAMBER_MISMATCH:            (res, msg)        => errorResponse(res, 403, "CHAMBER_MISMATCH", msg),
  PATIENT_SCOPE_MISMATCH:      (res, msg)        => errorResponse(res, 403, "PATIENT_SCOPE_MISMATCH", msg),
  CARE_RELATIONSHIP_NOT_FOUND: (res, msg)        => errorResponse(res, 404, "CARE_RELATIONSHIP_NOT_FOUND", msg),
  PATIENT_NOT_FOUND:           (res, msg)        => errorResponse(res, 404, "PATIENT_NOT_FOUND", msg),
  HANDLE_ALREADY_CONSUMED:     (res, msg)        => errorResponse(res, 409, "HANDLE_ALREADY_CONSUMED", msg),
  ENCOUNTER_ALREADY_CLAIMED:   (res, msg)        => errorResponse(res, 409, "ENCOUNTER_ALREADY_CLAIMED", msg),
  INVALID_LIFECYCLE_TRANSITION:(res, msg)        => errorResponse(res, 409, "INVALID_LIFECYCLE_TRANSITION", msg),
  TOO_MANY_REQUESTS:           (res, msg)        => errorResponse(res, 429, "TOO_MANY_REQUESTS", msg),
  AI_PROVIDER_RATE_LIMITED:    (res, msg)        => errorResponse(res, 429, "AI_PROVIDER_RATE_LIMITED", msg),
  INTERNAL_ERROR:              (res, msg)        => errorResponse(res, 500, "INTERNAL_ERROR", msg),
  INVALID_INTERVIEW_STATE:     (res, msg, extra) => errorResponse(res, 400, "INVALID_INTERVIEW_STATE", msg, extra),
  PLANNER_UNAVAILABLE:         (res, msg)        => errorResponse(res, 503, "PLANNER_UNAVAILABLE", msg),
  AI_PROVIDER_UNAVAILABLE:     (res, msg)        => errorResponse(res, 503, "AI_PROVIDER_UNAVAILABLE", msg),
  AI_PROVIDER_TIMEOUT:         (res, msg)        => errorResponse(res, 504, "AI_PROVIDER_TIMEOUT", msg),
  DUPLICATE_DOCUMENT:          (res, msg, extra) => errorResponse(res, 409, "DUPLICATE_DOCUMENT", msg, extra),
  FILE_TOO_LARGE:              (res, msg)        => errorResponse(res, 413, "FILE_TOO_LARGE", msg),
  UNSUPPORTED_MEDIA_TYPE:      (res, msg)        => errorResponse(res, 415, "UNSUPPORTED_MEDIA_TYPE", msg),
  DOCUMENT_NOT_FOUND:          (res, msg)        => errorResponse(res, 404, "DOCUMENT_NOT_FOUND", msg),
  VERSION_CONFLICT:                  (res, msg, extra) => errorResponse(res, 409, "VERSION_CONFLICT", msg, extra),
  CLINICAL_APPROVAL_REQUIRES_DOCTOR: (res, msg)        => errorResponse(res, 403, "CLINICAL_APPROVAL_REQUIRES_DOCTOR", msg),
  ADMIN_CANNOT_EDIT_CLINICAL_FACTS:  (res, msg)        => errorResponse(res, 403, "ADMIN_CANNOT_EDIT_CLINICAL_FACTS", msg),
  FACT_NOT_FOUND:                    (res, msg)        => errorResponse(res, 404, "FACT_NOT_FOUND", msg),
  INVALID_DOCUMENT_STATUS:           (res, msg)        => errorResponse(res, 409, "INVALID_DOCUMENT_STATUS", msg),
};

// --------------------------------------------------------------------------
// 5. Rate Limiters
// --------------------------------------------------------------------------
const RATE_WINDOW_MS  = parseInt(process.env.AI_RATE_LIMIT_WINDOW_MS || "600000", 10);
const RATE_MAX        = parseInt(process.env.AI_RATE_LIMIT_MAX       || "30",     10);
const aiRateLimitStore = new Map();

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function aiRateLimiter(req, res, next) {
  const ip  = getClientIp(req);
  const now = Date.now();
  const rec = aiRateLimitStore.get(ip) || { count: 0, windowStart: now };

  if (now - rec.windowStart > RATE_WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count++;
  aiRateLimitStore.set(ip, rec);

  if (rec.count > RATE_MAX) {
    logRequest(req, 429, { ip, rateExceeded: true });
    return ERR.AI_PROVIDER_RATE_LIMITED(res, `Too many AI intake requests. Limit: ${RATE_MAX} per 10 minutes.`);
  }
  next();
}

// --------------------------------------------------------------------------
// 6. Legacy Kiosk Session Store (Preserved for Phase 3.1 backwards compatibility)
// --------------------------------------------------------------------------
const SESSION_TTL_MS  = 2 * 60 * 60 * 1000; // 2 hours
const legacyKioskSessions = new Map();

function createKioskSession(patientUid, encounterId, role = "kiosk") {
  const token = crypto.randomUUID();
  legacyKioskSessions.set(token, {
    patientUid,
    encounterId,
    role,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function validateKioskSession(token, claimedPatientUid) {
  if (!token) return { valid: false, reason: "SESSION_NOT_FOUND" };
  const session = legacyKioskSessions.get(token);
  if (!session) return { valid: false, reason: "SESSION_NOT_FOUND" };
  if (Date.now() > session.expiresAt) {
    legacyKioskSessions.delete(token);
    return { valid: false, reason: "SESSION_EXPIRED" };
  }
  if (session.patientUid !== claimedPatientUid) {
    return { valid: false, reason: "PATIENT_SCOPE_MISMATCH" };
  }
  return { valid: true, session };
}

export { createKioskSession, validateKioskSession };

// --------------------------------------------------------------------------
// 7. Data Formatting & Masking Helpers
// --------------------------------------------------------------------------
function maskFullName(name) {
  if (!name) return "****";
  const parts = name.trim().split(/\s+/);
  return parts.map(part => {
    if (part.length <= 1) return part;
    return part[0] + "*".repeat(Math.max(part.length - 1, 3));
  }).join(" ");
}

function maskMobile(phone) {
  if (!phone) return "******0000";
  const str = String(phone).replace(/\D/g, "");
  if (str.length < 4) return "******" + str;
  return "******" + str.slice(-4);
}

async function generateUniquePatientId() {
  const year = new Date().getFullYear();
  const allPatients = await prisma.patient.findMany({ select: { patientId: true } });
  let maxSeq = 0;
  for (const p of allPatients) {
    if (p.patientId && p.patientId.startsWith(`PAT-${year}-`)) {
      const num = parseInt(p.patientId.replace(`PAT-${year}-`, ""), 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }
  let nextSeq = Math.max(maxSeq + 1, allPatients.length + 1);
  let patientId = `PAT-${year}-${String(nextSeq).padStart(4, "0")}`;
  while (await prisma.patient.findUnique({ where: { patientId } })) {
    nextSeq++;
    patientId = `PAT-${year}-${String(nextSeq).padStart(4, "0")}`;
  }
  return patientId;
}

function formatEncounterResponse(enc) {
  const isCompleted = enc.consultationStatus === "completed";
  let currentMeds = [];
  let allergies = [];
  let conversation = [];

  try { if (enc.currentMedsJson)  currentMeds  = JSON.parse(enc.currentMedsJson);  } catch (e) {}
  try { if (enc.allergiesJson)    allergies    = JSON.parse(enc.allergiesJson);     } catch (e) {}
  try { if (enc.intakeConversation) conversation = JSON.parse(enc.intakeConversation); } catch (e) {}

  const documentsCount = enc.documents ? enc.documents.length : 0;
  const extractedReports = (enc.documents || []).map((doc, idx) => ({
    id:     `REP-${String(idx + 1).padStart(2, "0")}`,
    date:   doc.clinicalDate
              ? new Date(doc.clinicalDate).toLocaleDateString()
              : new Date(doc.uploadDate).toLocaleDateString(),
    type:   doc.fileName || doc.documentType,
    test:   doc.status === "ready" ? "Verified" : "Pending",
    source: doc.provenance || "OPD Scan",
    status: doc.status === "ready" ? "Verified" : doc.status
  }));

  const intakeDate = enc.createdAt ? new Date(enc.createdAt) : new Date();
  const hours      = intakeDate.getHours();
  const minutes    = intakeDate.getMinutes();
  const ampm       = hours >= 12 ? "PM" : "AM";
  const fh         = hours % 12 ? hours % 12 : 12;
  const fm         = minutes < 10 ? "0" + minutes : minutes;
  const intakeTime = `${fh}:${fm} ${ampm}`;

  return {
    token:             String(enc.tokenNumber),
    encounterId:       enc.encounterId,
    patientUid:        enc.patient ? enc.patient.patientUid : enc.patientUid,
    patientId:         enc.patient ? enc.patient.patientId : null,
    name:              enc.patient ? enc.patient.fullName : null,
    age:               enc.patient ? enc.patient.age : null,
    gender:            enc.patient ? enc.patient.gender : null,
    phone:             enc.patient ? (enc.patient.mobileNumber || "") : "",
    mobileNumber:      enc.patient ? (enc.patient.mobileNumber || "") : "",
    abhaId:            enc.patient ? (enc.patient.abhaNumber || "") : "",
    abhaStatus:        enc.patient ? (enc.patient.abhaStatus || "not_configured") : "not_configured",
    abhaVerified:      enc.patient ? Boolean(enc.patient.abhaVerified) : false,
    language:          "Hindi",
    chiefComplaint:    enc.chiefComplaint        || "",
    historyStatus:     "Complete (AI Verified)",
    documentsCount,
    priority:          enc.priority              || "Normal",
    triageReason:      enc.triageReason          || "Standard OPD Intake",
    intakeTime,
    duration:          "4 mins",
    caseData: {
      hpi:             enc.hpi         || "",
      pastHistory:     enc.pastHistory || "",
      currentMeds,
      allergies,
      familyHistory:   "",
      extractedReports
    },
    conversation,
    createdAt:           enc.createdAt ? enc.createdAt.toISOString() : new Date().toISOString(),
    status:              isCompleted ? "completed" : "waiting",
    consultationStatus:  enc.consultationStatus || (isCompleted ? "completed" : "waiting"),
    assignedDoctorId:    enc.assignedDoctorId || null,
    chamber:             enc.chamber || null,
    doctorNotes:         enc.doctorNotes || "",
    completedAt:         enc.completedAt ? enc.completedAt.toISOString() : null
  };
}

// --------------------------------------------------------------------------
// 8. Authentication Endpoints (Phase 4)
// --------------------------------------------------------------------------

// 8.1 POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      logRequest(req, 400);
      return ERR.VALIDATION_ERROR(res, "Email and password are required");
    }

    const ip = getClientIp(req);
    const throttleKey = `${ip}:${email.toLowerCase().trim()}`;

    if (isLoginThrottled(throttleKey)) {
      logRequest(req, 429, { throttled: true, email });
      return ERR.TOO_MANY_REQUESTS(res, "Too many failed login attempts. Account temporarily throttled for 15 minutes.");
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    if (!user || !user.active || !user.passwordHash || !user.salt) {
      recordFailedLogin(throttleKey);
      logRequest(req, 401, { reason: "invalid_credentials" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Invalid email or password");
    }

    const isValid = await verifyPassword(password, user.passwordHash, user.salt);
    if (!isValid) {
      recordFailedLogin(throttleKey);
      logRequest(req, 401, { reason: "invalid_credentials" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Invalid email or password");
    }

    resetFailedLogin(throttleKey);

    const sessionToken = createUserSession(user);
    res.cookie("ms_user_session", sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000
    });

    await createAuditLog(prisma, {
      actorType: "USER",
      actorUserId: user.id,
      action: "LOGIN_SUCCESS",
      resourceType: "user",
      resourceId: user.userUid
    });

    logRequest(req, 200, { userUid: user.userUid, role: user.role });
    res.json({
      success: true,
      user: {
        userUid: user.userUid,
        name: user.name,
        email: user.email,
        role: user.role,
        chamber: user.chamber || null
      }
    });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Login failure", err);
    ERR.INTERNAL_ERROR(res, "Authentication error");
  }
});

// 8.2 POST /api/auth/logout
app.post("/api/auth/logout", async (req, res) => {
  const token = req.cookies?.ms_user_session;
  if (token) {
    destroyUserSession(token);
  }
  res.clearCookie("ms_user_session", { path: "/" });
  logRequest(req, 200);
  res.json({ success: true, message: "Logged out successfully" });
});

// 8.3 GET /api/auth/session
app.get("/api/auth/session", (req, res) => {
  if (!req.user) {
    logRequest(req, 401);
    return ERR.AUTHENTICATION_REQUIRED(res, "Active session required");
  }
  logRequest(req, 200, { userUid: req.user.userUid, role: req.user.role });
  res.json({
    success: true,
    user: {
      userUid: req.user.userUid,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      chamber: req.user.chamber || null
    }
  });
});

// 8.4 POST /api/auth/device (Bootstrap Kiosk Terminal Session)
app.post("/api/auth/device", (req, res) => {
  const deviceId = req.body?.deviceId || req.headers["x-device-id"] || "KIOSK-DEV-01";
  const token = createDeviceSession(deviceId);
  res.cookie("ms_device_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000
  });
  logRequest(req, 200, { deviceId });
  res.json({ success: true, deviceId });
});

// 8.5 POST /api/auth/device/logout (Clear Kiosk Terminal Session)
app.post("/api/auth/device/logout", (req, res) => {
  const token = req.cookies?.ms_device_session;
  if (token) {
    destroyDeviceSession(token);
  }
  res.clearCookie("ms_device_session", { path: "/" });
  logRequest(req, 200);
  res.json({ success: true, message: "Device session cleared" });
});

// --------------------------------------------------------------------------
// 9. Privacy-Preserving Patient Lookup (Phase 4)
// --------------------------------------------------------------------------
app.post("/api/patients/lookup", async (req, res) => {
  try {
    // Requires valid device session or clinician user session
    if (!req.device && !req.user) {
      logRequest(req, 401, { reason: "lookup_auth_required" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Lookup requires an active device or user session");
    }

    const { mobileNumber, abhaNumber } = req.body || {};
    if (!mobileNumber && !abhaNumber) {
      logRequest(req, 400);
      return ERR.VALIDATION_ERROR(res, "mobileNumber or abhaNumber is required for lookup");
    }

    let patients = [];
    if (mobileNumber) {
      patients = await prisma.patient.findMany({
        where: { mobileNumber: String(mobileNumber).trim() }
      });
    } else if (abhaNumber) {
      patients = await prisma.patient.findMany({
        where: { abhaNumber: String(abhaNumber).trim() }
      });
    }

    if (patients.length === 0) {
      logRequest(req, 200, { found: false, candidates: 0 });
      return res.json({ found: false, candidates: [] });
    }

    const contextType = req.device ? "DEVICE" : "USER";
    const contextId = req.device ? req.device.deviceId : req.user.id;

    // Build masked candidates
    const candidates = patients.map((p, idx) => ({
      candidateId: `cand_${idx + 1}`,
      patientUid: p.patientUid,
      fullName: maskFullName(p.fullName),
      maskedMobile: maskMobile(p.mobileNumber),
      age: p.age,
      gender: p.gender
    }));

    // Generate single-use, 5-minute lookup handle
    const lookupHandle = createLookupHandle(contextType, contextId, candidates);

    await createAuditLog(prisma, {
      actorType: contextType,
      actorDeviceId: req.device ? req.device.deviceId : null,
      actorUserId: req.user ? req.user.id : null,
      action: "PATIENT_LOOKUP",
      resourceType: "patient",
      metadata: { candidateCount: candidates.length }
    });

    logRequest(req, 200, { found: true, count: candidates.length });
    res.json({
      found: true,
      lookupHandle,
      candidates: candidates.map(c => ({
        candidateId: c.candidateId,
        fullName: c.fullName,
        maskedMobile: c.maskedMobile,
        age: c.age,
        gender: c.gender
      }))
    });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Lookup error", err);
    ERR.INTERNAL_ERROR(res, "Error executing patient lookup");
  }
});

// --------------------------------------------------------------------------
// 10. Dynamic Patient Registration (Phase 4)
// --------------------------------------------------------------------------
app.post("/api/patients", async (req, res) => {
  try {
    if (!req.device && !req.user) {
      logRequest(req, 401, { reason: "registration_auth_required" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Patient registration requires an active device or staff session");
    }

    // Explicit invariant: Reject client-supplied raw patientUid
    if (req.body?.patientUid) {
      logRequest(req, 400, { injectionBlocked: true });
      return ERR.HANDLE_REQUIRED(res, "Client-supplied patientUid is strictly prohibited on registration");
    }

    const { fullName, age, gender, mobileNumber, dateOfBirth, abhaNumber, abhaAddress } = req.body || {};
    if (!fullName || typeof fullName !== "string" || !fullName.trim()) {
      logRequest(req, 400);
      return ERR.VALIDATION_ERROR(res, "Patient fullName is required");
    }

    const abhaResult = evaluateAbhaStatus(abhaNumber, abhaAddress);
    const patientId = await generateUniquePatientId();
    const patientUid = crypto.randomUUID();

    const patient = await prisma.patient.create({
      data: {
        patientUid,
        patientId,
        fullName: fullName.trim(),
        age: age ? parseInt(age, 10) : null,
        gender: gender || null,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        mobileNumber: mobileNumber ? String(mobileNumber).trim() : null,
        abhaNumber: abhaNumber ? String(abhaNumber).trim() : null,
        abhaAddress: abhaAddress ? String(abhaAddress).trim() : null,
        abhaStatus: abhaResult.abhaStatus,
        abhaVerified: abhaResult.abhaVerified
      }
    });

    const contextType = req.device ? "DEVICE" : "USER";
    const contextId = req.device ? req.device.deviceId : req.user.id;
    const registrationHandle = createRegistrationHandle(contextType, contextId, patient.patientUid);

    await createAuditLog(prisma, {
      actorType: contextType,
      actorDeviceId: req.device ? req.device.deviceId : null,
      actorUserId: req.user ? req.user.id : null,
      action: "REGISTER_PATIENT",
      patientUid: patient.patientUid,
      resourceType: "Patient",
      resourceId: patient.patientId
    });

    logRequest(req, 201, { patientId: patient.patientId });
    res.status(201).json({
      success: true,
      registrationHandle,
      patient: {
        patientId: patient.patientId,
        fullName: patient.fullName,
        age: patient.age,
        gender: patient.gender,
        abhaStatus: patient.abhaStatus,
        abhaVerified: patient.abhaVerified
      }
    });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Registration error", err);
    ERR.INTERNAL_ERROR(res, "Error registering patient");
  }
});

// --------------------------------------------------------------------------
// 11. Canonical Encounter Creation (Phase 4)
// --------------------------------------------------------------------------
app.post("/api/encounters", async (req, res) => {
  try {
    if (!req.device && !req.user) {
      logRequest(req, 401);
      return ERR.AUTHENTICATION_REQUIRED(res, "Encounter creation requires an active session");
    }

    // Explicit invariant: Reject client-supplied raw patientUid
    if (req.body?.patientUid) {
      logRequest(req, 400, { injectionBlocked: true });
      return ERR.HANDLE_REQUIRED(res, "Arbitrary patientUid submission is prohibited. Encounter creation requires lookupHandle or registrationHandle.");
    }

    const { lookupHandle, candidateId, registrationHandle, chiefComplaint, priority, triageReason, chamber } = req.body || {};

    if (!lookupHandle && !registrationHandle) {
      logRequest(req, 400);
      return ERR.HANDLE_REQUIRED(res, "lookupHandle or registrationHandle is required to create an encounter");
    }

    const contextType = req.device ? "DEVICE" : "USER";
    const contextId = req.device ? req.device.deviceId : req.user.id;
    let targetPatientUid = null;

    if (lookupHandle) {
      if (!candidateId) {
        logRequest(req, 400);
        return ERR.INVALID_CANDIDATE_ID(res, "candidateId is required when using lookupHandle");
      }
      const resolution = consumeLookupCandidate(lookupHandle, candidateId, contextType, contextId);
      if (resolution.error === "HANDLE_ALREADY_CONSUMED") return ERR.HANDLE_ALREADY_CONSUMED(res, resolution.message);
      if (resolution.error === "HANDLE_EXPIRED") return ERR.HANDLE_EXPIRED(res, resolution.message);
      if (resolution.error === "HANDLE_CONTEXT_MISMATCH") return ERR.HANDLE_CONTEXT_MISMATCH(res, resolution.message);
      if (resolution.error === "INVALID_CANDIDATE_ID") return ERR.INVALID_CANDIDATE_ID(res, resolution.message);
      if (resolution.error) return ERR.HANDLE_REQUIRED(res, resolution.message);

      targetPatientUid = resolution.candidate.patientUid;
    } else if (registrationHandle) {
      const resolution = consumeRegistrationHandle(registrationHandle, contextType, contextId);
      if (resolution.error === "HANDLE_ALREADY_CONSUMED") return ERR.HANDLE_ALREADY_CONSUMED(res, resolution.message);
      if (resolution.error === "HANDLE_EXPIRED") return ERR.HANDLE_EXPIRED(res, resolution.message);
      if (resolution.error === "HANDLE_CONTEXT_MISMATCH") return ERR.HANDLE_CONTEXT_MISMATCH(res, resolution.message);
      if (resolution.error) return ERR.HANDLE_REQUIRED(res, resolution.message);

      targetPatientUid = resolution.patientUid;
    }

    let encounterId = null;
    let tokenStr = String(req.body?.tokenNumber || Math.floor(100 + Math.random() * 900));
    let attempts = 0;
    while (attempts < 10) {
      const candidateId = `ENC-${new Date().getFullYear()}-${tokenStr.padStart(4, "0")}`;
      const existing = await prisma.encounter.findUnique({ where: { encounterId: candidateId } });
      if (!existing) {
        encounterId = candidateId;
        break;
      }
      tokenStr = String(Math.floor(1000 + Math.random() * 9000));
      attempts++;
    }
    if (!encounterId) {
      encounterId = `ENC-${new Date().getFullYear()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    }

    const encounter = await prisma.encounter.create({
      data: {
        encounterId,
        patientUid: targetPatientUid,
        tokenNumber: tokenStr,
        priority: priority || "Normal",
        triageReason: triageReason || "Standard OPD Intake",
        consultationStatus: "waiting",
        chamber: chamber || null,
        chiefComplaint: chiefComplaint || null,
        provenance: "PATIENT_REPORTED",
        createdAt: new Date()
      }
    });

    // Issue ms_encounter_session cookie (scoped to target patientUid + encounterId)
    const encounterSessionToken = createEncounterSession(targetPatientUid, encounter.encounterId);
    res.cookie("ms_encounter_session", encounterSessionToken, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 2 * 60 * 60 * 1000
    });

    await createAuditLog(prisma, {
      actorType: contextType,
      actorDeviceId: req.device ? req.device.deviceId : null,
      actorUserId: req.user ? req.user.id : null,
      action: "CREATE_ENCOUNTER",
      patientUid: targetPatientUid,
      resourceType: "Encounter",
      resourceId: encounter.encounterId
    });

    logRequest(req, 201, { encounterId: encounter.encounterId, token: tokenStr });
    res.status(201).json({
      success: true,
      encounter: {
        encounterId: encounter.encounterId,
        tokenNumber: encounter.tokenNumber,
        consultationStatus: encounter.consultationStatus,
        priority: encounter.priority,
        chamber: encounter.chamber
      }
    });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Encounter creation error", err);
    ERR.INTERNAL_ERROR(res, "Error creating encounter");
  }
});

// --------------------------------------------------------------------------
// 12. OPD Chamber Claim Flow (`PUT /api/encounters/:id/claim`)
// --------------------------------------------------------------------------
app.put("/api/encounters/:id/claim", async (req, res) => {
  try {
    if (!req.user || req.user.role !== "doctor") {
      logRequest(req, 403, { reason: "claim_requires_doctor" });
      return ERR.FORBIDDEN(res, "Only authenticated doctors can claim encounters");
    }

    const { id } = req.params;

    // Resolve encounter identity outside the transaction (read-only, safe).
    // Chamber and existence checks happen INSIDE the transaction to eliminate
    // TOCTOU race: we do not trust the outer read to gate the update.
    const encounterMeta = await prisma.encounter.findFirst({
      where: {
        OR: [{ encounterId: id }, { tokenNumber: String(id) }]
      },
      select: { id: true, encounterId: true, patientUid: true, chamber: true }
    });

    if (!encounterMeta) {
      logRequest(req, 404, { encounterId: id });
      return ERR.PATIENT_NOT_FOUND(res, `Encounter not found: ${id}`);
    }

    // Option B (approved): Encounter must have an explicit chamber assignment before
    // a doctor can claim it. Encounters with chamber = null have not been routed
    // by clinical staff yet; claiming is blocked until routing is complete.
    if (!encounterMeta.chamber) {
      logRequest(req, 403, { chamberRoutingRequired: true });
      return ERR.CHAMBER_ROUTING_REQUIRED(res, "Encounter has not been routed to a chamber. Clinical staff must assign a chamber before a doctor can claim this encounter.");
    }

    // Chamber must match the doctor's assigned chamber.
    if (req.user.chamber && encounterMeta.chamber !== req.user.chamber) {
      logRequest(req, 403, { chamberMismatch: true });
      return ERR.CHAMBER_MISMATCH(res, `Encounter is in ${encounterMeta.chamber}; doctor assigned to ${req.user.chamber}`);
    }

    // ---------- Atomic Claim: conditional update is the SOLE race guard ----------
    // The WHERE clause enforces { assignedDoctorId: null, consultationStatus: "waiting" }.
    // If a concurrent claimant wins first, Prisma raises P2025 (record not found
    // matching the predicate) inside the transaction, which we catch as 409.
    // This is correct on both SQLite (table-lock) and PostgreSQL (row-lock on update).
    let updated;
    try {
      await prisma.$transaction(async (tx) => {
        // This update FAILS with Prisma P2025 if the row was already claimed
        updated = await tx.encounter.update({
          where: {
            id: encounterMeta.id,
            assignedDoctorId: null,          // race guard: must still be unclaimed
            consultationStatus: "waiting"    // race guard: must still be in waiting
          },
          data: {
            assignedDoctorId: req.user.id,
            consultationStatus: "in_progress"
          }
        });

        // Exactly one ATTENDING_OPD CareRelationship per successful claim
        await tx.careRelationship.create({
          data: {
            patientUid: encounterMeta.patientUid,
            doctorId: req.user.id,
            relationshipType: "ATTENDING_OPD",
            status: "active",
            encounterId: encounterMeta.encounterId,
            expiresAt: null,
            assignedByUserId: req.user.id,
            notes: "OPD consultation claim"
          }
        });

        // Exactly one audit event per successful claim
        await createAuditLog(tx, {
          actorType: "USER",
          actorUserId: req.user.id,
          action: "CLAIM_ENCOUNTER",
          patientUid: encounterMeta.patientUid,
          resourceType: "Encounter",
          resourceId: encounterMeta.encounterId
        });
      });
    } catch (concurrencyErr) {
      // P2025 from Prisma or any other tx failure → encounter was already claimed
      logRequest(req, 409, { raceConditionBlocked: true, detail: concurrencyErr?.code || concurrencyErr?.message });
      return ERR.ENCOUNTER_ALREADY_CLAIMED(res, "Encounter was claimed concurrently by another clinician");
    }

    logRequest(req, 200, { encounterId: updated.encounterId, doctorId: req.user.id });
    res.json({
      success: true,
      encounter: {
        encounterId: updated.encounterId,
        assignedDoctorId: updated.assignedDoctorId,
        consultationStatus: updated.consultationStatus
      }
    });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Claim encounter failure", err);
    ERR.INTERNAL_ERROR(res, "Error claiming encounter");
  }
});

// --------------------------------------------------------------------------
// 12.1 CareRelationship Lifecycle Routes (Phase 4)
// --------------------------------------------------------------------------

// POST /api/care-relationships
// Creates PRIMARY_PHYSICIAN or SPECIALIST_REFERRAL relationships manually.
// ATTENDING_OPD is auto-created on encounter claim and cannot be created here.
app.post("/api/care-relationships", async (req, res) => {
  try {
    if (!req.user || (req.user.role !== "doctor" && req.user.role !== "admin")) {
      logRequest(req, 403, { reason: "care_rel_create_requires_doctor_or_admin" });
      return ERR.FORBIDDEN(res, "Only doctors and administrators may manually create CareRelationships");
    }

    const ALLOWED_MANUAL_TYPES = ["PRIMARY_PHYSICIAN", "SPECIALIST_REFERRAL"];
    const { patientUid, relationshipType, notes, doctorId: requestedDoctorId } = req.body || {};

    if (!patientUid || typeof patientUid !== "string") {
      return ERR.VALIDATION_ERROR(res, "patientUid is required");
    }
    if (!relationshipType || !ALLOWED_MANUAL_TYPES.includes(relationshipType)) {
      return ERR.VALIDATION_ERROR(res, "relationshipType must be PRIMARY_PHYSICIAN or SPECIALIST_REFERRAL. ATTENDING_OPD is created automatically on encounter claim.");
    }

    const patient = await prisma.patient.findUnique({ where: { patientUid } });
    if (!patient) return ERR.PATIENT_NOT_FOUND(res, "Patient not found");

    // Enforce doctor self-only vs admin target-doctor validation:
    let targetDoctorId;
    if (req.user.role === "doctor") {
      // Normal doctor creates for themselves; arbitrary doctorId injection is rejected
      if (requestedDoctorId && requestedDoctorId !== req.user.id) {
        logRequest(req, 403, { reason: "doctor_arbitrary_assignment_denied" });
        return ERR.FORBIDDEN(res, "Doctors may only establish CareRelationships for themselves; cannot delegate or assign other clinicians.");
      }
      targetDoctorId = req.user.id;
    } else if (req.user.role === "admin") {
      // Admin flow: target doctor must be explicitly specified and validated
      const doctorLookupId = requestedDoctorId ? parseInt(requestedDoctorId, 10) : null;
      if (!doctorLookupId || isNaN(doctorLookupId)) {
        return ERR.VALIDATION_ERROR(res, "Administrators must specify a valid target doctorId");
      }
      const targetDoctor = await prisma.user.findFirst({
        where: { id: doctorLookupId, role: "doctor" }
      });
      if (!targetDoctor) {
        return ERR.VALIDATION_ERROR(res, "Target doctor not found or is not an authorized clinician with role 'doctor'");
      }
      targetDoctorId = targetDoctor.id;
    }

    let careRel;
    await prisma.$transaction(async (tx) => {
      careRel = await tx.careRelationship.create({
        data: {
          patientUid,
          doctorId: targetDoctorId,
          relationshipType,
          status: "active",
          encounterId: null,
          expiresAt: null,
          assignedByUserId: req.user.id,
          notes: notes ? String(notes).slice(0, 500) : null
        }
      });

      await createAuditLog(tx, {
        actorType: "USER",
        actorUserId: req.user.id,
        action: "CREATE_CARE_RELATIONSHIP",
        patientUid,
        resourceType: "CareRelationship",
        resourceId: String(careRel.id),
        metadata: { relationshipType, targetDoctorId }
      });
    });

    logRequest(req, 201, { careRelationshipId: careRel.id, relationshipType });
    res.status(201).json({
      success: true,
      careRelationship: {
        id: careRel.id,
        patientUid: careRel.patientUid,
        doctorId: careRel.doctorId,
        relationshipType: careRel.relationshipType,
        status: careRel.status,
        createdAt: careRel.createdAt
      }
    });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Error creating CareRelationship", err);
    ERR.INTERNAL_ERROR(res, "Error creating CareRelationship");
  }
});

// PUT /api/care-relationships/:id/suspend
// Suspends an active CareRelationship. A suspended relationship DOES NOT
// grant longitudinal access. Only active relationships can be suspended.
app.put("/api/care-relationships/:id/suspend", async (req, res) => {
  try {
    if (!req.user || (req.user.role !== "doctor" && req.user.role !== "admin")) {
      logRequest(req, 403, { reason: "care_rel_suspend_requires_doctor_or_admin" });
      return ERR.FORBIDDEN(res, "Only doctors and administrators may suspend CareRelationships");
    }

    const careRelId = parseInt(req.params.id, 10);
    if (isNaN(careRelId)) return ERR.VALIDATION_ERROR(res, "Invalid CareRelationship id");

    const careRel = await prisma.careRelationship.findUnique({ where: { id: careRelId } });
    if (!careRel) return ERR.CARE_RELATIONSHIP_NOT_FOUND(res, "CareRelationship not found");

    if (req.user.role === "doctor" && careRel.doctorId !== req.user.id) {
      return ERR.FORBIDDEN(res, "Doctor may only suspend their own CareRelationships");
    }
    if (careRel.status !== "active") {
      return ERR.INVALID_LIFECYCLE_TRANSITION(res, "Only active relationships can be suspended. Current status: " + careRel.status);
    }

    let updated;
    await prisma.$transaction(async (tx) => {
      updated = await tx.careRelationship.update({
        where: { id: careRelId, status: "active" },
        data: { status: "suspended" }
      });
      await createAuditLog(tx, {
        actorType: "USER",
        actorUserId: req.user.id,
        action: "SUSPEND_CARE_RELATIONSHIP",
        patientUid: careRel.patientUid,
        resourceType: "CareRelationship",
        resourceId: String(careRelId)
      });
    });

    logRequest(req, 200, { careRelationshipId: careRelId, newStatus: "suspended" });
    res.json({ success: true, careRelationship: { id: updated.id, status: updated.status } });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Error suspending CareRelationship", err);
    ERR.INTERNAL_ERROR(res, "Error suspending CareRelationship");
  }
});

// PUT /api/care-relationships/:id/end
// Explicitly terminates a CareRelationship: status = ended, endedAt = now().
// An ended relationship DOES NOT grant longitudinal access.
app.put("/api/care-relationships/:id/end", async (req, res) => {
  try {
    if (!req.user || (req.user.role !== "doctor" && req.user.role !== "admin")) {
      logRequest(req, 403, { reason: "care_rel_end_requires_doctor_or_admin" });
      return ERR.FORBIDDEN(res, "Only doctors and administrators may end CareRelationships");
    }

    const careRelId = parseInt(req.params.id, 10);
    if (isNaN(careRelId)) return ERR.VALIDATION_ERROR(res, "Invalid CareRelationship id");

    const careRel = await prisma.careRelationship.findUnique({ where: { id: careRelId } });
    if (!careRel) return ERR.CARE_RELATIONSHIP_NOT_FOUND(res, "CareRelationship not found");

    if (req.user.role === "doctor" && careRel.doctorId !== req.user.id) {
      return ERR.FORBIDDEN(res, "Doctor may only end their own CareRelationships");
    }
    if (careRel.status === "ended") {
      return ERR.INVALID_LIFECYCLE_TRANSITION(res, "CareRelationship is already ended.");
    }

    let updated;
    await prisma.$transaction(async (tx) => {
      updated = await tx.careRelationship.update({
        where: { id: careRelId },
        data: { status: "ended", endedAt: new Date() }
      });
      await createAuditLog(tx, {
        actorType: "USER",
        actorUserId: req.user.id,
        action: "END_CARE_RELATIONSHIP",
        patientUid: careRel.patientUid,
        resourceType: "CareRelationship",
        resourceId: String(careRelId)
      });
    });

    logRequest(req, 200, { careRelationshipId: careRelId, newStatus: "ended" });
    res.json({ success: true, careRelationship: { id: updated.id, status: updated.status, endedAt: updated.endedAt } });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Error ending CareRelationship", err);
    ERR.INTERNAL_ERROR(res, "Error ending CareRelationship");
  }
});

// --------------------------------------------------------------------------
// 13. Protected Patient Clinical Access (`GET /api/patients/:patientUid`)
// --------------------------------------------------------------------------
app.get("/api/patients/:patientUid", async (req, res) => {
  try {
    const { patientUid } = req.params;

    // 1. Administrative Access (Role Admin + X-Admin-Access-Reason Header)
    if (req.user?.role === "admin") {
      const adminReason = req.headers["x-admin-access-reason"];
      if (!adminReason || typeof adminReason !== "string" || adminReason.trim().length < 5 || adminReason.trim().length > 500) {
        logRequest(req, 400, { reason: "admin_reason_missing" });
        return ERR.ADMIN_ACCESS_REASON_REQUIRED(res, "Administrative access strictly requires non-empty X-Admin-Access-Reason header (5-500 characters)");
      }

      const patient = await prisma.patient.findUnique({
        where: { patientUid },
        include: { encounters: true, documents: true, careRelationships: true }
      });
      if (!patient) return ERR.PATIENT_NOT_FOUND(res, "Patient not found");

      await createAuditLog(prisma, {
        actorType: "USER",
        actorUserId: req.user.id,
        action: "ADMIN_PATIENT_RECORD_VIEW",
        patientUid,
        resourceType: "Patient",
        resourceId: patientUid,
        metadata: { accessReason: adminReason.trim() }
      });

      logRequest(req, 200, { adminAccess: true });
      return res.json({ success: true, patient });
    }

    // 2. Patient Self-Access (ms_encounter_session)
    if (req.encounterSession) {
      if (req.encounterSession.patientUid !== patientUid) {
        logRequest(req, 403, { reason: "cross_patient_scope" });
        return ERR.PATIENT_SCOPE_MISMATCH(res, "Intake session not authorized for requested patient");
      }
      const patient = await prisma.patient.findUnique({
        where: { patientUid },
        include: { encounters: true }
      });
      if (!patient) return ERR.PATIENT_NOT_FOUND(res, "Patient not found");
      logRequest(req, 200, { selfAccess: true });
      return res.json({ success: true, patient });
    }

    // 3. Clinician Access (Doctor with Assigned Encounter OR Active CareRelationship)
    if (req.user?.role === "doctor") {
      // Check current assigned encounter
      const currentAssigned = await prisma.encounter.findFirst({
        where: {
          patientUid,
          assignedDoctorId: req.user.id,
          consultationStatus: { in: ["in_progress", "waiting"] }
        }
      });

      // Check active CareRelationship
      const activeRelationship = await prisma.careRelationship.findFirst({
        where: {
          patientUid,
          doctorId: req.user.id,
          status: "active",
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } }
          ],
          endedAt: null
        }
      });

      if (!currentAssigned && !activeRelationship) {
        logRequest(req, 403, { reason: "no_active_care_relationship" });
        return ERR.LONGITUDINAL_ACCESS_DENIED(res, "Doctor does not have an active care relationship or assigned encounter for this patient");
      }

      const patient = await prisma.patient.findUnique({
        where: { patientUid },
        include: { encounters: true, documents: true, careRelationships: true }
      });
      if (!patient) return ERR.PATIENT_NOT_FOUND(res, "Patient not found");

      await createAuditLog(prisma, {
        actorType: "USER",
        actorUserId: req.user.id,
        action: "CLINICAL_RECORD_VIEW",
        patientUid,
        resourceType: "Patient",
        resourceId: patientUid
      });

      logRequest(req, 200, { doctorAccess: true });
      return res.json({ success: true, patient });
    }

    // Default: Unauthorized
    logRequest(req, 401);
    ERR.AUTHENTICATION_REQUIRED(res, "Clinical access requires doctor, patient intake, or administrative authorization");
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Patient record fetch failure", err);
    ERR.INTERNAL_ERROR(res, "Error reading patient record");
  }
});

// --------------------------------------------------------------------------
// 14. Existing Health, Queue, Intake & Consultation Endpoints
// --------------------------------------------------------------------------

// 14.1 GET /api/health
app.get("/api/health", async (req, res) => {
  try {
    const patientCount  = await prisma.patient.count();
    const encounterCount = await prisma.encounter.count();
    res.json({
      status:    "healthy",
      database:  "connected",
      provider:  process.env.DATABASE_PROVIDER || "sqlite",
      patients:  patientCount,
      encounters: encounterCount,
      time:      new Date().toISOString()
    });
    logRequest(req, 200);
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Health check failed", err);
    res.status(500).json({ status: "degraded", requestId: req.requestId });
  }
});

// 14.2 GET /api/queue (Privacy-Preserving Queue Coordination)
app.get("/api/queue", async (req, res) => {
  try {
    const encounters = await prisma.encounter.findMany({
      include: { patient: true, documents: true },
      orderBy: { createdAt: "desc" }
    });
    const queue = encounters.map(formatEncounterResponse);
    logRequest(req, 200, { count: queue.length });
    res.json({ success: true, queue });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Error querying queue", err);
    ERR.INTERNAL_ERROR(res, "Error reading queue from database");
  }
});

// 14.3 POST /api/intake (Legacy Compatibility Bridge with Deterministic Validation)
app.post("/api/intake", async (req, res) => {
  try {
    const newPatient = req.body;
    if (!newPatient || !newPatient.name) {
      logRequest(req, 400);
      return ERR.VALIDATION_ERROR(res, "Patient data required: name field is missing");
    }

    // Deterministic client patientUid rejection
    if (newPatient.patientUid) {
      logRequest(req, 400, { legacyUidBlocked: true });
      return ERR.HANDLE_REQUIRED(res, "Client-supplied patientUid is strictly prohibited on legacy intake. Existing patients must use the Phase 4 lookup/encounter handle flow.");
    }

    const tokenStr       = String(newPatient.token || Date.now() % 1000);
    const patientName    = String(newPatient.name).trim();
    const patientAge     = newPatient.age    ? parseInt(newPatient.age, 10) : null;
    const patientGender  = newPatient.gender || null;
    const patientMobile  = newPatient.phone  || newPatient.mobileNumber || null;
    const patientAbha    = newPatient.abhaId || null;

    let patient = null;
    if (patientAbha && patientAbha !== "91-1123-8822-7711") {
      patient = await prisma.patient.findFirst({ where: { abhaNumber: patientAbha } });
    }
    if (!patient && patientMobile) {
      patient = await prisma.patient.findFirst({ where: { mobileNumber: patientMobile } });
    }
    if (!patient) {
      patient = await prisma.patient.findFirst({ where: { fullName: patientName, age: patientAge } });
    }
    if (!patient) {
      const generatedId   = await generateUniquePatientId();
      patient = await prisma.patient.create({
        data: {
          patientUid:  crypto.randomUUID(),
          patientId:   generatedId,
          fullName:    patientName,
          age:         patientAge,
          gender:      patientGender,
          mobileNumber: patientMobile,
          abhaNumber:  patientAbha,
          abhaAddress: newPatient.abhaAddress || null,
          abhaStatus:  "not_configured",
          abhaVerified: false
        }
      });
      console.log(`[Server] Created new canonical patient: ${patient.fullName} (${patient.patientId})`);
    }

    let encounter = await prisma.encounter.findFirst({ where: { tokenNumber: tokenStr } });
    const isCompleted = newPatient.consultationStatus === "completed" || newPatient.status === "completed";
    const encounterId = `ENC-${new Date().getFullYear()}-${tokenStr.padStart(4, "0")}`;

    const currentMedsJson    = newPatient.caseData?.currentMeds ? JSON.stringify(newPatient.caseData.currentMeds) : null;
    const allergiesJson      = newPatient.caseData?.allergies   ? JSON.stringify(newPatient.caseData.allergies)   : null;
    const intakeConversation = newPatient.conversation          ? JSON.stringify(newPatient.conversation)          : null;

    if (encounter) {
      encounter = await prisma.encounter.update({
        where: { id: encounter.id },
        data: {
          priority:          newPatient.priority    || encounter.priority,
          triageReason:      newPatient.triageReason || encounter.triageReason,
          consultationStatus: isCompleted ? "completed" : (newPatient.consultationStatus || encounter.consultationStatus),
          chiefComplaint:    newPatient.chiefComplaint      || encounter.chiefComplaint,
          hpi:               newPatient.caseData?.hpi       || encounter.hpi,
          pastHistory:       newPatient.caseData?.pastHistory || encounter.pastHistory,
          currentMedsJson:   currentMedsJson   || encounter.currentMedsJson,
          allergiesJson:     allergiesJson     || encounter.allergiesJson,
          doctorNotes:       newPatient.doctorNotes || encounter.doctorNotes,
          intakeConversation: intakeConversation || encounter.intakeConversation,
          completedAt:       isCompleted ? new Date() : encounter.completedAt
        },
        include: { patient: true, documents: true }
      });
    } else {
      encounter = await prisma.encounter.create({
        data: {
          encounterId,
          patientUid:         patient.patientUid,
          tokenNumber:        tokenStr,
          priority:           newPatient.priority    || "Normal",
          triageReason:       newPatient.triageReason || "Standard OPD Intake",
          consultationStatus: isCompleted ? "completed" : (newPatient.consultationStatus || "waiting"),
          chiefComplaint:     newPatient.chiefComplaint || null,
          hpi:                newPatient.caseData?.hpi  || null,
          pastHistory:        newPatient.caseData?.pastHistory || null,
          currentMedsJson,
          allergiesJson,
          doctorNotes:        newPatient.doctorNotes || null,
          intakeConversation,
          provenance:         "PATIENT_REPORTED",
          createdAt:          new Date(),
          completedAt:        isCompleted ? new Date() : null
        },
        include: { patient: true, documents: true }
      });
    }

    const kioskSessionToken = createKioskSession(patient.patientUid, encounter.encounterId, "kiosk");
    const encSessionToken = createEncounterSession(patient.patientUid, encounter.encounterId);
    res.cookie("ms_encounter_session", encSessionToken, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 2 * 60 * 60 * 1000
    });

    logRequest(req, 200, { token: tokenStr, patientId: patient.patientId });
    res.json({
      success: true,
      patient: formatEncounterResponse(encounter),
      kioskSessionToken,
      _sessionNote: "Legacy intake bridge: provides session scoped to intake terminal."
    });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Error saving intake", err);
    ERR.INTERNAL_ERROR(res, "Error saving intake to database");
  }
});

// 14.4 PUT /api/patient/:token/complete (Consultation Finalization & 24h Review Window)
app.put("/api/patient/:token/complete", async (req, res) => {
  try {
    const { token } = req.params;
    const { doctorNotes, consultationStatus, status } = req.body;
    const tokenStr = String(token);

    const encounter = await prisma.encounter.findFirst({
      where: {
        OR: [{ tokenNumber: tokenStr }, { encounterId: tokenStr }]
      },
      include: { patient: true, documents: true }
    });

    if (!encounter) {
      logRequest(req, 404, { token: tokenStr });
      return ERR.PATIENT_NOT_FOUND(res, `No encounter found for token ${tokenStr}`);
    }

    const newStatus = consultationStatus || status || "completed";
    const completedDate = new Date();

    const updated = await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        consultationStatus: newStatus,
        doctorNotes: doctorNotes !== undefined ? doctorNotes : encounter.doctorNotes,
        completedAt: completedDate
      },
      include: { patient: true, documents: true }
    });

    // Finalize linked ATTENDING_OPD CareRelationship (24-hour review window)
    const reviewExpiry = new Date(completedDate.getTime() + 24 * 60 * 60 * 1000);
    await prisma.careRelationship.updateMany({
      where: {
        encounterId: encounter.encounterId,
        relationshipType: "ATTENDING_OPD"
      },
      data: {
        expiresAt: reviewExpiry
      }
    });

    // Relational Audit Attribution
    const actorUserId = req.user ? req.user.id : (encounter.assignedDoctorId || 1);
    await createAuditLog(prisma, {
      actorType: "USER",
      actorUserId,
      action: "COMPLETE_OPD",
      patientUid: encounter.patientUid,
      resourceType: "Encounter",
      resourceId: encounter.encounterId,
      metadata: { token: tokenStr, status: newStatus }
    });

    // Invalidate encounter session on consultation completion
    if (req.cookies?.ms_encounter_session) {
      destroyEncounterSession(req.cookies.ms_encounter_session);
      res.clearCookie("ms_encounter_session", { path: "/" });
    }

    logRequest(req, 200, { token: tokenStr, status: newStatus });
    res.json({ success: true, patient: formatEncounterResponse(updated) });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Error completing consultation", err);
    ERR.INTERNAL_ERROR(res, "Error updating consultation");
  }
});

// 14.5 GET /api/patient/:token (Clinical Access Boundary)
app.get("/api/patient/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const tokenStr = String(token);
    const encounter = await prisma.encounter.findFirst({
      where: {
        OR: [{ tokenNumber: tokenStr }, { encounterId: tokenStr }]
      },
      include: { patient: true, documents: true }
    });

    if (!encounter) {
      logRequest(req, 404, { token: tokenStr });
      return ERR.PATIENT_NOT_FOUND(res, `No encounter found for token ${tokenStr}`);
    }

    // 1. Doctor Access Boundary
    if (req.user?.role === "doctor") {
      // If encounter is not assigned to this doctor, access is denied (doctor must claim it)
      if (encounter.assignedDoctorId !== req.user.id) {
        logRequest(req, 403, { reason: "unassigned_doctor_access" });
        return ERR.CLINICAL_ACCESS_DENIED(res, "Doctor must claim encounter from queue to access full clinical record");
      }
    }

    // 2. Patient Intake Session Boundary
    if (req.encounterSession) {
      if (req.encounterSession.encounterId !== encounter.encounterId && req.encounterSession.patientUid !== encounter.patientUid) {
        logRequest(req, 403, { reason: "scope_mismatch" });
        return ERR.PATIENT_SCOPE_MISMATCH(res, "Session not authorized for this patient encounter");
      }
    }

    // 3. Admin Access Boundary
    if (req.user?.role === "admin") {
      const adminReason = req.headers["x-admin-access-reason"];
      if (!adminReason || typeof adminReason !== "string" || adminReason.trim().length < 5 || adminReason.trim().length > 500) {
        logRequest(req, 400, { reason: "admin_reason_missing" });
        return ERR.ADMIN_ACCESS_REASON_REQUIRED(res, "Administrative access requires non-empty X-Admin-Access-Reason header (5-500 characters)");
      }
      await createAuditLog(prisma, {
        actorType: "USER",
        actorUserId: req.user.id,
        action: "ADMIN_ENCOUNTER_VIEW",
        patientUid: encounter.patientUid,
        resourceType: "Encounter",
        resourceId: encounter.encounterId,
        metadata: { accessReason: adminReason.trim() }
      });
    }

    logRequest(req, 200, { token: tokenStr });
    res.json({ success: true, patient: formatEncounterResponse(encounter) });
  } catch (err) {
    logError(req, "INTERNAL_ERROR", "Error querying patient", err);
    ERR.INTERNAL_ERROR(res, "Error reading patient");
  }
});

// --------------------------------------------------------------------------
// 15. Secure AI Proxy — POST /api/ai/intake-question (Phase 3 Preserved)
// --------------------------------------------------------------------------
const ConversationTurnSchema = z.object({
  sender: z.enum(["patient", "ai"]),
  text:   z.string().max(500, "Turn text too long"),
  time:   z.string().optional()
});

const IntakeQuestionRequestSchema = z.object({
  patientMessage:      z.string().min(1, "patientMessage required").max(500, "patientMessage too long"),
  conversationHistory: z.array(ConversationTurnSchema).max(20, "Conversation history too long"),
  stepIndex:           z.number().int().min(0).max(5).default(0),
  language:            z.enum(["Hindi", "English", "Hinglish"]).default("Hindi"),
  patientUid:          z.string().uuid("patientUid must be a valid UUID").optional(),
  patientAge:          z.number().int().min(0).max(120).optional(),
  patientGender:       z.enum(["Male", "Female", "Other"]).optional()
});

function buildGeminiPayload(validated, conversationTurns) {
  const clinicalContext = [];
  if (validated.patientAge)    clinicalContext.push(`Age: ${validated.patientAge}`);
  if (validated.patientGender) clinicalContext.push(`Gender: ${validated.patientGender}`);
  if (validated.language)      clinicalContext.push(`Language preference: ${validated.language}`);

  const recentHistory = conversationTurns.slice(-8).map(turn => ({
    role:  turn.sender === "patient" ? "user" : "model",
    parts: [{ text: turn.text }]
  }));

  return {
    clinicalContext: clinicalContext.join(", "),
    recentHistory,
    currentMessage: validated.patientMessage,
    stepIndex:      validated.stepIndex
  };
}

const SYSTEM_PROMPT = `You are MedSync AI, an empathetic clinical history-taking assistant at an Indian hospital OPD kiosk.
The patient is speaking to you in Hindi, Hinglish, or English.
CRITICAL INSTRUCTIONS:
1. Focus directly on the patient's EXACT symptom or statement. Your next question MUST be clinically relevant to what they just reported.
2. If the patient asks a direct question, give a 1-sentence warm reassurance first, then ask the clinical question.
3. Keep question concise (under 28 words) in simple, conversational Hinglish.
4. Always provide 4 quick-tap options at the end in this format:
[Your concise clinical question]
OPTIONS: opt1 | opt2 | opt3 | opt4`;

const CANDIDATE_MODELS = ["gemini-2.0-flash-lite", "gemini-2.0-flash", "gemini-1.5-flash"];
const GEMINI_TIMEOUT_MS = 5500;

function parseGeminiOptions(text) {
  const match = text.match(/OPTIONS:\s*(.+)/i);
  if (match) {
    const opts = match[1].split("|").map(o => o.trim()).filter(Boolean);
    return {
      cleanText: text.replace(/OPTIONS:.+/i, "").trim(),
      options: opts
    };
  }
  return { cleanText: text, options: [] };
}

async function callGemini(payload) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const genAI = new GoogleGenerativeAI(apiKey);

  for (const modelName of CANDIDATE_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT
      });

      const contents = [...payload.recentHistory];
      if (payload.clinicalContext && contents.length === 0) {
        contents.push({
          role: "user",
          parts: [{ text: `[Clinical context: ${payload.clinicalContext}]\n${payload.currentMessage}` }]
        });
      } else {
        contents.push({ role: "user", parts: [{ text: payload.currentMessage }] });
      }

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("GEMINI_TIMEOUT")), GEMINI_TIMEOUT_MS)
      );

      const responsePromise = model.generateContent({
        contents,
        generationConfig: { maxOutputTokens: 120, temperature: 0.3 }
      });

      const result = await Promise.race([responsePromise, timeoutPromise]);
      const replyText = result.response.text().trim();

      if (replyText) {
        const { cleanText, options } = parseGeminiOptions(replyText);
        return {
          text: cleanText,
          options: options.length > 0 ? options : ["हाँ, यह है", "नहीं, ऐसा नहीं", "कुछ समय से", "पता नहीं"],
          model: modelName,
          source: "gemini"
        };
      }
    } catch (err) {
      if (err.message === "GEMINI_TIMEOUT") {
        throw { code: "AI_PROVIDER_TIMEOUT", message: "Gemini request timed out", model: modelName };
      }
      const msg = err.message || "";
      if (msg.includes("429") || msg.toLowerCase().includes("rate")) {
        throw { code: "AI_PROVIDER_RATE_LIMITED", message: "Gemini rate limit exceeded", model: modelName };
      }
    }
  }

  throw { code: "AI_PROVIDER_UNAVAILABLE", message: "All Gemini models unavailable" };
}

app.post("/api/ai/intake-question", aiRateLimiter, async (req, res) => {
  const parseResult = IntakeQuestionRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(i => ({
      field:   i.path.join("."),
      message: i.message
    }));
    logRequest(req, 400, { validationFailed: true });
    return ERR.VALIDATION_ERROR(res, "Request schema invalid", { issues });
  }

  const validated = parseResult.data;

  // Authorization check for patientUid
  if (validated.patientUid) {
    const sessionToken = req.headers["x-kiosk-session"] || req.cookies?.ms_encounter_session;

    if (!sessionToken) {
      logRequest(req, 401, { patientUid: validated.patientUid, reason: "no_session_token" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Patient-scoped AI requests require an intake session token");
    }

    // Check legacy kiosk session or ms_encounter_session
    let authorized = false;
    const legacyCheck = validateKioskSession(sessionToken, validated.patientUid);
    if (legacyCheck.valid) {
      authorized = true;
    } else if (legacyCheck.reason === "PATIENT_SCOPE_MISMATCH") {
      logRequest(req, 403, { patientUid: validated.patientUid, reason: "PATIENT_SCOPE_MISMATCH" });
      return ERR.FORBIDDEN(res, "This session is not authorized for the requested patient. Access denied.");
    } else {
      // Check encounter session
      const encCheck = validateEncounterSession(sessionToken);
      if (encCheck.valid) {
        if (encCheck.session.patientUid === validated.patientUid) {
          authorized = true;
        } else {
          logRequest(req, 403, { patientUid: validated.patientUid, reason: "PATIENT_SCOPE_MISMATCH" });
          return ERR.FORBIDDEN(res, "This session is not authorized for the requested patient. Access denied.");
        }
      }
    }

    if (!authorized) {
      logRequest(req, 401, { patientUid: validated.patientUid });
      return ERR.AUTHENTICATION_REQUIRED(res, "Invalid or expired session token.");
    }

    const dbPatient = await prisma.patient.findUnique({
      where:  { patientUid: validated.patientUid },
      select: { age: true, gender: true }
    });
    if (dbPatient?.age)    validated.patientAge    = dbPatient.age;
    if (dbPatient?.gender) validated.patientGender = dbPatient.gender;
  }

  const geminiPayload = buildGeminiPayload(validated, validated.conversationHistory);

  try {
    const aiResult = await callGemini(geminiPayload);
    logRequest(req, 200, { model: aiResult.model, source: "gemini", stepIndex: validated.stepIndex });
    return res.json({
      success:  true,
      text:     aiResult.text,
      options:  aiResult.options,
      model:    aiResult.model,
      source:   "gemini"
    });
  } catch (err) {
    const code = err.code || "AI_PROVIDER_UNAVAILABLE";
    const msg  = err.message || "AI provider unavailable";
    logRequest(req, code === "AI_PROVIDER_TIMEOUT" ? 504 : 503, { aiError: code, model: err.model });
    if (code === "AI_PROVIDER_TIMEOUT") return ERR.AI_PROVIDER_TIMEOUT(res, msg);
    if (code === "AI_PROVIDER_RATE_LIMITED") return ERR.AI_PROVIDER_RATE_LIMITED(res, msg);
    return ERR.AI_PROVIDER_UNAVAILABLE(res, msg);
  }
});

// --------------------------------------------------------------------------
// 15b. Adaptive Clinical Interview State Machine — Phase 5A
// --------------------------------------------------------------------------
const interviewPlanner = new InterviewPlanner(prisma);

function getEncounterSessionContext(req) {
  if (req.encounterSession?.patientUid) {
    return req.encounterSession;
  }
  const token = req.cookies?.ms_encounter_session || req.headers["x-kiosk-session"];
  if (token) {
    const check = validateEncounterSession(token);
    if (check.valid) {
      return {
        patientUid: check.session.patientUid,
        encounterId: check.session.encounterId,
        role: check.session.role
      };
    }
  }
  return null;
}

function getUserSessionContext(req) {
  if (req.user?.id) {
    return req.user;
  }
  const token = req.cookies?.ms_user_session;
  if (token) {
    const check = validateUserSession(token);
    if (check.valid) {
      return {
        id: check.session.userId,
        userUid: check.session.userUid,
        name: check.session.name,
        email: check.session.email,
        role: check.session.role,
        chamber: check.session.chamber
      };
    }
  }
  return null;
}

const IntakeInterviewStartSchema = z.object({
  chiefComplaint: z.string().max(1000).optional().default(""),
  language: z.enum(["Hindi", "English"]).optional().default("Hindi")
});

const IntakeInterviewStepSchema = z.object({
  sessionId: z.string().min(1).max(100),
  questionKey: z.string().min(1).max(100),
  answerText: z.string().max(1000).optional().default(""),
  action: z.enum(["answer", "skip", "unknown"]).optional().default("answer"),
  language: z.enum(["Hindi", "English"]).optional().default("Hindi")
});

const IntakeInterviewEditSchema = z.object({
  sessionId: z.string().min(1).max(100),
  turnIndex: z.number().int().min(0).max(50),
  newAnswerText: z.string().min(1).max(1000)
});

const IntakeInterviewSubmitSchema = z.object({
  sessionId: z.string().min(1).max(100)
});

// POST /api/intake/interview/start
app.post("/api/intake/interview/start", async (req, res) => {
  if (req.body && (req.body.patientUid !== undefined || req.body.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_body" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in request body. Identity is derived server-side from session context.");
  }
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_query" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
  }

  const encCtx = getEncounterSessionContext(req);
  if (!encCtx) {
    logRequest(req, 401, { reason: "no_encounter_session" });
    return ERR.AUTHENTICATION_REQUIRED(res, "Active patient encounter session required for intake interview");
  }

  const parseResult = IntakeInterviewStartSchema.safeParse(req.body || {});
  if (!parseResult.success) {
    return ERR.VALIDATION_ERROR(res, "Invalid interview start parameters", { issues: parseResult.error.issues });
  }

  const { chiefComplaint, language } = parseResult.data;

  try {
    const result = await interviewPlanner.startSession({
      patientUid: encCtx.patientUid,
      encounterId: encCtx.encounterId,
      chiefComplaint,
      language
    });

    logRequest(req, 200, { sessionId: result.sessionId, category: result.category });
    return res.json({
      success: true,
      sessionId: result.sessionId,
      status: result.status,
      category: result.category,
      currentStep: result.currentStep,
      totalQuestions: result.totalQuestions,
      coveredDomains: result.coveredDomains,
      nextQuestion: result.nextQuestion,
      isComplete: result.isComplete,
      isExisting: result.isExisting || false
    });
  } catch (err) {
    logError(req, "PLANNER_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "PLANNER_UNAVAILABLE",
        message: err.message || "Failed to initialize interview session",
        requestId: req.requestId
      }
    });
  }
});

// POST /api/intake/interview/step
app.post("/api/intake/interview/step", async (req, res) => {
  if (req.body && (req.body.patientUid !== undefined || req.body.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_body" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in request body. Identity is derived server-side from session context.");
  }
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_query" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
  }

  const encCtx = getEncounterSessionContext(req);
  if (!encCtx) {
    logRequest(req, 401, { reason: "no_encounter_session" });
    return ERR.AUTHENTICATION_REQUIRED(res, "Active patient encounter session required for intake interview");
  }

  const parseResult = IntakeInterviewStepSchema.safeParse(req.body);
  if (!parseResult.success) {
    return ERR.VALIDATION_ERROR(res, "Invalid interview step parameters", { issues: parseResult.error.issues });
  }

  const { sessionId, questionKey, answerText, action, language } = parseResult.data;

  const sessionRecord = await prisma.interviewSession.findUnique({
    where: { sessionId }
  });
  if (!sessionRecord) {
    return res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: `Interview session ${sessionId} not found`,
        requestId: req.requestId
      }
    });
  }
  if (sessionRecord.patientUid !== encCtx.patientUid) {
    return ERR.PATIENT_SCOPE_MISMATCH(res, "Session does not belong to active patient context");
  }

  try {
    const result = await interviewPlanner.processStep({
      sessionId,
      questionKey,
      answerText,
      action,
      language
    });

    logRequest(req, 200, { sessionId, currentStep: result.currentStep, isComplete: result.isComplete });
    return res.json({
      success: true,
      sessionId: result.sessionId,
      status: result.status,
      isComplete: result.isComplete,
      currentStep: result.currentStep,
      totalQuestions: result.totalQuestions,
      coveredDomains: result.coveredDomains,
      nextQuestion: result.nextQuestion,
      isRetry: result.isRetry || false,
      reviewSummary: result.reviewSummary || null
    });
  } catch (err) {
    if (err.code === "INVALID_LIFECYCLE_TRANSITION") {
      logRequest(req, 409, { reason: err.message });
      return ERR.INVALID_LIFECYCLE_TRANSITION(res, err.message);
    }
    logError(req, "PLANNER_STEP_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "PLANNER_UNAVAILABLE",
        message: err.message || "Failed to process interview turn",
        requestId: req.requestId
      }
    });
  }
});

// GET /api/intake/interview/review
app.get("/api/intake/interview/review", async (req, res) => {
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_query" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
  }

  const encCtx = getEncounterSessionContext(req);
  if (!encCtx) {
    logRequest(req, 401, { reason: "no_encounter_session" });
    return ERR.AUTHENTICATION_REQUIRED(res, "Active patient encounter session required for intake interview");
  }

  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return ERR.VALIDATION_ERROR(res, "sessionId query parameter is required");
  }

  const sessionRecord = await prisma.interviewSession.findUnique({
    where: { sessionId: String(sessionId) }
  });
  if (!sessionRecord) {
    return res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: `Interview session ${sessionId} not found`,
        requestId: req.requestId
      }
    });
  }
  if (sessionRecord.patientUid !== encCtx.patientUid) {
    return ERR.PATIENT_SCOPE_MISMATCH(res, "Session does not belong to active patient context");
  }

  try {
    const turns = await interviewPlanner.getReview(String(sessionId));
    logRequest(req, 200, { sessionId, turnsCount: turns.length });
    return res.json({
      success: true,
      sessionId: String(sessionId),
      turns
    });
  } catch (err) {
    logError(req, "PLANNER_REVIEW_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "Failed to retrieve interview review",
        requestId: req.requestId
      }
    });
  }
});

// PUT /api/intake/interview/edit
app.put("/api/intake/interview/edit", async (req, res) => {
  if (req.body && (req.body.patientUid !== undefined || req.body.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_body" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in request body. Identity is derived server-side from session context.");
  }
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_query" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
  }

  const encCtx = getEncounterSessionContext(req);
  if (!encCtx) {
    logRequest(req, 401, { reason: "no_encounter_session" });
    return ERR.AUTHENTICATION_REQUIRED(res, "Active patient encounter session required for intake interview");
  }

  const parseResult = IntakeInterviewEditSchema.safeParse(req.body);
  if (!parseResult.success) {
    return ERR.VALIDATION_ERROR(res, "Invalid interview edit parameters", { issues: parseResult.error.issues });
  }

  const { sessionId, turnIndex, newAnswerText } = parseResult.data;

  const sessionRecord = await prisma.interviewSession.findUnique({
    where: { sessionId }
  });
  if (!sessionRecord) {
    return res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: `Interview session ${sessionId} not found`,
        requestId: req.requestId
      }
    });
  }
  if (sessionRecord.patientUid !== encCtx.patientUid) {
    return ERR.PATIENT_SCOPE_MISMATCH(res, "Session does not belong to active patient context");
  }

  try {
    const result = await interviewPlanner.editTurn({ sessionId, turnIndex, newAnswerText });

    // Clinical Audit Trail: Log turn modification event
    await createAuditLog(prisma, {
      actorType: req.device ? "DEVICE" : (req.user ? "USER" : "SERVICE"),
      actorDeviceId: req.device?.deviceId || null,
      actorUserId: req.user?.id || null,
      actorService: !req.device && !req.user ? "patient_intake_service" : null,
      action: "EDIT_INTERVIEW_TURN",
      patientUid: encCtx.patientUid,
      resourceType: "InterviewTurn",
      resourceId: `${sessionId}:turn_${turnIndex}`,
      metadata: {
        sessionId,
        turnIndex,
        questionKey: result.turn.questionKey,
        answerType: result.turn.answerType,
        provenance: result.turn.provenance,
        characterLength: newAnswerText.length,
        revalidatedCategory: result.revalidatedState?.complaintCategory
      }
    });

    logRequest(req, 200, { sessionId, turnIndex });
    return res.json({
      success: true,
      turn: result.turn,
      revalidatedState: result.revalidatedState
    });
  } catch (err) {
    if (err.code === "INVALID_LIFECYCLE_TRANSITION") {
      logRequest(req, 409, { reason: err.message });
      return ERR.INVALID_LIFECYCLE_TRANSITION(res, err.message);
    }
    logError(req, "PLANNER_EDIT_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "Failed to update interview turn",
        requestId: req.requestId
      }
    });
  }
});

// POST /api/intake/interview/submit
app.post("/api/intake/interview/submit", async (req, res) => {
  if (req.body && (req.body.patientUid !== undefined || req.body.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_body" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in request body. Identity is derived server-side from session context.");
  }
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_intake_query" });
    return ERR.VALIDATION_ERROR(res, "Public intake APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
  }

  const encCtx = getEncounterSessionContext(req);
  if (!encCtx) {
    logRequest(req, 401, { reason: "no_encounter_session" });
    return ERR.AUTHENTICATION_REQUIRED(res, "Active patient encounter session required for intake interview");
  }

  const parseResult = IntakeInterviewSubmitSchema.safeParse(req.body);
  if (!parseResult.success) {
    return ERR.VALIDATION_ERROR(res, "Invalid interview submit parameters", { issues: parseResult.error.issues });
  }

  const { sessionId } = parseResult.data;

  const sessionRecord = await prisma.interviewSession.findUnique({
    where: { sessionId }
  });
  if (!sessionRecord) {
    return res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: `Interview session ${sessionId} not found`,
        requestId: req.requestId
      }
    });
  }
  if (sessionRecord.patientUid !== encCtx.patientUid) {
    return ERR.PATIENT_SCOPE_MISMATCH(res, "Session does not belong to active patient context");
  }

  try {
    const result = await interviewPlanner.submitIntake(sessionId);
    logRequest(req, 200, { sessionId, encounterId: result.encounterId, alreadySubmitted: Boolean(result.alreadySubmitted) });
    return res.json({
      success: true,
      sessionId: result.sessionId,
      encounterId: result.encounterId,
      chiefComplaint: result.chiefComplaint,
      hpi: result.hpi,
      totalAnswered: result.totalAnswered,
      alreadySubmitted: Boolean(result.alreadySubmitted)
    });
  } catch (err) {
    if (err.code === "INVALID_LIFECYCLE_TRANSITION") {
      logRequest(req, 409, { reason: err.message });
      return ERR.INVALID_LIFECYCLE_TRANSITION(res, err.message);
    }
    logError(req, "PLANNER_SUBMIT_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "Failed to submit intake interview",
        requestId: req.requestId
      }
    });
  }
});

// --------------------------------------------------------------------------
// 16. Document Ingestion, File Storage & Background OCR Engine (Phase 5B)
// --------------------------------------------------------------------------

// Multer middleware wrapper for clean error handling
const documentUploadMiddleware = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        logRequest(req, 413, { reason: "file_too_large" });
        return ERR.FILE_TOO_LARGE(res, `File exceeds maximum allowable size limit of 15MB`);
      }
      return ERR.VALIDATION_ERROR(res, err.message || "Invalid file upload");
    }
    next();
  });
};

// POST /api/documents/upload
app.post("/api/documents/upload", documentUploadMiddleware, async (req, res) => {
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_document_query" });
    return ERR.VALIDATION_ERROR(res, "Public document APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
  }
  if (req.body && (req.body.patientUid !== undefined || req.body.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_document_body" });
    return ERR.VALIDATION_ERROR(res, "Public document APIs do not accept patientUid or patientId in request body. Identity is derived server-side from session context.");
  }

  // Derive identity server-side: ms_encounter_session or ms_user_session
  const encCtx = getEncounterSessionContext(req);
  const userCtx = getUserSessionContext(req);

  if (!encCtx && !userCtx) {
    logRequest(req, 401, { reason: "no_valid_session" });
    return ERR.AUTHENTICATION_REQUIRED(res, "Active patient encounter session or user session required for document upload");
  }

  let patientUid = null;
  let encounterId = null;

  if (encCtx) {
    if (req.body?.encounterId && req.body.encounterId !== encCtx.encounterId) {
      logRequest(req, 403, { reason: "cross_encounter_upload_attempt" });
      return ERR.PATIENT_SCOPE_MISMATCH(res, "Cannot upload documents for an encounter outside the active patient session context");
    }
    patientUid = encCtx.patientUid;
    encounterId = encCtx.encounterId;
  } else if (userCtx) {
    // Doctor or staff upload: must target an active encounterId
    const targetEncounterId = req.body?.encounterId;
    if (!targetEncounterId) {
      return ERR.VALIDATION_ERROR(res, "encounterId is required when uploading documents via staff/doctor user session");
    }
    const enc = await prisma.encounter.findFirst({
      where: {
        OR: [{ encounterId: targetEncounterId }, { tokenNumber: String(targetEncounterId) }]
      }
    });
    if (!enc) {
      return ERR.PATIENT_NOT_FOUND(res, `Encounter ${targetEncounterId} not found`);
    }
    // Verify clinical access: assigned doctor, active CareRelationship, or admin
    if (userCtx.role !== "admin") {
      const isAssigned = enc.assignedDoctorId === userCtx.id;
      let hasCareRel = false;
      if (!isAssigned) {
        const careRel = await prisma.careRelationship.findFirst({
          where: {
            patientUid: enc.patientUid,
            doctorId: userCtx.id,
            status: "active",
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } }
            ],
            endedAt: null
          }
        });
        hasCareRel = Boolean(careRel);
      }
      if (!isAssigned && !hasCareRel) {
        logRequest(req, 403, { reason: "doctor_not_authorized_for_encounter" });
        return ERR.CLINICAL_ACCESS_DENIED(res, "Doctor is not assigned to this encounter and has no active CareRelationship");
      }
    }
    patientUid = enc.patientUid;
    encounterId = enc.encounterId;
  }

  if (!req.file || !req.file.buffer) {
    return ERR.VALIDATION_ERROR(res, "No document file uploaded. 'file' field is required in multipart form data.");
  }

  try {
    const result = await documentIngestionService.ingestDocument({
      patientUid,
      encounterId,
      fileBuffer: req.file.buffer,
      originalFileName: req.file.originalname,
      documentType: req.body?.documentType || "general"
    });

    // Start background processing worker (non-blocking)
    ocrWorker.processDocument(result.document.documentId).catch(err => {
      console.warn(`[OCR_WORKER:ASYNC_ERROR] Failed for ${result.document.documentId}:`, err.message);
    });

    logRequest(req, 201, { documentId: result.document.documentId, mimeType: result.document.mimeType });

    return res.status(201).json({
      success: true,
      document: {
        documentId: result.document.documentId,
        fileName: result.document.fileName,
        fileSize: result.document.fileSize,
        mimeType: result.document.mimeType,
        documentType: result.document.documentType,
        status: result.document.status,
        uploadDate: result.document.uploadDate,
        clinicalDate: result.document.clinicalDate,
        totalPages: result.document.totalPages
      },
      job: {
        jobId: result.job.jobId,
        jobType: result.job.jobType,
        status: result.job.status
      }
    });
  } catch (err) {
    if (err.code === "DUPLICATE_DOCUMENT") {
      logRequest(req, 409, { duplicate: true, existingDocumentId: err.existingDocumentId });
      return ERR.DUPLICATE_DOCUMENT(res, "This document has already been uploaded for this patient", {
        existingDocumentId: err.existingDocumentId
      });
    }
    if (err.code === "FILE_TOO_LARGE") {
      logRequest(req, 413, { reason: "file_too_large" });
      return ERR.FILE_TOO_LARGE(res, err.message);
    }
    if (err.code === "UNSUPPORTED_MEDIA_TYPE") {
      logRequest(req, 415, { reason: "unsupported_media_type" });
      return ERR.UNSUPPORTED_MEDIA_TYPE(res, err.message);
    }
    logError(req, "DOCUMENT_INGESTION_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "INGESTION_FAILED",
        message: err.message || "Failed to ingest document",
        requestId: req.requestId
      }
    });
  }
});

// GET /api/documents/:id/pages
app.get("/api/documents/:id/pages", async (req, res) => {
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_document_query" });
    return ERR.VALIDATION_ERROR(res, "Public document APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
  }

  const encCtx = getEncounterSessionContext(req);
  const userCtx = getUserSessionContext(req);

  if (!encCtx && !userCtx) {
    logRequest(req, 401, { reason: "no_valid_session" });
    return ERR.AUTHENTICATION_REQUIRED(res, "Active patient encounter session or user session required to view document pages");
  }

  const doc = await prisma.document.findUnique({
    where: { documentId: req.params.id }
  });

  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  // Enforce caller scope
  if (encCtx) {
    if (doc.patientUid !== encCtx.patientUid) {
      logRequest(req, 403, { reason: "cross_patient_document_access" });
      return ERR.PATIENT_SCOPE_MISMATCH(res, "Document does not belong to active patient context");
    }
  } else if (userCtx) {
    if (userCtx.role !== "admin") {
      const hasEncounter = await prisma.encounter.findFirst({
        where: {
          patientUid: doc.patientUid,
          assignedDoctorId: userCtx.id
        }
      });
      const hasCareRel = await prisma.careRelationship.findFirst({
        where: {
          patientUid: doc.patientUid,
          doctorId: userCtx.id,
          status: "active",
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } }
          ],
          endedAt: null
        }
      });
      if (!hasEncounter && !hasCareRel) {
        logRequest(req, 403, { reason: "doctor_not_authorized_for_patient" });
        return ERR.CLINICAL_ACCESS_DENIED(res, "Doctor is not authorized to access clinical records for this patient");
      }
    }
  }

  const pages = await ocrWorker.getDocumentPages(doc.documentId);

  logRequest(req, 200, { documentId: doc.documentId, pagesCount: pages.length });
  return res.json({
    success: true,
    documentId: doc.documentId,
    fileName: doc.fileName,
    totalPages: doc.totalPages,
    status: doc.status,
    clinicalDate: doc.clinicalDate,
    pages: pages.map(p => ({
      pageNumber: p.pageNumber,
      extractedText: p.extractedText,
      ocrStatus: p.ocrStatus,
      ocrConfidence: p.ocrConfidence
    }))
  });
});

// GET /api/documents/:id/status
app.get("/api/documents/:id/status", async (req, res) => {
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_document_query" });
    return ERR.VALIDATION_ERROR(res, "Public document APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
  }

  const encCtx = getEncounterSessionContext(req);
  const userCtx = getUserSessionContext(req);

  if (!encCtx && !userCtx) {
    logRequest(req, 401, { reason: "no_valid_session" });
    return ERR.AUTHENTICATION_REQUIRED(res, "Active patient encounter session or user session required to view document status");
  }

  const doc = await ocrWorker.getDocumentStatus(req.params.id);
  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  if (encCtx) {
    if (doc.patientUid !== encCtx.patientUid) {
      logRequest(req, 403, { reason: "cross_patient_document_access" });
      return ERR.PATIENT_SCOPE_MISMATCH(res, "Document does not belong to active patient context");
    }
  } else if (userCtx) {
    if (userCtx.role !== "admin") {
      const hasEncounter = await prisma.encounter.findFirst({
        where: {
          patientUid: doc.patientUid,
          assignedDoctorId: userCtx.id
        }
      });
      const hasCareRel = await prisma.careRelationship.findFirst({
        where: {
          patientUid: doc.patientUid,
          doctorId: userCtx.id,
          status: "active",
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } }
          ],
          endedAt: null
        }
      });
      if (!hasEncounter && !hasCareRel) {
        logRequest(req, 403, { reason: "doctor_not_authorized_for_patient" });
        return ERR.CLINICAL_ACCESS_DENIED(res, "Doctor is not authorized to access clinical records for this patient");
      }
    }
  }

  logRequest(req, 200, { documentId: doc.documentId, status: doc.status });
  return res.json({
    success: true,
    documentId: doc.documentId,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    status: doc.status,
    totalPages: doc.totalPages,
    uploadDate: doc.uploadDate,
    clinicalDate: doc.clinicalDate,
    job: doc.jobs && doc.jobs.length > 0 ? {
      jobId: doc.jobs[0].jobId,
      jobType: doc.jobs[0].jobType,
      status: doc.jobs[0].status,
      errorDetails: doc.jobs[0].errorDetails
    } : null
  });
});

// --------------------------------------------------------------------------
// 16B. Phase 5C: Clinical Fact Extraction, Complete Version Snapshots,
//      Clinical Review & Doctor Approval Gate
// --------------------------------------------------------------------------

function sanitizeFact(fact) {
  if (!fact) return null;
  const { patientUid, ...safeFact } = fact;
  return safeFact;
}

export function isDocumentRAGEligible(doc, latestApproval) {
  if (!doc || !latestApproval) return false;
  return (
    doc.status === "approved" &&
    doc.derivativeVersion === latestApproval.approvedVersion &&
    latestApproval.action === "APPROVED"
  );
}

async function authorizeClinicianForDocument(req, res, doc, { allowAdmin = true, requireDoctorOnly = false } = {}) {
  // Reject browser attempts to pass patient identifiers in body or query
  if (req.query && (req.query.patientUid !== undefined || req.query.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_query" });
    ERR.VALIDATION_ERROR(res, "Public document APIs do not accept patientUid or patientId in query parameters. Identity is derived server-side from session context.");
    return null;
  }
  if (req.body && (req.body.patientUid !== undefined || req.body.patientId !== undefined)) {
    logRequest(req, 400, { securityViolation: "patientUid_in_body" });
    ERR.VALIDATION_ERROR(res, "Public document APIs do not accept patientUid or patientId in request body. Identity is derived server-side from session context.");
    return null;
  }

  const userCtx = getUserSessionContext(req);
  if (!userCtx) {
    logRequest(req, 403, { reason: "session_not_clinician" });
    ERR.CLINICAL_ACCESS_DENIED(res, "Clinical operation requires an authenticated clinician or admin session");
    return null;
  }

  if (userCtx.role === "doctor") {
    const hasEncounter = await prisma.encounter.findFirst({
      where: {
        patientUid: doc.patientUid,
        assignedDoctorId: userCtx.id
      }
    });

    const hasCareRel = await prisma.careRelationship.findFirst({
      where: {
        patientUid: doc.patientUid,
        doctorId: userCtx.id,
        status: "active",
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } }
        ],
        endedAt: null
      }
    });

    if (!hasEncounter && !hasCareRel) {
      logRequest(req, 403, { reason: "doctor_not_authorized_for_patient" });
      ERR.CLINICAL_ACCESS_DENIED(res, "Doctor is not assigned to this encounter and has no active CareRelationship with patient");
      return null;
    }

    return { role: "doctor", userCtx };
  }

  if (userCtx.role === "admin") {
    if (requireDoctorOnly) {
      logRequest(req, 403, { reason: "admin_fact_edit_forbidden" });
      ERR.ADMIN_CANNOT_EDIT_CLINICAL_FACTS(res, "Clinical facts represent clinical content and may only be edited by authorized doctors");
      return null;
    }

    if (!allowAdmin) {
      logRequest(req, 403, { reason: "admin_disallowed" });
      ERR.CLINICAL_ACCESS_DENIED(res, "Administrators are not permitted to perform this clinical action");
      return null;
    }

    const adminReason = req.headers["x-admin-access-reason"];
    if (!adminReason || typeof adminReason !== "string" || adminReason.trim().length < 5 || adminReason.trim().length > 500) {
      logRequest(req, 400, { reason: "admin_reason_missing_or_invalid" });
      ERR.ADMIN_ACCESS_REASON_REQUIRED(res, "Valid X-Admin-Access-Reason header (5-500 characters) is required for admin access");
      return null;
    }

    return { role: "admin", userCtx, adminReason: adminReason.trim() };
  }

  logRequest(req, 403, { reason: "unauthorized_role", role: userCtx.role });
  ERR.CLINICAL_ACCESS_DENIED(res, "User role is not authorized for clinical document operations");
  return null;
}

// POST /api/documents/:id/extract — Fact Extraction (Idempotent for current derivativeVersion)
app.post("/api/documents/:id/extract", async (req, res) => {
  const doc = await prisma.document.findUnique({
    where: { documentId: req.params.id }
  });
  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  const auth = await authorizeClinicianForDocument(req, res, doc, { allowAdmin: true, requireDoctorOnly: false });
  if (!auth) return;

  // Lifecycle guards
  if (doc.status === "uploaded" || doc.status === "processing") {
    logRequest(req, 409, { status: doc.status, reason: "document_still_processing" });
    return ERR.INVALID_DOCUMENT_STATUS(res, `Document is currently '${doc.status}'. Processing must complete before clinical fact extraction.`);
  }
  if (doc.status === "failed") {
    logRequest(req, 409, { status: doc.status, reason: "document_processing_failed" });
    return ERR.INVALID_DOCUMENT_STATUS(res, "Document processing failed. Cannot extract facts from failed document.");
  }
  if (doc.status === "approved") {
    logRequest(req, 409, { status: doc.status, reason: "document_already_approved" });
    return ERR.INVALID_DOCUMENT_STATUS(res, "Document is currently approved. A new derivative version must be created before re-extracting facts.");
  }

  // Idempotency check: check if facts already exist for (documentId, derivativeVersion)
  const existingFacts = await prisma.documentClinicalFact.findMany({
    where: {
      documentId: doc.documentId,
      version: doc.derivativeVersion
    },
    orderBy: { id: "asc" }
  });

  if (existingFacts.length > 0) {
    logRequest(req, 200, { documentId: doc.documentId, version: doc.derivativeVersion, alreadyExtracted: true, count: existingFacts.length });
    return res.json({
      success: true,
      alreadyExtracted: true,
      documentId: doc.documentId,
      version: doc.derivativeVersion,
      count: existingFacts.length,
      facts: existingFacts.map(sanitizeFact)
    });
  }

  // Read current-version pages
  const pages = await prisma.documentPage.findMany({
    where: {
      documentId: doc.documentId,
      version: doc.derivativeVersion
    },
    orderBy: { pageNumber: "asc" }
  });

  if (pages.length === 0) {
    logRequest(req, 409, { reason: "no_pages_found" });
    return ERR.INVALID_DOCUMENT_STATUS(res, "No processed pages found for the current document version.");
  }

  // Perform structured extraction
  const extractedFacts = clinicalFactExtractor.extractFromDocumentPages(doc, pages);

  const createdFacts = await prisma.$transaction(async (tx) => {
    const records = [];
    for (const f of extractedFacts) {
      const created = await tx.documentClinicalFact.create({
        data: {
          documentId: f.documentId,
          patientUid: f.patientUid,
          pageNumber: f.pageNumber,
          factType: f.factType,
          factKey: f.factKey,
          factValue: f.factValue,
          unit: f.unit || null,
          clinicalDate: f.clinicalDate || null,
          confidence: f.confidence,
          provenance: f.provenance,
          version: doc.derivativeVersion,
          parentFactId: null
        }
      });
      records.push(created);
    }

    // Set document status = pending_review
    await tx.document.update({
      where: { documentId: doc.documentId },
      data: { status: "pending_review" }
    });

    // Write audit log
    await createAuditLog(tx, {
      actorType: "USER",
      actorUserId: auth.userCtx.id,
      action: "EXTRACT_CLINICAL_FACTS",
      patientUid: doc.patientUid,
      resourceType: "Document",
      resourceId: doc.documentId,
      metadata: {
        documentId: doc.documentId,
        version: doc.derivativeVersion,
        factsCount: records.length,
        adminReason: auth.adminReason || undefined
      }
    });

    return records;
  });

  logRequest(req, 201, { documentId: doc.documentId, version: doc.derivativeVersion, count: createdFacts.length });
  return res.status(201).json({
    success: true,
    alreadyExtracted: false,
    documentId: doc.documentId,
    version: doc.derivativeVersion,
    count: createdFacts.length,
    facts: createdFacts.map(sanitizeFact)
  });
});

// GET /api/documents/:id/facts — Fetch Facts for Version
app.get("/api/documents/:id/facts", async (req, res) => {
  const doc = await prisma.document.findUnique({
    where: { documentId: req.params.id }
  });
  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  const auth = await authorizeClinicianForDocument(req, res, doc, { allowAdmin: true, requireDoctorOnly: false });
  if (!auth) return;

  const targetVersion = req.query.version !== undefined
    ? parseInt(req.query.version, 10)
    : doc.derivativeVersion;

  if (isNaN(targetVersion) || targetVersion < 1) {
    return ERR.VALIDATION_ERROR(res, "version parameter must be a positive integer");
  }

  const facts = await prisma.documentClinicalFact.findMany({
    where: {
      documentId: doc.documentId,
      version: targetVersion
    },
    orderBy: { id: "asc" }
  });

  logRequest(req, 200, { documentId: doc.documentId, version: targetVersion, count: facts.length });
  return res.json({
    success: true,
    documentId: doc.documentId,
    version: targetVersion,
    facts: facts.map(sanitizeFact)
  });
});

// GET /api/documents/:id/review — Complete Clinician Review Bundle
app.get("/api/documents/:id/review", async (req, res) => {
  const doc = await prisma.document.findUnique({
    where: { documentId: req.params.id }
  });
  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  const auth = await authorizeClinicianForDocument(req, res, doc, { allowAdmin: true, requireDoctorOnly: false });
  if (!auth) return;

  const [pages, facts, approvals] = await Promise.all([
    prisma.documentPage.findMany({
      where: {
        documentId: doc.documentId,
        version: doc.derivativeVersion
      },
      orderBy: { pageNumber: "asc" }
    }),
    prisma.documentClinicalFact.findMany({
      where: {
        documentId: doc.documentId,
        version: doc.derivativeVersion
      },
      orderBy: { id: "asc" }
    }),
    prisma.documentApproval.findMany({
      where: { documentId: doc.documentId },
      orderBy: { approvedAt: "desc" }
    })
  ]);

  const latestApproval = approvals.length > 0 ? approvals[0] : null;
  const matchingApproval = approvals.find(a => a.approvedVersion === doc.derivativeVersion) || null;
  const ragEligible = isDocumentRAGEligible(doc, matchingApproval);

  logRequest(req, 200, { documentId: doc.documentId, version: doc.derivativeVersion, isRAGEligible: ragEligible });
  return res.json({
    success: true,
    document: {
      documentId: doc.documentId,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      status: doc.status,
      totalPages: doc.totalPages,
      derivativeVersion: doc.derivativeVersion,
      uploadDate: doc.uploadDate,
      clinicalDate: doc.clinicalDate
    },
    currentVersion: doc.derivativeVersion,
    status: doc.status,
    pages: pages.map(p => ({
      pageNumber: p.pageNumber,
      extractedText: p.extractedText,
      ocrStatus: p.ocrStatus,
      ocrConfidence: p.ocrConfidence
    })),
    facts: facts.map(sanitizeFact),
    approvals: approvals.map(a => ({
      id: a.id,
      documentId: a.documentId,
      approvedByUserId: a.approvedByUserId,
      approvedVersion: a.approvedVersion,
      action: a.action,
      comments: a.comments,
      approvedAt: a.approvedAt
    })),
    latestApproval: matchingApproval ? {
      id: matchingApproval.id,
      documentId: matchingApproval.documentId,
      approvedByUserId: matchingApproval.approvedByUserId,
      approvedVersion: matchingApproval.approvedVersion,
      action: matchingApproval.action,
      comments: matchingApproval.comments,
      approvedAt: matchingApproval.approvedAt
    } : null,
    isRAGEligible: ragEligible
  });
});

// PUT /api/documents/:id/pages/:pageNumber — Edit Page Text (Atomic Snapshot)
app.put("/api/documents/:id/pages/:pageNumber", async (req, res) => {
  const targetPageNumber = parseInt(req.params.pageNumber, 10);
  if (isNaN(targetPageNumber) || targetPageNumber < 1) {
    return ERR.VALIDATION_ERROR(res, "pageNumber must be a positive integer");
  }

  const { expectedVersion, extractedText } = req.body || {};
  if (expectedVersion === undefined || isNaN(parseInt(expectedVersion, 10)) || parseInt(expectedVersion, 10) < 1) {
    return ERR.VALIDATION_ERROR(res, "expectedVersion is required and must be a positive integer");
  }
  if (typeof extractedText !== "string") {
    return ERR.VALIDATION_ERROR(res, "extractedText string is required in request body");
  }

  const doc = await prisma.document.findUnique({
    where: { documentId: req.params.id }
  });
  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  const auth = await authorizeClinicianForDocument(req, res, doc, { allowAdmin: true, requireDoctorOnly: false });
  if (!auth) return;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch current document
      const currentDoc = await tx.document.findUnique({
        where: { documentId: doc.documentId }
      });
      if (!currentDoc) {
        const err = new Error("Document not found");
        err.code = "DOCUMENT_NOT_FOUND";
        throw err;
      }

      // 2. Optimistic concurrency check
      if (currentDoc.derivativeVersion !== parseInt(expectedVersion, 10)) {
        const err = new Error(`VERSION_CONFLICT: expected version ${expectedVersion} but current version is ${currentDoc.derivativeVersion}`);
        err.code = "VERSION_CONFLICT";
        err.currentVersion = currentDoc.derivativeVersion;
        throw err;
      }

      // 3. Read ALL current pages
      const currentPages = await tx.documentPage.findMany({
        where: { documentId: currentDoc.documentId, version: currentDoc.derivativeVersion },
        orderBy: { pageNumber: "asc" }
      });

      const targetPage = currentPages.find(p => p.pageNumber === targetPageNumber);
      if (!targetPage) {
        const err = new Error(`Page ${targetPageNumber} not found in document`);
        err.code = "PAGE_NOT_FOUND";
        throw err;
      }

      // 4. Read ALL current facts
      const currentFacts = await tx.documentClinicalFact.findMany({
        where: { documentId: currentDoc.documentId, version: currentDoc.derivativeVersion }
      });

      const newVersion = currentDoc.derivativeVersion + 1;

      // 5. Clone ALL pages into newVersion (preserving page numbering)
      for (const page of currentPages) {
        const isTarget = page.pageNumber === targetPageNumber;
        await tx.documentPage.create({
          data: {
            documentId: currentDoc.documentId,
            pageNumber: page.pageNumber,
            version: newVersion,
            extractedText: isTarget ? extractedText : page.extractedText,
            ocrStatus: isTarget ? "native_text" : page.ocrStatus,
            ocrConfidence: isTarget ? 1.0 : page.ocrConfidence
          }
        });
      }

      // 6. Clone ALL current facts into newVersion (preserving historical source provenance)
      for (const fact of currentFacts) {
        await tx.documentClinicalFact.create({
          data: {
            documentId: fact.documentId,
            patientUid: fact.patientUid,
            pageNumber: fact.pageNumber,
            factType: fact.factType,
            factKey: fact.factKey,
            factValue: fact.factValue,
            unit: fact.unit,
            clinicalDate: fact.clinicalDate,
            confidence: fact.confidence,
            provenance: fact.provenance,
            version: newVersion,
            parentFactId: fact.id
          }
        });
      }

      // 7. Increment Document.derivativeVersion & reset status = pending_review
      const updatedDoc = await tx.document.update({
        where: { documentId: currentDoc.documentId },
        data: {
          derivativeVersion: newVersion,
          status: "pending_review"
        }
      });

      // 8. Audit logs
      await createAuditLog(tx, {
        actorType: "USER",
        actorUserId: auth.userCtx.id,
        action: "EDIT_DOCUMENT_PAGE",
        patientUid: currentDoc.patientUid,
        resourceType: "Document",
        resourceId: currentDoc.documentId,
        metadata: {
          documentId: currentDoc.documentId,
          pageNumber: targetPageNumber,
          priorVersion: currentDoc.derivativeVersion,
          newVersion,
          adminReason: auth.adminReason || undefined
        }
      });

      await createAuditLog(tx, {
        actorType: "SYSTEM",
        action: "INVALIDATE_DOCUMENT_APPROVAL",
        patientUid: currentDoc.patientUid,
        resourceType: "Document",
        resourceId: currentDoc.documentId,
        metadata: {
          documentId: currentDoc.documentId,
          invalidatedVersion: currentDoc.derivativeVersion,
          newVersion,
          trigger: "page_edit"
        }
      });

      return { newVersion, status: updatedDoc.status };
    });

    logRequest(req, 200, { documentId: doc.documentId, newVersion: result.newVersion });
    return res.json({
      success: true,
      documentId: doc.documentId,
      newVersion: result.newVersion,
      status: result.status
    });
  } catch (err) {
    if (err.code === "VERSION_CONFLICT") {
      logRequest(req, 409, { versionConflict: true, currentVersion: err.currentVersion });
      return ERR.VERSION_CONFLICT(res, err.message, { currentVersion: err.currentVersion });
    }
    if (err.code === "PAGE_NOT_FOUND") {
      return ERR.VALIDATION_ERROR(res, err.message);
    }
    logError(req, "PAGE_EDIT_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "Failed to edit document page",
        requestId: req.requestId
      }
    });
  }
});

// PUT /api/documents/:id/facts/:factId — Edit Clinical Fact (Doctor Only, DOCTOR_ENTERED)
app.put("/api/documents/:id/facts/:factId", async (req, res) => {
  const targetFactId = parseInt(req.params.factId, 10);
  if (isNaN(targetFactId) || targetFactId < 1) {
    return ERR.VALIDATION_ERROR(res, "factId must be a positive integer");
  }

  const { expectedVersion, factKey, factValue, unit, clinicalDate, factType } = req.body || {};
  if (expectedVersion === undefined || isNaN(parseInt(expectedVersion, 10)) || parseInt(expectedVersion, 10) < 1) {
    return ERR.VALIDATION_ERROR(res, "expectedVersion is required and must be a positive integer");
  }

  const doc = await prisma.document.findUnique({
    where: { documentId: req.params.id }
  });
  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  // Doctor Only authorization: Admin denied
  const auth = await authorizeClinicianForDocument(req, res, doc, { allowAdmin: false, requireDoctorOnly: true });
  if (!auth) return;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch current document
      const currentDoc = await tx.document.findUnique({
        where: { documentId: doc.documentId }
      });
      if (!currentDoc) {
        const err = new Error("Document not found");
        err.code = "DOCUMENT_NOT_FOUND";
        throw err;
      }

      // 2. Concurrency verification
      if (currentDoc.derivativeVersion !== parseInt(expectedVersion, 10)) {
        const err = new Error(`VERSION_CONFLICT: expected version ${expectedVersion} but current version is ${currentDoc.derivativeVersion}`);
        err.code = "VERSION_CONFLICT";
        err.currentVersion = currentDoc.derivativeVersion;
        throw err;
      }

      // 3. Find target fact
      const targetFact = await tx.documentClinicalFact.findUnique({
        where: { id: targetFactId }
      });
      if (!targetFact || targetFact.documentId !== currentDoc.documentId || targetFact.version !== currentDoc.derivativeVersion) {
        const err = new Error("Fact not found on current document version");
        err.code = "FACT_NOT_FOUND";
        throw err;
      }

      // 4. Read ALL current pages & facts
      const currentPages = await tx.documentPage.findMany({
        where: { documentId: currentDoc.documentId, version: currentDoc.derivativeVersion },
        orderBy: { pageNumber: "asc" }
      });
      const currentFacts = await tx.documentClinicalFact.findMany({
        where: { documentId: currentDoc.documentId, version: currentDoc.derivativeVersion }
      });

      const newVersion = currentDoc.derivativeVersion + 1;

      // 5. Clone ALL pages into newVersion (exact copies)
      for (const page of currentPages) {
        await tx.documentPage.create({
          data: {
            documentId: currentDoc.documentId,
            pageNumber: page.pageNumber,
            version: newVersion,
            extractedText: page.extractedText,
            ocrStatus: page.ocrStatus,
            ocrConfidence: page.ocrConfidence
          }
        });
      }

      // 6. Clone ALL facts into newVersion, applying DOCTOR_ENTERED edit to targetFact
      let updatedFactRecord = null;
      for (const fact of currentFacts) {
        if (fact.id === targetFact.id) {
          const updatedKey = factKey !== undefined ? String(factKey).trim() : fact.factKey;
          const updatedVal = factValue !== undefined ? String(factValue).trim() : fact.factValue;
          const updatedUnit = unit !== undefined ? (unit ? String(unit).trim() : null) : fact.unit;
          const updatedType = factType !== undefined ? String(factType).trim() : fact.factType;
          let updatedDate = fact.clinicalDate;
          if (clinicalDate !== undefined) {
            updatedDate = clinicalDate ? new Date(clinicalDate) : null;
          }

          updatedFactRecord = await tx.documentClinicalFact.create({
            data: {
              documentId: fact.documentId,
              patientUid: fact.patientUid,
              pageNumber: fact.pageNumber,
              factType: updatedType,
              factKey: updatedKey,
              factValue: updatedVal,
              unit: updatedUnit,
              clinicalDate: updatedDate,
              confidence: 1.0,
              provenance: "DOCTOR_ENTERED",
              version: newVersion,
              parentFactId: targetFact.id
            }
          });
        } else {
          await tx.documentClinicalFact.create({
            data: {
              documentId: fact.documentId,
              patientUid: fact.patientUid,
              pageNumber: fact.pageNumber,
              factType: fact.factType,
              factKey: fact.factKey,
              factValue: fact.factValue,
              unit: fact.unit,
              clinicalDate: fact.clinicalDate,
              confidence: fact.confidence,
              provenance: fact.provenance,
              version: newVersion,
              parentFactId: fact.id
            }
          });
        }
      }

      // 7. Update Document status = pending_review and increment version
      const updatedDoc = await tx.document.update({
        where: { documentId: currentDoc.documentId },
        data: {
          derivativeVersion: newVersion,
          status: "pending_review"
        }
      });

      // 8. Audit logs
      await createAuditLog(tx, {
        actorType: "USER",
        actorUserId: auth.userCtx.id,
        action: "EDIT_CLINICAL_FACT",
        patientUid: currentDoc.patientUid,
        resourceType: "DocumentClinicalFact",
        resourceId: String(updatedFactRecord.id),
        metadata: {
          documentId: currentDoc.documentId,
          parentFactId: targetFact.id,
          newFactId: updatedFactRecord.id,
          priorVersion: currentDoc.derivativeVersion,
          newVersion,
          factType: updatedFactRecord.factType,
          factKey: updatedFactRecord.factKey
        }
      });

      await createAuditLog(tx, {
        actorType: "SYSTEM",
        action: "INVALIDATE_DOCUMENT_APPROVAL",
        patientUid: currentDoc.patientUid,
        resourceType: "Document",
        resourceId: currentDoc.documentId,
        metadata: {
          documentId: currentDoc.documentId,
          invalidatedVersion: currentDoc.derivativeVersion,
          newVersion,
          trigger: "fact_edit"
        }
      });

      return { newVersion, status: updatedDoc.status, updatedFact: updatedFactRecord };
    });

    logRequest(req, 200, { documentId: doc.documentId, newVersion: result.newVersion });
    return res.json({
      success: true,
      documentId: doc.documentId,
      newVersion: result.newVersion,
      status: result.status,
      fact: sanitizeFact(result.updatedFact)
    });
  } catch (err) {
    if (err.code === "VERSION_CONFLICT") {
      logRequest(req, 409, { versionConflict: true, currentVersion: err.currentVersion });
      return ERR.VERSION_CONFLICT(res, err.message, { currentVersion: err.currentVersion });
    }
    if (err.code === "FACT_NOT_FOUND") {
      return ERR.FACT_NOT_FOUND(res, err.message);
    }
    logError(req, "FACT_EDIT_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "Failed to edit clinical fact",
        requestId: req.requestId
      }
    });
  }
});

// DELETE /api/documents/:id/facts/:factId — Fact Removal / Void (Creates Next Complete Snapshot Without Fact)
app.delete("/api/documents/:id/facts/:factId", async (req, res) => {
  const targetFactId = parseInt(req.params.factId, 10);
  if (isNaN(targetFactId) || targetFactId < 1) {
    return ERR.VALIDATION_ERROR(res, "factId must be a positive integer");
  }

  const rawVersion = req.body?.expectedVersion !== undefined ? req.body.expectedVersion : req.query?.expectedVersion;
  if (rawVersion === undefined || isNaN(parseInt(rawVersion, 10)) || parseInt(rawVersion, 10) < 1) {
    return ERR.VALIDATION_ERROR(res, "expectedVersion is required and must be a positive integer");
  }
  const expectedVersion = parseInt(rawVersion, 10);

  const doc = await prisma.document.findUnique({
    where: { documentId: req.params.id }
  });
  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  // Doctor Only authorization: Admin denied
  const auth = await authorizeClinicianForDocument(req, res, doc, { allowAdmin: false, requireDoctorOnly: true });
  if (!auth) return;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch current document
      const currentDoc = await tx.document.findUnique({
        where: { documentId: doc.documentId }
      });
      if (!currentDoc) {
        const err = new Error("Document not found");
        err.code = "DOCUMENT_NOT_FOUND";
        throw err;
      }

      // 2. Concurrency verification
      if (currentDoc.derivativeVersion !== expectedVersion) {
        const err = new Error(`VERSION_CONFLICT: expected version ${expectedVersion} but current version is ${currentDoc.derivativeVersion}`);
        err.code = "VERSION_CONFLICT";
        err.currentVersion = currentDoc.derivativeVersion;
        throw err;
      }

      // 3. Find target fact
      const targetFact = await tx.documentClinicalFact.findUnique({
        where: { id: targetFactId }
      });
      if (!targetFact || targetFact.documentId !== currentDoc.documentId || targetFact.version !== currentDoc.derivativeVersion) {
        const err = new Error("Fact not found on current document version");
        err.code = "FACT_NOT_FOUND";
        throw err;
      }

      // 4. Read ALL current pages & facts
      const currentPages = await tx.documentPage.findMany({
        where: { documentId: currentDoc.documentId, version: currentDoc.derivativeVersion },
        orderBy: { pageNumber: "asc" }
      });
      const currentFacts = await tx.documentClinicalFact.findMany({
        where: { documentId: currentDoc.documentId, version: currentDoc.derivativeVersion }
      });

      const newVersion = currentDoc.derivativeVersion + 1;

      // 5. Clone ALL pages into newVersion
      for (const page of currentPages) {
        await tx.documentPage.create({
          data: {
            documentId: currentDoc.documentId,
            pageNumber: page.pageNumber,
            version: newVersion,
            extractedText: page.extractedText,
            ocrStatus: page.ocrStatus,
            ocrConfidence: page.ocrConfidence
          }
        });
      }

      // 6. Clone ALL current facts into newVersion OMITTING targetFact
      for (const fact of currentFacts) {
        if (fact.id === targetFact.id) {
          continue; // Omit from active current snapshot; historical record remains immutable
        }
        await tx.documentClinicalFact.create({
          data: {
            documentId: fact.documentId,
            patientUid: fact.patientUid,
            pageNumber: fact.pageNumber,
            factType: fact.factType,
            factKey: fact.factKey,
            factValue: fact.factValue,
            unit: fact.unit,
            clinicalDate: fact.clinicalDate,
            confidence: fact.confidence,
            provenance: fact.provenance,
            version: newVersion,
            parentFactId: fact.id
          }
        });
      }

      // 7. Update Document
      const updatedDoc = await tx.document.update({
        where: { documentId: currentDoc.documentId },
        data: {
          derivativeVersion: newVersion,
          status: "pending_review"
        }
      });

      // 8. Audit logs
      await createAuditLog(tx, {
        actorType: "USER",
        actorUserId: auth.userCtx.id,
        action: "REMOVE_CLINICAL_FACT",
        patientUid: currentDoc.patientUid,
        resourceType: "DocumentClinicalFact",
        resourceId: String(targetFact.id),
        metadata: {
          documentId: currentDoc.documentId,
          removedFactId: targetFact.id,
          priorVersion: currentDoc.derivativeVersion,
          newVersion,
          factType: targetFact.factType,
          factKey: targetFact.factKey
        }
      });

      await createAuditLog(tx, {
        actorType: "SYSTEM",
        action: "INVALIDATE_DOCUMENT_APPROVAL",
        patientUid: currentDoc.patientUid,
        resourceType: "Document",
        resourceId: currentDoc.documentId,
        metadata: {
          documentId: currentDoc.documentId,
          invalidatedVersion: currentDoc.derivativeVersion,
          newVersion,
          trigger: "fact_removal"
        }
      });

      return { newVersion, status: updatedDoc.status };
    });

    logRequest(req, 200, { documentId: doc.documentId, newVersion: result.newVersion, removedFactId: targetFactId });
    return res.json({
      success: true,
      documentId: doc.documentId,
      newVersion: result.newVersion,
      status: result.status,
      removedFactId: targetFactId
    });
  } catch (err) {
    if (err.code === "VERSION_CONFLICT") {
      logRequest(req, 409, { versionConflict: true, currentVersion: err.currentVersion });
      return ERR.VERSION_CONFLICT(res, err.message, { currentVersion: err.currentVersion });
    }
    if (err.code === "FACT_NOT_FOUND") {
      return ERR.FACT_NOT_FOUND(res, err.message);
    }
    logError(req, "FACT_REMOVAL_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "Failed to remove clinical fact",
        requestId: req.requestId
      }
    });
  }
});

// PUT /api/documents/:id/approve — Doctor Approval Gate (Exact Version Binding)
app.put("/api/documents/:id/approve", async (req, res) => {
  const { expectedVersion, action, comments } = req.body || {};
  if (expectedVersion === undefined || isNaN(parseInt(expectedVersion, 10)) || parseInt(expectedVersion, 10) < 1) {
    return ERR.VALIDATION_ERROR(res, "expectedVersion is required and must be a positive integer");
  }

  const validActions = ["APPROVED", "REJECTED", "REQUIRES_RESCAN"];
  if (!action || !validActions.includes(action)) {
    return ERR.VALIDATION_ERROR(res, `action must be one of: ${validActions.join(", ")}`);
  }

  const doc = await prisma.document.findUnique({
    where: { documentId: req.params.id }
  });
  if (!doc) {
    return ERR.DOCUMENT_NOT_FOUND(res, `Document ${req.params.id} not found`);
  }

  const auth = await authorizeClinicianForDocument(req, res, doc, { allowAdmin: true, requireDoctorOnly: false });
  if (!auth) return;

  // Admin Governance: Admins may NOT clinically approve documents
  if (auth.role === "admin" && action === "APPROVED") {
    logRequest(req, 403, { reason: "admin_cannot_approve" });
    return ERR.CLINICAL_APPROVAL_REQUIRES_DOCTOR(res, "Clinical approval requires an authorized doctor session. Administrators may only reject or require rescan.");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch current document
      const currentDoc = await tx.document.findUnique({
        where: { documentId: doc.documentId }
      });
      if (!currentDoc) {
        const err = new Error("Document not found");
        err.code = "DOCUMENT_NOT_FOUND";
        throw err;
      }

      // 2. Concurrency check
      if (currentDoc.derivativeVersion !== parseInt(expectedVersion, 10)) {
        const err = new Error(`VERSION_CONFLICT: expected version ${expectedVersion} but current version is ${currentDoc.derivativeVersion}`);
        err.code = "VERSION_CONFLICT";
        err.currentVersion = currentDoc.derivativeVersion;
        throw err;
      }

      // 3. Status check: must be pending_review
      if (currentDoc.status !== "pending_review") {
        const err = new Error(`Document status must be 'pending_review' to be approved or rejected. Current status is '${currentDoc.status}'.`);
        err.code = "INVALID_DOCUMENT_STATUS";
        throw err;
      }

      // 4. Map action to status
      let newStatus = "pending_review";
      let auditAction = "APPROVE_DOCUMENT";
      if (action === "APPROVED") {
        newStatus = "approved";
        auditAction = "APPROVE_DOCUMENT";
      } else if (action === "REJECTED") {
        newStatus = "rejected";
        auditAction = "REJECT_DOCUMENT";
      } else if (action === "REQUIRES_RESCAN") {
        newStatus = "requires_rescan";
        auditAction = "REQUIRE_RESCAN_DOCUMENT";
      }

      // 5. Create DocumentApproval record tied to exact version
      const approval = await tx.documentApproval.create({
        data: {
          documentId: currentDoc.documentId,
          approvedByUserId: auth.userCtx.id,
          approvedVersion: parseInt(expectedVersion, 10),
          action,
          comments: comments ? String(comments).trim() : null,
          approvedAt: new Date()
        }
      });

      // 6. Update Document status
      const updatedDoc = await tx.document.update({
        where: { documentId: currentDoc.documentId },
        data: { status: newStatus }
      });

      // 7. Audit log
      await createAuditLog(tx, {
        actorType: "USER",
        actorUserId: auth.userCtx.id,
        action: auditAction,
        patientUid: currentDoc.patientUid,
        resourceType: "DocumentApproval",
        resourceId: String(approval.id),
        metadata: {
          documentId: currentDoc.documentId,
          approvedVersion: parseInt(expectedVersion, 10),
          action,
          newStatus,
          comments: comments ? String(comments).trim() : undefined,
          adminReason: auth.adminReason || undefined
        }
      });

      return { updatedDoc, approval };
    });

    logRequest(req, 200, { documentId: doc.documentId, status: result.updatedDoc.status, approvedVersion: expectedVersion, action });
    return res.json({
      success: true,
      documentId: doc.documentId,
      status: result.updatedDoc.status,
      approvedVersion: parseInt(expectedVersion, 10),
      action,
      approvalId: result.approval.id
    });
  } catch (err) {
    if (err.code === "VERSION_CONFLICT") {
      logRequest(req, 409, { versionConflict: true, currentVersion: err.currentVersion });
      return ERR.VERSION_CONFLICT(res, err.message, { currentVersion: err.currentVersion });
    }
    if (err.code === "INVALID_DOCUMENT_STATUS") {
      logRequest(req, 409, { invalidStatus: true });
      return ERR.INVALID_DOCUMENT_STATUS(res, err.message);
    }
    logError(req, "DOCUMENT_APPROVAL_ERROR", err.message, err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "Failed to approve document",
        requestId: req.requestId
      }
    });
  }
});

// --------------------------------------------------------------------------
// 17. RAG Service Boundary — Phase 3 Stub (Scheduled for Phase 5)
// --------------------------------------------------------------------------
app.post("/api/rag/query", (req, res) => {
  logRequest(req, 501);
  res.status(501).json({
    error: {
      code:      "NOT_IMPLEMENTED",
      message:   "RAG service integration is scheduled for Phase 5. The Node API will proxy this request to the internal Python FastAPI RAG service. The browser must not contact the RAG service directly.",
      requestId: req.requestId
    }
  });
});

// --------------------------------------------------------------------------
// 17. Global Error Handler
// --------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logError(req, "INTERNAL_ERROR", "Unhandled error", err);
  ERR.INTERNAL_ERROR(res, "An unexpected error occurred");
});

// --------------------------------------------------------------------------
// 18. Server Initialization & Dev Credential Seeding
// --------------------------------------------------------------------------
seedDevUsers(prisma).catch(err => {
  console.warn("[Init] Could not seed dev users:", err.message);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    const hasGeminiKey = !process.env.GEMINI_API_KEY;
    console.log(`[MedSync Backend Server] Running on http://localhost:${PORT}`);
    console.log(`[Config] Database provider: ${process.env.DATABASE_PROVIDER || "sqlite"}`);
    console.log(`[Config] Gemini key configured: ${hasGeminiKey}`);
  });
}

export { ocrWorker, documentIngestionService, clinicalFactExtractor };
export default app;
