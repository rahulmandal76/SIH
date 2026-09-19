import crypto from "crypto";

// --------------------------------------------------------------------------
// Session TTL Configuration
// --------------------------------------------------------------------------
const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours
const ENCOUNTER_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours
const USER_TTL_MS = 8 * 60 * 60 * 1000;       // 8 hours
const HANDLE_TTL_MS = 5 * 60 * 1000;          // 5 minutes

// In-memory session stores (Local Development / Testing)
// Production would use Redis/Valkey
const deviceSessions = new Map();     // token -> { deviceId, terminalId, role: "device", createdAt, expiresAt }
const encounterSessions = new Map();  // token -> { patientUid, encounterId, role: "patient_intake", createdAt, expiresAt }
const userSessions = new Map();       // token -> { userId, userUid, name, email, role, chamber, createdAt, expiresAt }

// Handle stores
const lookupHandles = new Map();      // handle -> { contextType, contextId, candidates, createdAt, expiresAt, consumed }
const registrationHandles = new Map();// handle -> { contextType, contextId, patientUid, createdAt, expiresAt, consumed }

// --------------------------------------------------------------------------
// 1. Device Sessions (ms_device_session)
// --------------------------------------------------------------------------
export function createDeviceSession(deviceId) {
  const token = `dev_${crypto.randomBytes(32).toString("hex")}`;
  const now = Date.now();
  deviceSessions.set(token, {
    deviceId: deviceId || "KIOSK-DEV-01",
    terminalId: deviceId || "KIOSK-DEV-01",
    role: "device",
    createdAt: now,
    expiresAt: now + DEVICE_TTL_MS
  });
  return token;
}

export function validateDeviceSession(token) {
  if (!token) return { valid: false, reason: "SESSION_NOT_FOUND" };
  const session = deviceSessions.get(token);
  if (!session) return { valid: false, reason: "SESSION_NOT_FOUND" };
  if (Date.now() > session.expiresAt) {
    deviceSessions.delete(token);
    return { valid: false, reason: "SESSION_EXPIRED" };
  }
  return { valid: true, session };
}

export function destroyDeviceSession(token) {
  if (token) {
    deviceSessions.delete(token);
  }
}

// --------------------------------------------------------------------------
// 2. Encounter Sessions (ms_encounter_session)
// --------------------------------------------------------------------------
export function createEncounterSession(patientUid, encounterId) {
  const token = `enc_${crypto.randomBytes(32).toString("hex")}`;
  const now = Date.now();
  encounterSessions.set(token, {
    patientUid,
    encounterId,
    role: "patient_intake",
    createdAt: now,
    expiresAt: now + ENCOUNTER_TTL_MS
  });
  return token;
}

export function validateEncounterSession(token) {
  if (!token) return { valid: false, reason: "SESSION_NOT_FOUND" };
  const session = encounterSessions.get(token);
  if (!session) return { valid: false, reason: "SESSION_NOT_FOUND" };
  if (Date.now() > session.expiresAt) {
    encounterSessions.delete(token);
    return { valid: false, reason: "SESSION_EXPIRED" };
  }
  return { valid: true, session };
}

export function destroyEncounterSession(token) {
  if (token) {
    encounterSessions.delete(token);
  }
}

// --------------------------------------------------------------------------
// 3. User Sessions (ms_user_session)
// --------------------------------------------------------------------------
export function createUserSession(user) {
  const token = `usr_${crypto.randomBytes(32).toString("hex")}`;
  const now = Date.now();
  userSessions.set(token, {
    userId: user.id,
    userUid: user.userUid,
    name: user.name,
    email: user.email,
    role: user.role,
    chamber: user.chamber || null,
    createdAt: now,
    expiresAt: now + USER_TTL_MS
  });
  return token;
}

export function validateUserSession(token) {
  if (!token) return { valid: false, reason: "SESSION_NOT_FOUND" };
  const session = userSessions.get(token);
  if (!session) return { valid: false, reason: "SESSION_NOT_FOUND" };
  if (Date.now() > session.expiresAt) {
    userSessions.delete(token);
    return { valid: false, reason: "SESSION_EXPIRED" };
  }
  return { valid: true, session };
}

export function destroyUserSession(token) {
  if (token) {
    userSessions.delete(token);
  }
}

// --------------------------------------------------------------------------
// 4. Lookup Handles (5-min TTL, single use, context-bound)
// --------------------------------------------------------------------------
export function createLookupHandle(contextType, contextId, candidates) {
  const handle = `lh_${crypto.randomBytes(24).toString("hex")}`;
  const now = Date.now();
  lookupHandles.set(handle, {
    contextType, // "DEVICE" or "USER"
    contextId,   // deviceId or userId
    candidates,  // Array of { candidateId, patientUid, maskedPreview }
    createdAt: now,
    expiresAt: now + HANDLE_TTL_MS,
    consumed: false
  });
  return handle;
}

export function resolveLookupCandidate(handle, candidateId, contextType, contextId) {
  if (!handle) {
    return { error: "HANDLE_REQUIRED", message: "Lookup handle is required" };
  }
  const entry = lookupHandles.get(handle);
  if (!entry) {
    return { error: "HANDLE_EXPIRED", message: "Lookup handle not found or expired" };
  }
  if (entry.consumed) {
    return { error: "HANDLE_ALREADY_CONSUMED", message: "Lookup handle has already been consumed" };
  }
  if (Date.now() > entry.expiresAt) {
    lookupHandles.delete(handle);
    return { error: "HANDLE_EXPIRED", message: "Lookup handle has expired" };
  }
  // Context Binding Check
  if (entry.contextType !== contextType || String(entry.contextId) !== String(contextId)) {
    return { error: "HANDLE_CONTEXT_MISMATCH", message: "Lookup handle context mismatch" };
  }

  const candidate = entry.candidates.find(c => c.candidateId === candidateId);
  if (!candidate) {
    return { error: "INVALID_CANDIDATE_ID", message: "Candidate ID not found in lookup session" };
  }

  return { success: true, candidate, entry };
}

/**
 * Atomically resolves candidate and marks lookupHandle consumed (race-safe)
 */
export function consumeLookupCandidate(handle, candidateId, contextType, contextId) {
  const res = resolveLookupCandidate(handle, candidateId, contextType, contextId);
  if (res.error) return res;
  res.entry.consumed = true;
  return res;
}

export function consumeLookupHandle(handle) {
  const entry = lookupHandles.get(handle);
  if (entry) {
    entry.consumed = true;
  }
}

// --------------------------------------------------------------------------
// 5. Registration Handles (5-min TTL, single use, context-bound)
// --------------------------------------------------------------------------
export function createRegistrationHandle(contextType, contextId, patientUid) {
  const handle = `rh_${crypto.randomBytes(24).toString("hex")}`;
  const now = Date.now();
  registrationHandles.set(handle, {
    contextType, // "DEVICE" or "USER"
    contextId,   // deviceId or userId
    patientUid,
    createdAt: now,
    expiresAt: now + HANDLE_TTL_MS,
    consumed: false
  });
  return handle;
}

export function consumeRegistrationHandle(handle, contextType, contextId) {
  if (!handle) {
    return { error: "HANDLE_REQUIRED", message: "Registration handle is required" };
  }
  const entry = registrationHandles.get(handle);
  if (!entry) {
    return { error: "HANDLE_EXPIRED", message: "Registration handle not found or expired" };
  }
  if (entry.consumed) {
    return { error: "HANDLE_ALREADY_CONSUMED", message: "Registration handle has already been consumed" };
  }
  if (Date.now() > entry.expiresAt) {
    registrationHandles.delete(handle);
    return { error: "HANDLE_EXPIRED", message: "Registration handle has expired" };
  }
  // Context Binding Check
  if (entry.contextType !== contextType || String(entry.contextId) !== String(contextId)) {
    return { error: "HANDLE_CONTEXT_MISMATCH", message: "Registration handle context mismatch" };
  }

  entry.consumed = true;
  return { success: true, patientUid: entry.patientUid };
}
