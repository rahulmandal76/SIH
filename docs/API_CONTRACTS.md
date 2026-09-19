# API Contracts & Service Specifications

## 1. Node.js API Gateway Endpoints (`http://localhost:5000`)

### Error Response Shape (All Endpoints)
All error responses from Phase 3 onward use a consistent structured envelope:
```json
{
  "error": {
    "code":      "ERROR_CODE",
    "message":   "Human-readable description",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "issues":    []
  }
}
```
**Error Codes**:
| Code | HTTP Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request schema invalid (Zod) |
| `HANDLE_REQUIRED` | 400 | Encounter creation missing valid handle or submitted raw patientUid |
| `INVALID_CANDIDATE_ID` | 400 | Candidate ID not found in lookup session cache |
| `ADMIN_ACCESS_REASON_REQUIRED` | 400 | Administrator access missing mandatory `X-Admin-Access-Reason` header |
| `AUTHENTICATION_REQUIRED` | 401 | Missing or invalid session cookie (`ms_user_session`, `ms_device_session`, `ms_encounter_session`) |
| `FORBIDDEN` | 403 | Generic authorization failure |
| `CLINICAL_ACCESS_DENIED` | 403 | Doctor unassigned, no active CareRelationship, or unauthorized patient scope |
| `LONGITUDINAL_ACCESS_DENIED` | 403 | Doctor has no active, non-expired CareRelationship or assigned encounter |
| `CHAMBER_ROUTING_REQUIRED` | 403 | Encounter has no chamber assignment — clinical staff must route it before a doctor can claim |
| `CHAMBER_MISMATCH` | 403 | Encounter's chamber does not match the claiming doctor's assigned chamber |
| `HANDLE_EXPIRED` | 403 | Handle lifetime exceeded 5-minute TTL |
| `HANDLE_CONTEXT_MISMATCH` | 403 | Handle presented from wrong device or wrong authenticated user (canonical code) |
| `CSRF_VIOLATION` | 403 | Missing custom header `X-Requested-With` or invalid Origin/Referer on mutating endpoint |
| `CARE_RELATIONSHIP_NOT_FOUND` | 404 | No CareRelationship found for the given numeric id |
| `PATIENT_NOT_FOUND` | 404 | Token, encounter, or UID not found in DB |
| `HANDLE_ALREADY_CONSUMED` | 409 | Replay attack: single-use handle has already been redeemed |
| `ENCOUNTER_ALREADY_CLAIMED` | 409 | Race condition: encounter was already claimed by another clinician |
| `INVALID_LIFECYCLE_TRANSITION` | 409 | CareRelationship status transition not permitted (e.g. already ended) |
| `AI_PROVIDER_UNAVAILABLE` | 503 | All Gemini models failed |
| `AI_PROVIDER_RATE_LIMITED` | 429 | Gemini or gateway rate limit |
| `AI_PROVIDER_TIMEOUT` | 504 | Gemini call exceeded 5.5 s |
| `NOT_IMPLEMENTED` | 501 | Endpoint is a documented stub |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

### 1.1 `GET /api/health`
- **Purpose**: Database connectivity and platform liveness check.
- **Required Session**: None (Public liveness probe).
- **CSRF Requirements**: Safe `GET` method.
- **Response Headers**: `X-Request-Id: <uuid>`
- **Response `200 OK`**:
```json
{
  "status":     "healthy",
  "database":   "connected",
  "provider":   "sqlite",
  "patients":   14,
  "encounters": 14,
  "time":       "2026-09-19T06:00:00.000Z"
}
```

---

### 1.2 `GET /api/queue`
- **Purpose**: Fetch active OPD queue.
- **Required Session**: Active `ms_user_session` with role `doctor`, `clinical_staff`, or `admin`.
- **CSRF Requirements**: Safe `GET` method. Validates Origin/Referer against allowed origins.
- **User Identifier Contract**: Returns `userUid` (UUID string) as public identifier.
- **Response Headers**: `X-Request-Id: <uuid>`
- **Response `200 OK`**:
```json
{
  "success": true,
  "queue": [
    {
      "token":              "105",
      "encounterId":        "ENC-2026-0105",
      "patientId":          "PAT-2026-0001",
      "name":               "Ramesh Sharma",
      "age":                48,
      "gender":             "Male",
      "chiefComplaint":     "Chest discomfort with restlessness",
      "priority":           "High Priority",
      "triageReason":       "Acute Chest Pain detected",
      "consultationStatus": "waiting",
      "chamber":            "CHAMBER-01",
      "createdAt":          "2026-09-19T10:14:00Z"
    }
  ]
}
```

---

### 1.3 `POST /api/intake` (DEPRECATED - Legacy Kiosk Intake)
- **Status**: **DEPRECATED** for Phase 4+. Retained temporarily for backward compatibility with Phase 3 kiosk frontend. Frontend must migrate to the decomposed two-step flow (`POST /api/patients` → `registrationHandle` → `POST /api/encounters`).
- **Required Session**: Active `ms_device_session` cookie (trusted `deviceId`). Unauthenticated kiosk requests rejected with `401 AUTHENTICATION_REQUIRED`.
- **Security & Identity Boundary Invariants**:
  - **Deterministic Patient UID Rejection**: Submitting a client-supplied `patientUid` is strictly prohibited and explicitly rejected with **`400 BAD_REQUEST (HANDLE_REQUIRED)`**. The server NEVER silently strips or ignores client identity fields. New intake records dynamically generate canonical server-side identities; existing patients must use the Phase 4 handle flow (`/api/patients/lookup` → `/api/encounters`).
  - Internally enforces identical Phase 4 canonical identity rules: treats `mobileNumber` as non-unique, creates immutable `patientUid` (UUID) and `patientId` (`PAT-YYYY-NNNN`), assigns default `abhaStatus: "not_configured"`, and generates the canonical `Encounter`.
  - Does NOT bypass audit logging or session isolation.
  - Issues `Set-Cookie: ms_encounter_session=...; HttpOnly; SameSite=Lax (dev) / Strict (prod); Path=/; Max-Age=7200`.
  - **Does NOT return raw session token or raw patientUid in the JSON response** (eliminates credential leakage).
- **CSRF Requirements**: State-changing `POST`. Requires `X-Requested-With: XMLHttpRequest` and Origin/Referer check.
- **Request Body**:
```json
{
  "token":          "106",
  "name":           "Ramesh Sharma",
  "age":            48,
  "gender":         "Male",
  "mobileNumber":   "9876543210",
  "abhaId":         "91-8842-1092-4402",
  "chiefComplaint": "Severe headache for 3 days",
  "priority":       "Normal",
  "caseData": {
    "hpi":          "Patient reported headache with photophobia...",
    "currentMeds":  ["Tab. Paracetamol 650mg SOS"],
    "allergies":    ["NKDA"]
  },
  "conversation": []
}
```
- **Response `400`**: `{ "error": { "code": "HANDLE_REQUIRED", "message": "Client-supplied patientUid is strictly prohibited on legacy intake. Existing patients must use the Phase 4 lookup/encounter handle flow.", "requestId": "..." } }`
- **Response `200 OK`**:
```json
{
  "success": true,
  "patient": {
    "token":              "106",
    "encounterId":        "ENC-2026-0106",
    "patientId":          "PAT-2026-0001",
    "name":               "Ramesh Sharma",
    "age":                48,
    "gender":             "Male",
    "chiefComplaint":     "Severe headache for 3 days",
    "priority":           "Normal",
    "consultationStatus": "waiting",
    "createdAt":          "2026-09-19T12:00:00Z"
  }
}
```

---

### 1.4 `GET /api/patient/:token` (Secured Token Route)
- **Purpose**: Fetch encounter details and patient clinical summary by OPD token number.
- **Required Session Namespace**:
  - **Clinician/Staff**: Requires active `ms_user_session` cookie (`doctor`, `clinical_staff`, `admin`).
  - **Patient**: Requires active `ms_encounter_session` cookie matching the requested encounter token.
  - Unauthenticated requests rejected with **`401 AUTHENTICATION_REQUIRED`**.
- **CSRF Requirements**: Safe `GET` method. Validates Origin/Referer against allowed origins for cross-origin requests.
- **Authorization Boundary**:
  1. **Doctor Access (Current vs Longitudinal vs Queue)**:
     - **Full Clinical Access** requires explicit assignment (`Encounter.assignedDoctorId === req.user.id`) OR an active longitudinal `CareRelationship`.
     - **Queue Visibility Boundary**: An unclaimed encounter sitting in a doctor's OPD chamber queue provides **Queue Visibility** via `GET /api/queue` (minimal triage metadata), but does **NOT** grant full clinical record access (`GET /api/patient/:token`).
     - **Authorization Transition**: Unassigned doctors attempting to access full clinical encounter details receive **`403 FORBIDDEN (CLINICAL_ACCESS_DENIED)`**. They must first explicitly claim the encounter (`PUT /api/encounters/:id/claim`), which sets `assignedDoctorId = req.user.id`, sets `consultationStatus = 'in_progress'`, establishes the `ATTENDING_OPD` `CareRelationship`, and unlocks full clinical record access.
  2. **Clinical Staff Access**: Permitted to view encounter triage and queue metadata for queue coordination and vital signs capture, but cannot view or edit doctor consultation notes.
  3. **Patient Self-Access**: Permitted if `ms_encounter_session` token matches `:token`.
  4. **Administrative Access**: Admin role (`role === "admin"`). **MANDATORY**: Requires canonical request header `X-Admin-Access-Reason: <reason>`. Query parameter justification is strictly prohibited to prevent clinical justifications from appearing in browser history, proxy logs, or web server access logs.
     - Header value must be a non-empty, trimmed string (5–500 characters).
     - Missing, empty, or whitespace-only header returns **`400 BAD_REQUEST (ADMIN_ACCESS_REASON_REQUIRED)`**.
     - Server sets `actorUserId` strictly from authenticated session `req.user.id` (never accepted from client).
     - Logs `AuditLog` entry with `actorType: "USER"`, `actorUserId: req.user.id`, `action: "ADMIN_ENCOUNTER_VIEW"`, `patientUid: encounter.patientUid`, `resourceType: "Encounter"`, `resourceId: token`, and `metadataJson: { "accessReason": req.headers["x-admin-access-reason"] }` (no duplicate resource identifiers inside `metadataJson`).
  - Unauthorized callers rejected with **`403 FORBIDDEN (CLINICAL_ACCESS_DENIED)`**.
- **Response Privacy**: Returns clinical encounter details without exposing internal server secrets, password hashes, or unrelated patient records.
- **Response `200 OK`**:
```json
{
  "success": true,
  "patient": {
    "token":              "105",
    "encounterId":        "ENC-2026-0105",
    "patientId":          "PAT-2026-0001",
    "name":               "Ramesh Sharma",
    "age":                48,
    "gender":             "Male",
    "mobileNumber":       "9876543210",
    "chiefComplaint":     "Chest discomfort with restlessness",
    "priority":           "High Priority",
    "consultationStatus": "waiting",
    "chamber":            "CHAMBER-01",
    "caseData": {
      "hpi":              "Patient reported headache with photophobia...",
      "currentMeds":      ["Tab. Paracetamol 650mg SOS"],
      "allergies":        ["NKDA"]
    }
  }
}
```
- **Response `400`**: `{ "error": { "code": "ADMIN_ACCESS_REASON_REQUIRED", "message": "Admin access requires a valid X-Admin-Access-Reason header", "requestId": "..." } }`
- **Response `401`**: `{ "error": { "code": "AUTHENTICATION_REQUIRED", "message": "Active clinician or encounter session required", "requestId": "..." } }`
- **Response `403`**: `{ "error": { "code": "CLINICAL_ACCESS_DENIED", "message": "Clinical access denied. Active doctor assignment, active CareRelationship, or valid X-Admin-Access-Reason required.", "requestId": "..." } }`
- **Response `404`**: `{ "error": { "code": "PATIENT_NOT_FOUND", "message": "No encounter found matching token 105", "requestId": "..." } }`

---

### 1.5 `PUT /api/patient/:token/complete` (Secured Doctor Consultation Route)
- **Purpose**: Doctor completes consultation, records clinical notes, and finalizes encounter.
- **Required Session Namespace**: Requires active `ms_user_session` cookie with role `doctor` or `admin`.
- **CSRF Requirements**: State-changing `PUT` method using cookie auth. **MANDATORY**: Requires custom header `X-Requested-With: XMLHttpRequest` and validates request Origin/Referer against allowed frontend origins.
- **Authorization Boundary & Assignment Rule**:
  - Strictly requires that the calling doctor is assigned to this encounter (`Encounter.assignedDoctorId === req.user.id`).
  - Admin role (`role === "admin"`) is permitted for administrative overrides.
  - Unassigned doctors attempting completion receive **`403 FORBIDDEN (CLINICAL_ASSIGNMENT_REQUIRED)`**.
- **Audit Attribution & CareRelationship**:
  - Automatically writes `AuditLog` entry with `actorType: USER`, `actorUserId: req.user.id`, `action: COMPLETE_CONSULTATION`.
  - Updates `Encounter.consultationStatus = 'completed'` and `Encounter.completedAt = new Date()`.
  - **CareRelationship Expiry Finalization**: Any active `ATTENDING_OPD` `CareRelationship` has its `expiresAt` finalized to `completedAt + 24 hours` at this moment (does not assign 24h expiration at initial claim time). Preserves a 24h longitudinal access window for review.
- **Request Body**:
```json
{
  "consultationStatus": "completed",
  "doctorNotes":        "BP controlled. Advise review in 2 weeks."
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "encounter": {
    "token":              "105",
    "encounterId":        "ENC-2026-0105",
    "consultationStatus": "completed",
    "doctorNotes":        "BP controlled. Advise review in 2 weeks.",
    "completedAt":        "2026-09-19T14:30:00Z"
  }
}
```
- **Response `401`**: `{ "error": { "code": "AUTHENTICATION_REQUIRED", "message": "Doctor or admin user session required", "requestId": "..." } }`
- **Response `403`**: `{ "error": { "code": "CLINICAL_ASSIGNMENT_REQUIRED", "message": "Only the assigned doctor or admin may complete this encounter", "requestId": "..." } }`

---

### 1.6 `POST /api/ai/intake-question` (Phase 3.1 Security Patch)
- **Purpose**: Secure backend proxy for Gemini clinical intake question generation.

> [!NOTE]
> **Phase 3.1 AI Intake Compatibility Contract**:
> The `patientUid` / `X-Kiosk-Session` authorization behavior on this endpoint is a legacy Phase 3.1 security compatibility contract:
> - **No Arbitrary Patient Access**: The endpoint strictly verifies that the presented `X-Kiosk-Session` (or `ms_encounter_session`) matches the requested `patientUid`. Unauthenticated requests or cross-patient tokens are rejected with `401 AUTHENTICATION_REQUIRED` or `403 FORBIDDEN (PATIENT_SCOPE_MISMATCH)`.
> - **Scoped Context**: Access remains strictly scoped to the server-authorized kiosk/encounter intake session.
> - **No Privilege Expansion in Phase 4**: Phase 4 does NOT expand this endpoint's privileges, does not grant longitudinal patient access, and does not alter this Phase 3.1 proxy contract.
- **Security**: `GEMINI_API_KEY` is a server-side-only secret. Never exposed to browser.
- **Rate Limit**: 30 requests per 10-minute window per terminal IP.
- **Request Headers**:
  - `X-Request-Id`: Optional client request ID (server assigns UUID v4 if omitted)
  - `X-Kiosk-Session`: **REQUIRED if `patientUid` is provided**. Ephemeral session token returned by `POST /api/intake` authorizing access to that specific patient.
- **Response Headers**: `X-Request-Id: <uuid>`
- **Request Body (Zod-validated)**:
```json
{
  "patientMessage":      "Mera pet mein dard hai",
  "conversationHistory": [
    { "sender": "ai",      "text": "Aapko kya takleef hai?" },
    { "sender": "patient", "text": "Bukhar hai" }
  ],
  "stepIndex":     1,
  "language":      "Hindi",
  "patientAge":    45,
  "patientGender": "Male",
  "patientUid":    "c7b2e910-1a84-4e2b-9e41-692147819382"
}
```
- **Response `200 OK` (Gemini succeeded)**:
```json
{
  "success": true,
  "text":    "Pet mein dard kaahan zyada hai — upar chhati ke paas, naabhi ke paas, ya neeche?",
  "options": ["Upar pet mein", "Naabhi ke paas", "Neeche pet mein", "Ulti bhi hai"],
  "model":   "gemini-2.0-flash-lite",
  "source":  "gemini"
}
```

---

### 1.7 `POST /api/rag/query` (501 — Phase 3 Stub)
- **Status**: NOT_IMPLEMENTED — Phase 5 target.
- **Purpose (future)**: Doctor queries the internal Python FastAPI RAG service via Node proxy.
- **Security contract**: Browser must NEVER directly contact the RAG service.
- **Response `501`**:
```json
{ "error": { "code": "NOT_IMPLEMENTED", "message": "RAG service integration is scheduled for Phase 5. The Node API will proxy this request to the internal Python FastAPI RAG service. The browser must not contact the RAG service directly.", "requestId": "..." } }
```

---

### 1.8 `POST /api/patients/lookup` (Phase 4 Privacy-Preserving Lookup)
- **Purpose**: Search for existing patient records using normalized mobile number or ABHA ID.
- **Required Session Namespace**:
  - **Kiosk Mode**: Requires active `ms_device_session` cookie (trusted `deviceId`).
  - **Clinician Mode**: Requires active `ms_user_session` cookie with role `doctor`, `clinical_staff`, or `admin`.
  - Unauthenticated calls rejected with **`401 AUTHENTICATION_REQUIRED`**.
- **CSRF Requirements**: State-changing `POST` method using cookie auth. Requires `X-Requested-With: XMLHttpRequest` and Origin/Referer verification against allowed frontend origins.
- **Anti-Enumeration & Response Privacy Contract**:
  - **`patientUid` and `patientId` are NEVER returned in the lookup response**.
  - Omitting `patientId` from lookup output prevents enumeration of internal hospital record sequence numbers at untrusted terminals.
  - Returns minimal candidate preview array: `candidateId`, `maskedName` (`"R**** K****"`), `maskedMobile` (`"******3210"`), `age`, `gender`.
  - **Zero clinical exposure**: Medical history, past visits, diagnoses, medications, allergies, encounter IDs, and clinical documents are strictly omitted.
- **Handle Lifecycle & Binding**:
  - Generates a cryptographically random, short-lived (5 min TTL), single-use `lookupHandle`.
  - **Device-Bound (Kiosk Mode)**: `lookupHandle` is cryptographically bound to the caller's `deviceId` (`ms_device_session`).
  - **User-Bound (Clinician Mode)**: `lookupHandle` is cryptographically bound to the clinician's `User.id` (`ms_user_session`).
  - `candidateId` (e.g. `"cand_1"`) is an ephemeral, server-mapped opaque identifier resolved internally against the server-side lookup cache.
- **Throttling**: Rate-limited (10 requests per minute per IP/device with progressive backoff).
- **Request Body**:
```json
{
  "mobileNumber": "9876543210"
}
```
*or*
```json
{
  "abhaNumber": "91-8842-1092-4402"
}
```
- **Response `200 OK` (Candidates Found)**:
```json
{
  "found": true,
  "lookupHandle": "lh_8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c",
  "candidates": [
    {
      "candidateId":  "cand_1",
      "maskedName":   "R**** K****",
      "maskedMobile": "******3210",
      "age":          48,
      "gender":       "Male"
    },
    {
      "candidateId":  "cand_2",
      "maskedName":   "P**** K****",
      "maskedMobile": "******3210",
      "age":          16,
      "gender":       "Female"
    }
  ],
  "allowNewRegistration": true
}
```
- **Response `200 OK` (No Candidates Found)**:
```json
{
  "found": false,
  "candidates": [],
  "message": "No existing record found for this identifier",
  "allowNewRegistration": true
}
```

---

### 1.9 `POST /api/patients` (Phase 4 Dynamic Patient Registration)
- **Purpose**: Register a new canonical patient record in the hospital database.
- **Required Session Namespace**:
  - Requires active `ms_device_session` (kiosk `deviceId`), OR
  - Requires active `ms_user_session` with role `kiosk_operator`, `clinical_staff`, `doctor`, `admin`.
  - Unauthenticated requests rejected with **`401 AUTHENTICATION_REQUIRED`**.
- **CSRF Requirements**: State-changing `POST` method using cookie auth. Requires `X-Requested-With: XMLHttpRequest` and Origin/Referer verification.
- **Identity & Uniqueness Rule**:
  - `mobileNumber` is **non-unique** (allows multiple family members to share phone numbers).
  - Creates an immutable `patientUid` (UUID) and human-readable `patientId` (`PAT-YYYY-NNNN`).
- **Registration Handle Invariants**:
  - Generates a single-use, 5-minute TTL `registrationHandle`.
  - If created via `ms_device_session`: `registrationHandle` is cryptographically bound to `deviceId`.
  - If created via `ms_user_session`: `registrationHandle` is cryptographically bound to authenticated `User.id`.
  - Replay or cross-session redemption is rejected.
- **Request Body**:
```json
{
  "fullName":     "Priya Sharma",
  "age":          28,
  "gender":       "Female",
  "mobileNumber": "9876543210",
  "abhaNumber":   "91-4829-1029-4821",
  "abhaAddress":  "priya@abdm"
}
```
- **Response `201 Created`**:
```json
{
  "success": true,
  "registrationHandle": "rh_9a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "patient": {
    "patientId":    "PAT-2026-0017",
    "fullName":     "Priya Sharma",
    "age":          28,
    "gender":       "Female",
    "mobileNumber": "9876543210",
    "abhaNumber":   "91-4829-1029-4821",
    "abhaAddress":  "priya@abdm",
    "abhaStatus":   "not_configured",
    "abhaVerified": false
  }
}
```
> Note: Raw immutable `patientUid` is NOT leaked in the response. Allowed `abhaStatus` values: `not_configured`, `entered`, `lookup_pending`, `verified`, `verification_failed`, `unavailable`. In Phase 4, set to `not_configured` (or `entered` if provided), with `abhaVerified: false`.

---

### 1.10 `POST /api/encounters` (Phase 4 Dynamic Encounter Creation)
- **Purpose**: Create a new clinical OPD encounter for either an existing candidate patient (via `lookupHandle` + `candidateId`) or a freshly registered patient (via `registrationHandle`).
- **Required Session Namespace**:
  - **Kiosk Mode**: Requires active `ms_device_session` cookie. Sets `ms_encounter_session`.
  - **Clinician/Staff Mode**: Requires active `ms_user_session` cookie. Sets `ms_encounter_session`.
  - Unauthenticated requests rejected with **`401 AUTHENTICATION_REQUIRED`**.
- **CSRF Requirements**: State-changing `POST` method using cookie auth. Requires `X-Requested-With: XMLHttpRequest` and Origin/Referer verification.
- **Security & Binding Invariants**:
  - **Submitting an arbitrary `patientUid` is strictly prohibited and rejected with `400 BAD_REQUEST (HANDLE_REQUIRED)`**.
  - Encounters can ONLY be created via a valid, unconsumed server-issued handle.
  - Server resolves `candidateId` -> `patientUid` from the server-side lookup session cache. If `candidateId` is missing/invalid, returns **`400 BAD_REQUEST (INVALID_CANDIDATE_ID)`**.
  - Handle context verification:
    - If device-bound: caller's `ms_device_session` (`deviceId`) must match the device that created the handle.
    - If staff-bound: caller's `ms_user_session` (`User.id`) must match the user who created the handle.
    - Wrong device/user context fails with **`403 FORBIDDEN (HANDLE_CONTEXT_MISMATCH)`**.
  - Single-use enforcement: Replay of an already consumed handle fails with **`409 CONFLICT (HANDLE_ALREADY_CONSUMED)`**.
  - Lifetime enforcement: Expired handle (>5 min) fails with **`403 FORBIDDEN (HANDLE_EXPIRED)`**.
- **Cookie & Response Fields**:
  - Sets `Set-Cookie: ms_encounter_session=...; HttpOnly; SameSite=Lax (dev) / Strict (prod); Path=/; Max-Age=7200`.
  - Raw session token and raw `patientUid` are **NOT returned in JSON response**.
- **Request Body (Existing Candidate Selection via `lookupHandle`)**:
```json
{
  "lookupHandle":   "lh_8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c",
  "candidateId":    "cand_1",
  "chiefComplaint": "Fever with cough for 4 days",
  "priority":       "Normal"
}
```
*or (Freshly Registered Patient via `registrationHandle`)*:
```json
{
  "registrationHandle": "rh_9a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "chiefComplaint":     "Fever with cough for 4 days",
  "priority":           "Normal"
}
```
- **Response `201 Created`**:
```json
{
  "success": true,
  "encounter": {
    "encounterId":        "ENC-2026-0107",
    "tokenNumber":        "107",
    "priority":           "Normal",
    "consultationStatus": "waiting",
    "chiefComplaint":     "Fever with cough for 4 days",
    "createdAt":          "2026-09-19T13:20:00Z"
  }
}
```

---

### 1.11 `POST /api/auth/login` (Phase 4 Doctor/Staff Authentication)
- **Purpose**: Authenticate clinical and administrative staff using email and password.
- **Required Session**: None (Public authentication endpoint).
- **CSRF Requirements**: Public login endpoint is exempt from custom CSRF header check, but enforces Origin/Referer verification against allowed frontend origins.
- **Throttling**: `authRateLimiter` enforces max 5 failed attempts per 15-minute window per IP / account.
- **Security Contract**:
  - Validates credentials using asynchronous, non-blocking `crypto.scrypt(password, salt, 64)`.
  - Constant-time comparison (`crypto.timingSafeEqual`) prevents timing leak attacks.
  - Password hashes, salts, and raw session tokens are **NEVER returned in HTTP response or logged**.
  - Issues `Set-Cookie: ms_user_session=...; HttpOnly; SameSite=Lax (dev) / Strict (prod); Path=/; Max-Age=28800`.
  - **User API Identifier Contract**: Returns `userUid` (UUID string) as the public client identifier. Internal numeric `User.id` is strictly reserved for database relations and audit attribution and is not exposed to the client.
- **Request Body**:
```json
{
  "email":    "dr.sharma@medsync.local",
  "password": "SecurePassword123!"
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "user": {
    "userUid":    "00000000-0000-0000-0000-000000000002",
    "email":      "dr.sharma@medsync.local",
    "name":       "Dr. Sharma",
    "role":       "doctor",
    "department": "General Medicine",
    "chamber":    "CHAMBER-01"
  }
}
```
- **Response `401`**: `{ "error": { "code": "AUTHENTICATION_REQUIRED", "message": "Invalid email or password", "requestId": "..." } }`

---

### 1.12 `POST /api/auth/logout` (Session Invalidation)
- **Purpose**: Invalidate authenticated user session and clear client session cookie.
- **Required Session Namespace**: Requires active `ms_user_session`.
- **Namespace Boundary**: Destroys `ms_user_session` ONLY. Does NOT destroy kiosk device session (`ms_device_session`) or patient intake session (`ms_encounter_session`).
- **CSRF Requirements**: State-changing `POST` method using cookie auth. Requires `X-Requested-With: XMLHttpRequest` and Origin/Referer verification.
- **Response Headers**: `Set-Cookie: ms_user_session=; Path=/; HttpOnly; SameSite=Lax / Strict; Max-Age=0`
- **Response `200 OK`**:
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

### 1.13 `GET /api/auth/session` (Phase 4 Session Probe)
- **Purpose**: Retrieve current authenticated actor profile and session permissions.
- **Required Session Namespace**: Requires active `ms_user_session`.
- **CSRF Requirements**: Safe `GET` method. Validates Origin/Referer against allowed origins.
- **Response `200 OK`**:
```json
{
  "authenticated": true,
  "user": {
    "userUid":    "00000000-0000-0000-0000-000000000002",
    "email":      "dr.sharma@medsync.local",
    "name":       "Dr. Sharma",
    "role":       "doctor",
    "department": "General Medicine",
    "chamber":    "CHAMBER-01"
  }
}
```
- **Response `401 Unauthorized`**:
```json
{
  "authenticated": false,
  "error": {
    "code":      "AUTHENTICATION_REQUIRED",
    "message":   "No active user session found",
    "requestId": "..."
  }
}
```

---

### 1.14 `GET /api/patients/:patientUid` (Phase 4 Protected Clinical Access)
- **Purpose**: Retrieve full clinical patient record.
- **Required Session Namespace**:
  - Clinician/Admin: Requires active `ms_user_session`.
  - Patient: Requires active `ms_encounter_session`.
  - Unauthenticated requests rejected with **`401 AUTHENTICATION_REQUIRED`**.
- **CSRF Requirements**: Safe `GET` method. Validates Origin/Referer against allowed origins.
- **Authorization Enforcement (Three-Tier Clinical Model)**:
  1. **Current Encounter Access**: Doctor currently assigned (`Encounter.assignedDoctorId === req.user.id`).
  2. **Longitudinal Access**: Doctor authorized via active `CareRelationship` (`PRIMARY_PHYSICIAN`, `SPECIALIST_REFERRAL`, or active `ATTENDING_OPD` within 24 hours of consultation completion).
  3. **Patient Self-Access**: Patient with active `ms_encounter_session` matching `session.patientUid === req.params.patientUid`.
  4. **Administrative Access**: Admin role (`role === "admin"`). **MANDATORY**: Requires canonical request header `X-Admin-Access-Reason: <reason>`. Query parameter justification is strictly prohibited to prevent access reason leakage into access logs.
     - Header value must be non-empty, trimmed string (5–500 characters).
     - Missing, empty, or whitespace-only header returns **`400 BAD_REQUEST (ADMIN_ACCESS_REASON_REQUIRED)`**.
     - Server sets `actorUserId` strictly from authenticated session `req.user.id` (never from client).
     - Logs `AuditLog` entry with `actorType: "USER"`, `actorUserId: req.user.id`, `action: "ADMIN_PATIENT_RECORD_VIEW"`, `patientUid: req.params.patientUid`, `resourceType: "Patient"`, `resourceId: req.params.patientUid`, and `metadataJson: { "accessReason": req.headers["x-admin-access-reason"] }` (no duplicate resource identifiers inside `metadataJson`).
  - Unassigned doctors or unauthorized callers receive **`403 FORBIDDEN (CLINICAL_ACCESS_DENIED)`**.
- **Response `200 OK`**:
```json
{
  "success": true,
  "patient": {
    "patientUid":   "c7b2e910-1a84-4e2b-9e41-692147819382",
    "patientId":    "PAT-2026-0001",
    "fullName":     "Ramesh Sharma",
    "age":          48,
    "gender":       "Male",
    "mobileNumber": "9876543210",
    "abhaNumber":   "91-8842-1092-4402",
    "abhaAddress":  "ramesh@abdm",
    "abhaStatus":   "not_configured",
    "abhaVerified": false,
    "encounters": [
      {
        "encounterId":        "ENC-2026-0105",
        "tokenNumber":        "105",
        "priority":           "High Priority",
        "consultationStatus": "completed",
        "doctorNotes":        "BP controlled. Advise review in 2 weeks.",
        "createdAt":          "2026-09-19T10:14:00Z"
      }
    ]
  }
}
```
- **Response `400`**: `{ "error": { "code": "ADMIN_ACCESS_REASON_REQUIRED", "message": "Admin access requires a valid X-Admin-Access-Reason header", "requestId": "..." } }`
- **Response `401`**: `{ "error": { "code": "AUTHENTICATION_REQUIRED", "message": "Active user or encounter session required", "requestId": "..." } }`
- **Response `403`**: `{ "error": { "code": "CLINICAL_ACCESS_DENIED", "message": "Clinical access denied. Assignment, CareRelationship, or valid X-Admin-Access-Reason required.", "requestId": "..." } }`
- **Response `404`**: `{ "error": { "code": "PATIENT_NOT_FOUND", "message": "Patient not found", "requestId": "..." } }`

---

### 1.15 `PUT /api/encounters/:id/claim` (Phase 4 Clinical Claim — Option B Chamber Rule)
- **Purpose**: Doctor atomically claims an unassigned, chamber-routed OPD encounter.
- **Required Session Namespace**: Requires active `ms_user_session` with role `doctor`.
- **CSRF Requirements**: State-changing `PUT` using cookie auth. Requires `X-Requested-With: XMLHttpRequest` and Origin/Referer verification.
- **Eligibility Rules (Option B — Implemented)**:
  - Eligible IF AND ONLY IF:
    1. `Encounter.consultationStatus === "waiting"`
    2. `Encounter.assignedDoctorId === null`
    3. `Encounter.chamber` is explicitly set (non-null)
    4. `Encounter.chamber === req.user.chamber` (or doctor has no chamber restriction)
  - **Option B: Null-chamber encounters are NOT claimable.** If `Encounter.chamber === null`, rejected immediately with **`403 CHAMBER_ROUTING_REQUIRED`**. Clinical staff must assign a chamber before any doctor can claim.
  - **Chamber Mismatch**: If encounter's chamber does not match the doctor's assigned chamber, rejected with **`403 CHAMBER_MISMATCH`**.
- **Race-Safe Atomic Claim**:
  - The conditional database `UPDATE WHERE { id, assignedDoctorId IS NULL, consultationStatus = 'waiting' }` is the **sole race guard**.
  - No outer pre-check is used as the claim gate; the outer `findFirst` is read-only for identity resolution only.
  - Prisma raises `P2025` when the row was already claimed by a concurrent claimant → caught as **`409 ENCOUNTER_ALREADY_CLAIMED`**.
  - All three operations — `encounter.update`, `careRelationship.create`, `auditLog.create` — execute inside a single `prisma.$transaction`. Either all succeed or all roll back.
- **Audit & CareRelationship**:
  - `AuditLog`: `actorType: "USER"`, `actorUserId: req.user.id`, `action: "CLAIM_ENCOUNTER"`, `resourceType: "Encounter"`, `resourceId: encounter.encounterId`.
  - `CareRelationship` auto-created: `relationshipType: "ATTENDING_OPD"`, `status: "active"`, `expiresAt: null`. Expiry (`completedAt + 24h`) is set upon consultation completion only.
- **Response `200 OK`**:
```json
{
  "success": true,
  "encounter": {
    "encounterId":        "ENC-2026-0107",
    "assignedDoctorId":   1,
    "consultationStatus": "in_progress"
  }
}
```
- **Response `401`**: `{ "error": { "code": "AUTHENTICATION_REQUIRED", ... } }`
- **Response `403 (null chamber)`**: `{ "error": { "code": "CHAMBER_ROUTING_REQUIRED", "message": "Encounter has not been routed to a chamber. Clinical staff must assign a chamber before a doctor can claim.", ... } }`
- **Response `403 (wrong chamber)`**: `{ "error": { "code": "CHAMBER_MISMATCH", "message": "Encounter is in OPD Chamber #04; doctor assigned to OPD Chamber #02", ... } }`
- **Response `409`**: `{ "error": { "code": "ENCOUNTER_ALREADY_CLAIMED", ... } }`

---

### 1.16 `POST /api/care-relationships` (Phase 4 Manual CareRelationship Creation)
- **Purpose**: Doctor or admin manually creates a `PRIMARY_PHYSICIAN` or `SPECIALIST_REFERRAL` CareRelationship. `ATTENDING_OPD` is created automatically on encounter claim and **cannot** be created through this route.
- **Required Session Namespace**: Requires active `ms_user_session` with role `doctor` or `admin`.
- **CSRF Requirements**: State-changing `POST` using cookie auth. Requires `X-Requested-With: XMLHttpRequest` and Origin/Referer verification.
- **Authorization**:
  - **Doctor Flow**: Doctor creates a relationship for themselves. The server derives receiving `doctorId` strictly from authenticated `req.user.id`. Submitting an arbitrary or foreign `doctorId` is rejected with `403 FORBIDDEN`.
  - **Admin Flow**: Administrator may explicitly assign a relationship to another doctor (`doctorId` in body). The target doctor is validated server-side (must exist with `role: "doctor"`, otherwise `400 VALIDATION_ERROR`).
  - `assignedByUserId` and `actorUserId` for audit are **always** sourced from authenticated `req.user.id`. Clients may never supply actor identity.
- **Request Body**:
```json
{
  "patientUid":       "c7b2e910-1a84-4e2b-9e41-692147819382",
  "relationshipType": "PRIMARY_PHYSICIAN",
  "doctorId":         1,
  "notes":            "Established longitudinal relationship for hypertension management"
}
```
- `relationshipType` must be `PRIMARY_PHYSICIAN` or `SPECIALIST_REFERRAL`. Any other value returns `400 VALIDATION_ERROR`.
- `doctorId` is optional for doctors (defaults to `req.user.id`; foreign doctorId rejected with `403`), and required for admins (validated against active clinicians).
- **Response `201 Created`**:
```json
{
  "success": true,
  "careRelationship": {
    "id":               15,
    "patientUid":       "c7b2e910-1a84-4e2b-9e41-692147819382",
    "doctorId":         1,
    "relationshipType": "PRIMARY_PHYSICIAN",
    "status":           "active",
    "createdAt":        "2026-09-19T12:00:00.000Z"
  }
}
```
- **Audit**: `actorType: "USER"`, `actorUserId: req.user.id`, `action: "CREATE_CARE_RELATIONSHIP"`, `metadata: { relationshipType, targetDoctorId }`.
- **Response `400`**: `{ "error": { "code": "VALIDATION_ERROR", ... } }` — invalid/missing fields or invalid target doctor.
- **Response `403`**: `{ "error": { "code": "FORBIDDEN", ... } }` — non-doctor/non-admin caller, or doctor attempting foreign doctor delegation.
- **Response `404`**: `{ "error": { "code": "PATIENT_NOT_FOUND", ... } }` — patientUid not found.

---

### 1.17 `PUT /api/care-relationships/:id/suspend` (Phase 4 CareRelationship Suspension)
- **Purpose**: Suspend an active CareRelationship. A suspended relationship does NOT grant longitudinal access.
- **Required Session Namespace**: Requires active `ms_user_session` with role `doctor` or `admin`.
- **CSRF Requirements**: State-changing `PUT` using cookie auth. Requires `X-Requested-With: XMLHttpRequest`.
- **Authorization**: Doctor may only suspend their own relationships (`careRel.doctorId === req.user.id`). Admin may suspend any.
- **Lifecycle Rule**: Only `status: "active"` relationships can be suspended. Attempting to suspend a `suspended` or `ended` relationship returns `409 INVALID_LIFECYCLE_TRANSITION`.
- **Request Body**: Empty / no body required.
- **Response `200 OK`**:
```json
{
  "success": true,
  "careRelationship": { "id": 15, "status": "suspended" }
}
```
- **Audit**: `actorType: "USER"`, `action: "SUSPEND_CARE_RELATIONSHIP"`, `resourceType: "CareRelationship"`, `resourceId: "15"`.
- **Response `404`**: `CARE_RELATIONSHIP_NOT_FOUND`.
- **Response `409`**: `INVALID_LIFECYCLE_TRANSITION`.

---

### 1.18 `PUT /api/care-relationships/:id/end` (Phase 4 CareRelationship Termination)
- **Purpose**: Explicitly terminate a CareRelationship. Sets `status = "ended"` and `endedAt = now()`. An ended relationship does NOT grant longitudinal access.
- **Required Session Namespace**: Requires active `ms_user_session` with role `doctor` or `admin`.
- **CSRF Requirements**: State-changing `PUT` using cookie auth. Requires `X-Requested-With: XMLHttpRequest`.
- **Authorization**: Doctor may only end their own relationships. Admin may end any.
- **Lifecycle Rule**: A relationship that is already `ended` returns `409 INVALID_LIFECYCLE_TRANSITION`. Active and suspended relationships can both be ended.
- **Request Body**: Empty / no body required.
- **Response `200 OK`**:
```json
{
  "success": true,
  "careRelationship": {
    "id":      15,
    "status":  "ended",
    "endedAt": "2026-09-19T14:30:00.000Z"
  }
}
```
- **Audit**: `actorType: "USER"`, `action: "END_CARE_RELATIONSHIP"`, `resourceType: "CareRelationship"`, `resourceId: "15"`.
- **Response `404`**: `CARE_RELATIONSHIP_NOT_FOUND`.
- **Response `409`**: `INVALID_LIFECYCLE_TRANSITION`.

---

## 2. Authorization Matrix (Phase 4 Model)

| Route | Method | `doctor` | `clinical_staff` | `admin` | `kiosk_operator` | `patient` (Intake Session) | Session Cookie Used | CSRF Header Required | Enforcement Mechanism |
|---|---|---|---|---|---|---|---|---|---|
| `/api/auth/login` | POST | Yes | Yes | Yes | Yes | No | None → sets `ms_user_session` | No (CORS check) | Public; `authRateLimiter` (5 attempts/15 min) |
| `/api/auth/logout` | POST | Yes | Yes | Yes | Yes | No | `ms_user_session` | Yes (`X-Requested-With`) | CSRF validated; clears `ms_user_session` only |
| `/api/auth/session` | GET | Yes | Yes | Yes | Yes | No | `ms_user_session` | No (Safe GET) | Validates active clinician/staff cookie session; returns userUid |
| `/api/health` | GET | Yes | Yes | Yes | Yes | Yes | None | No (Safe GET) | Public liveness probe |
| `/api/queue` | GET | Yes | Yes | Yes | No | No | `ms_user_session` | No (Safe GET) | Requires authenticated clinician role |
| `/api/patients/lookup` | POST | Clinician Mode | Clinician Mode | Clinician Mode | Kiosk Mode | Kiosk Mode | `ms_device_session` OR `ms_user_session` | Yes (`X-Requested-With`) | Rate limited (10/min); returns masked preview + bound `lookupHandle` |
| `/api/patients` | POST | Yes | Yes | Yes | Yes | No | `ms_device_session` OR `ms_user_session` | Yes (`X-Requested-With`) | CSRF validated; creates Patient + issues bound `registrationHandle` |
| `/api/encounters` | POST | Yes | Yes | Yes | Yes | No | `ms_device_session` OR `ms_user_session` | Yes (`X-Requested-With`) | Resolves bound handle; rejects raw patientUid; sets `ms_encounter_session` |
| `/api/encounters/:id/claim` | PUT | Yes | No | No | No | No | `ms_user_session` | Yes (`X-Requested-With`) | Option B: encounter.chamber must be non-null and match doctor's chamber. Atomic conditional update; P2025 = 409. Establishes ATTENDING_OPD CareRelationship |
| `/api/patients/:patientUid` | GET | Assigned Encounter OR Active CareRelationship (non-suspended, non-ended, non-expired) | Queue Coordination Only | With `X-Admin-Access-Reason` | No | Own UID | `ms_user_session` OR `ms_encounter_session` | No (Safe GET) | Suspended/ended/expired relationships denied |
| `/api/patient/:token` | GET | Assigned Doctor Only (Claim required) | Queue Triage Summary Only | With `X-Admin-Access-Reason` | No | Own Token | `ms_user_session` OR `ms_encounter_session` | No (Safe GET) | Enforces clinical assignment, queue role, or Admin header reason |
| `/api/patient/:token/complete` | PUT | Assigned Only | No | Yes | No | No | `ms_user_session` | Yes (`X-Requested-With`) | Assigned doctor or admin; sets completedAt & CareRelationship expiresAt=completedAt+24h |
| `/api/care-relationships` | POST | Yes | No | Yes | No | No | `ms_user_session` | Yes (`X-Requested-With`) | Creates PRIMARY_PHYSICIAN or SPECIALIST_REFERRAL; ATTENDING_OPD excluded from manual creation |
| `/api/care-relationships/:id/suspend` | PUT | Own only | No | Any | No | No | `ms_user_session` | Yes (`X-Requested-With`) | Only active → suspended; suspended rel denies longitudinal access |
| `/api/care-relationships/:id/end` | PUT | Own only | No | Any | No | No | `ms_user_session` | Yes (`X-Requested-With`) | Active or suspended → ended; endedAt set; ended rel denies longitudinal access |
| `/api/ai/intake-question` | POST | No | No | No | Scoped | Scoped | `ms_encounter_session` | Yes (`X-Requested-With`) | Ephemeral session token bound to target `patientUid` |
