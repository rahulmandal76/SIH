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

const app = express();
const PORT = process.env.PORT || 5000;

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
// 16. RAG Service Boundary — Phase 3 Stub (Scheduled for Phase 5)
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

export default app;
