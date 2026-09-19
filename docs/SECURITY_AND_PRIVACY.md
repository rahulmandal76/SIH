# Security, Privacy & Healthcare Compliance Specification

## 1. Threat Model & Security Architecture

The Unified Healthcare Intelligence Platform processes Protected Health Information (PHI) and sensitive clinical data. Security controls are enforced at every architectural layer:

```
[ Kiosk Client (Browser) ]
     │ No secrets, no API keys, sanitized inputs, AbortController timeouts
     ▼ HTTPS / TLS 1.3 (production)
[ API Gateway (Node.js/Express) ]  ← Phase 3.1 boundary established
     │ 1. RequestId + Structured Logging (no PHI/keys in logs)
     │ 2. Zod Payload Validation & Size Limits
     │ 3. Rate Limiting (30 req/10 min per terminal IP)
     │ 4. Patient-Scope Authorization (X-Kiosk-Session bound to patientUid; Phase 4: full User JWT)
     │ 5. AI Data Minimization DTO (name/phone/ABHA redacted before Gemini)
     │ 6. GEMINI_API_KEY server-side only (never in response or bundle)
     ├──────────────────────────────────────────────┐
     ▼ External (HTTPS)                             ▼ Internal
[ Google Gemini API ]                      [ PostgreSQL / SQLite DB ]
  Minimal clinical context only            Canonical Relational Records
  No name, phone, ABHA, Aadhaar            Audit Logs & Consent
  System prompt enforced server-side       Prisma driver adapter
     │
     ▼ (Phase 5 — internal only)
[ Python FastAPI RAG Service ]
  Isolated Vector Store (Disk)
  vector_index/{patientUid}/
  Service token required
```

---

## 2. AI Provider Security Boundary (Phase 3 — IMPLEMENTED)

### 2.1 Google Gemini — Clinical Intake Interview

| Aspect | Status |
|---|---|
| Key location | Root `.env` → `GEMINI_API_KEY` (server-side only) |
| Key in browser bundle | ❌ Verified absent (TEST-P3-19, TEST-P3-20, TEST-P3-21) |
| Key in API response | ❌ Never returned (TEST-P3-18) |
| Key in logs | ❌ Redacted by structured logger |
| Endpoint | `POST /api/ai/intake-question` (Node backend proxy) |
| Rate limit | 30 req / 10 min per terminal IP |
| Timeout | 5.5 s per Gemini model call; 3 model fallback cascade |
| Data sent to Gemini | `patientMessage`, bounded `conversationHistory` (last 8 turns), `patientAge`, `patientGender`, `language` |
| Data **NOT** sent | Full legal name, phone number, ABHA number, ABHA address, Aadhaar, historical documents, raw DB objects, unrelated patient records |
| Fallback on failure | `AI_PROVIDER_UNAVAILABLE` / `AI_PROVIDER_TIMEOUT` (HTTP 503/504) → frontend uses `clinicalDialogEngine.js` |
| Fallback labelling | Local fallback is **never** labelled as Gemini — provenance is distinguished |

### 2.2 Groq LLM — Longitudinal RAG (Phase 5 Target)
- Key: `GROQ_API_KEY` in root `.env` — Python service only
- Endpoint: Internal Python FastAPI — Node proxy required
- Data: Retrieved chunks from selected patient's index only
- Status: **NOT IMPLEMENTED** in Phase 3

---

## 3. Prompt-Injection Boundary (Phase 3 — IMPLEMENTED)

Patient-provided text is treated as **DATA only**, not as instructions.

**Implementation**:
- `SYSTEM_PROMPT` lives in server.js — never in the browser bundle
- Patient text is placed in the `contents[]` array as `role: "user"` turns
- The `systemInstruction` field contains only the server-hardcoded prompt
- Zod validation prevents injection of `systemInstruction` field from the request body
- Server-side Gemini call enforces: patient text cannot override the system instruction
- The server logs a warning if any field attempts to override system instructions (future enhancement: explicit filter)

**Future Document/RAG Boundary**:
- When document text enters the system (Phase 5), it will be placed strictly in `context:` or `documents:` fields, never in `systemInstruction`
- Document chunks from RAG retrieval are data — the doctor's query prompt is separate

---

## 4. Authentication & Authorization Foundation (Phase 3 + Phase 3.1 Security Patch)

### 4.1 Critical Distinction: Patient Existence Check vs. Patient Authorization

These are **two fundamentally different security controls** that must never be conflated:

| Control | Question Answered | Mechanism | Sufficiency |
|---|---|---|---|
| **PATIENT EXISTENCE CHECK** | *"Does a record with this `patientUid` exist in the database?"* | Database query (`findUnique`) | ❌ **INSUFFICIENT** — An attacker who guesses or discovers a valid UUID could access any patient's AI context. |
| **PATIENT AUTHORIZATION** | *"Is the current authenticated actor permitted to access THIS specific patient's record?"* | Session / token verification + scope match (`session.patientUid === requestedUid`) | ✅ **REQUIRED** — Enforces identity boundaries: Actor A cannot access Patient B even if Patient B exists. |

```
Unauthenticated Request / No Session:
[ Client Request ] ─── with patientUid ───► [ Auth Gate ] ─── No session token ───► 401 AUTHENTICATION_REQUIRED
                                                                                     (DB existence is never checked)

Cross-Patient Attack:
[ Actor A Session ] ── with patientUid B ─► [ Auth Gate ] ── Token valid for Patient A
                                                               Requested Patient B
                                                                         ↓
                                                               403 FORBIDDEN (PATIENT_SCOPE_MISMATCH)

Authorized Request:
[ Actor A Session ] ── with patientUid A ─► [ Auth Gate ] ── Token matches Patient A
                                                                         ↓
                                                               200 OK (AI proxy executed with Patient A scope)
```

### 4.2 Three Distinct Session Namespaces & Cookies (Phase 4 Model)

The platform strictly separates three distinct session contexts using dedicated cookie namespaces, separate lifecycles, and independent server-side validation routines:

| Context | Cookie Name | Backing Entity & Scope | Lifetime | Permissions & Invalidation |
|---|---|---|---|---|
| **A. Kiosk Device Session** | `ms_device_session` | Physical Kiosk Terminal (`role: kiosk_operator` or device token) | 24 hours | Permitted to perform patient lookups, verify demographics, and initiate new intake flows. Cannot view longitudinal histories or complete doctor consultations. Invalidated on terminal shift checkout. |
| **B. Patient Encounter Session** | `ms_encounter_session` | Ephemeral Patient Encounter (`patientUid` + `encounterId`) | 2 hours (or intake completion) | Permitted to answer clinical intake questions via AI proxy strictly for their own encounter. Automatically invalidated upon intake submission. Never confused with a user/clinician identity. |
| **C. Doctor / Staff User Session** | `ms_user_session` | Clinician / Staff Identity (`User.id`, role: `doctor`, `admin`, `clinical_staff`) | 8 hours | Permitted to view OPD queues, assigned encounters, complete consultations, and query historical records based on explicit clinical relationship. Invalidated on explicit logout. |

### 4.3 Deployment Topology & Cookie / CSRF Architecture
- **Topology Alignment**:
  - **Development**: React Vite SPA (:5173) reverse-proxying `/api` requests to Express Gateway (:5000). Since requests flow through the same origin from the browser's perspective, cookies are configured with `SameSite=Lax; HttpOnly; Path=/`. The `Secure` flag is disabled for local HTTP.
  - **Production**: Single-domain or unified origin behind NGINX / Cloud Ingress (e.g. `https://hospital.gov.in/` and `https://hospital.gov.in/api`). Cookies enforce `SameSite=Strict; HttpOnly; Path=/; Secure`.
- **Zero Raw Tokens in JSON**: Session credentials are set strictly via `Set-Cookie`. API responses never return raw session secrets in JSON bodies, and client-side storage in `localStorage` or `sessionStorage` is strictly prohibited.
- **CSRF Defense on State-Changing Requests**: All state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) require:
  1. Valid `Origin` or `Referer` matching the authorized host.
  2. Custom request header check (`X-Requested-With: XMLHttpRequest` or custom token).
  3. Mismatched or absent headers on cookie-authenticated requests are rejected with **`403 FORBIDDEN (CSRF_VIOLATION)`**.

### 4.4 Kiosk Context Binding, Anti-Enumeration & Registration Handles

#### A. Patient Lookup Anti-Enumeration & Privacy Controls
- **Rate Limiting**: `POST /api/patients/lookup` enforces strict rate limits (10 requests per minute per kiosk device / IP with progressive backoff on repeated misses).
- **Format Validation**: Strict regex verification (`/^[6-9]\d{9}$/` for Indian mobile; `/^\d{2}-\d{4}-\d{4}-\d{4}$/` for ABHA) fires before any database query is executed.
- **Session Requirement**: Requires a valid `ms_device_session` (kiosk hardware context) or authenticated clinician `ms_user_session`. Public unauthenticated calls are rejected with `401`.
- **Minimal Candidate Information**: Responses contain only heavily masked preview data (`fullName`: `"R**** K****"`, `maskedMobile`: `"******3210"`, `age`, `gender`, `patientId`).
- **No Historical Disclosure**: Zero `patientUid`, zero medical records, zero encounter history, and zero uploaded documents are revealed during lookup.
- **Timing Defense & Anti-Enumeration**: DB lookup queries execute within consistent time bounds to mitigate timing side-channel probes.
- **Audit Tracking**: Audited under `actorType: DEVICE`, `action: PATIENT_LOOKUP` with candidate count (never logging raw identifiers).

#### B. Kiosk-Bound `lookupHandle` Lifecycle (Returning Patient)
- When candidate records are found, server returns a cryptographically random, single-use `lookupHandle` (`lh_<uuid>`, 5-minute TTL).
- **Binding**: Stored server-side mapped to the caller's `ms_device_session` and the candidate set.
- **Replay / Mismatch Rejection**:
  - Presented from another kiosk device session → `403 FORBIDDEN (HANDLE_CONTEXT_MISMATCH)`.
  - Re-used after encounter creation → `409 CONFLICT (LOOKUP_HANDLE_CONSUMED)`.
  - Expired (> 5 min) → `403 FORBIDDEN (LOOKUP_HANDLE_EXPIRED)`.
- **Encounter Creation**: `POST /api/encounters { lookupHandle, candidateId, chiefComplaint }` resolves to the verified candidate, immediately invalidates the handle, and issues `Set-Cookie: ms_encounter_session=...`.

#### C. Trusted `registrationHandle` Lifecycle (New Patient Onboarding)
To prevent clients from submitting arbitrary or forged `patientUid`s to create encounters:
1. **Authorization Gate on `POST /api/patients`**: Restricted to authorized kiosk device sessions (`ms_device_session`) or authenticated operators (`ms_user_session` with role `kiosk_operator`, `clinical_staff`, `doctor`, `admin`). Unauthenticated calls receive `401`.
2. **Server-Side Creation**: Server inserts the canonical `Patient` record, generating an internal `patientUid`.
3. **Handle Issuance**: Server generates a short-lived `registrationHandle` (`rh_<uuid>`, 5-minute TTL, single-use) bound to the caller's `ms_device_session` and the newly created `patientUid`.
4. **Controlled Encounter Creation**: Kiosk submits `POST /api/encounters { registrationHandle, chiefComplaint, priority }`.
5. **Server Resolution**: Gateway resolves `registrationHandle -> patientUid`, consumes the handle, establishes the `Encounter`, and issues `Set-Cookie: ms_encounter_session=...`.
6. **Invariant**: The frontend is **never allowed to supply an arbitrary `patientUid`** to create an encounter.

### 4.5 Explicit Doctor Clinical Access & CareRelationship Lifecycle

Access is not granted by `role == "doctor"` alone. Access is governed by an explicit three-tier model supported by `CareRelationship`:

```
Doctor Access Evaluation:
1. Is doctor assigned to current encounter? (Encounter.assignedDoctorId === req.user.id)
   └──► YES: Grant Current Encounter Access (View intake, document upload, complete OPD)
   └──► NO: Check active chamber claim queue. Can claim encounter?
        ├──► Encounter.chamber === null ──► REJECT: 403 FORBIDDEN (CHAMBER_ROUTING_REQUIRED)
        ├──► Encounter.chamber !== req.user.chamber ──► REJECT: 403 FORBIDDEN (CHAMBER_MISMATCH)
        └──► Chamber matches + waiting + unassigned ──► YES: PUT /api/encounters/:id/claim -> Assign doctor & establish ATTENDING_OPD relationship

3. Longitudinal Patient History Access (Past encounters, FAISS RAG, historical records)
   └──► Check CareRelationship (patientUid, doctorId, status == 'active')
        ├──► Active PRIMARY_PHYSICIAN or SPECIALIST_REFERRAL ──► YES: Grant Longitudinal Access
        ├──► Active ATTENDING_OPD (within 24h of encounter) ───► YES: Grant Longitudinal Access
        ├──► Suspended status ('suspended') ──────────────────► 403 FORBIDDEN (LONGITUDINAL_ACCESS_DENIED)
        ├──► Ended status ('ended') ──────────────────────────► 403 FORBIDDEN (LONGITUDINAL_ACCESS_DENIED)
        ├──► Expired review window (now > expiresAt) ─────────► 403 FORBIDDEN (LONGITUDINAL_ACCESS_DENIED)
        └──► No active relationship ──────────────────────────► 403 FORBIDDEN (LONGITUDINAL_ACCESS_DENIED)

4. Patient Self-Access:
   - Valid ms_encounter_session matching patientUid / encounter token?
     └──> YES: Grant patient self-access to own intake and consultation status.

5. Administrative Access:
   └──► Role admin? ──► Requires X-Admin-Access-Reason header ──► YES: Grant Audited Admin Access (AuditLog entry created with mandatory reason)
```

#### CareRelationship Lifecycle Specifications:
- **Creation**:
  - Automatically established as `relationshipType: "ATTENDING_OPD"` with `status = "active"` and `expiresAt = null` when a doctor claims a chamber-routed encounter (`PUT /api/encounters/:id/claim`). Expiration is NOT assigned at claim time.
  - Manually created as `PRIMARY_PHYSICIAN` or `SPECIALIST_REFERRAL` by attending clinicians or administrators via `POST /api/care-relationships`. `actorUserId` is strictly populated from `req.user.id`.
- **States**: `active` (permitted access), `suspended` (temporarily blocked e.g. pending consent re-authorization), `ended` (terminated).
- **Suspension**:
  - Authenticated clinician or administrator suspends via `PUT /api/care-relationships/:id/suspend`.
  - Suspended relationships strictly deny longitudinal clinical access.
- **Expiration**:
  - `ATTENDING_OPD`: At consultation completion (`PUT /api/patient/:token/complete`), `completedAt` is recorded on the Encounter and `CareRelationship.expiresAt` is finalized to `completedAt + 24h` (preserves a 24-hour post-encounter review window). Once expired, historical access is denied.
  - `SPECIALIST_REFERRAL`: Time-bounded (e.g. 7–30 days).
  - `PRIMARY_PHYSICIAN`: Long-term (e.g. 1 year, renewable).
- **Termination**:
  - Attending doctor (own relationship) or administrator can explicitly end the relationship via `PUT /api/care-relationships/:id/end` (`endedAt = now()`, `status = "ended"`).
  - Ended relationships strictly deny longitudinal clinical access.
- **Admin Access Reason**: High-severity administrative override requires non-empty `X-Admin-Access-Reason` header and writes audited clinical rationale to `AuditLog`.

### 4.6 Multi-Actor Audit Attribution Model
To prevent fabricating fake `User` records for hardware or backend services, `AuditLog` explicitly tracks 4 actor types:
1. `USER`: Authenticated clinician, staff, or admin. `actorUserId` is strictly populated from `req.user.id`.
2. `DEVICE`: Kiosk terminal or tablet. `actorDeviceId` is populated from the terminal ID (e.g. `KIOSK-01`).
3. `SERVICE`: Internal microservice (e.g. `fastapi-rag-service`, `ocr-worker`). `actorService` is recorded.
4. `SYSTEM`: Automated scheduled jobs, database maintenance, TTL evictions. `actorUserId` is null.

### 4.7 Non-Blocking Asynchronous Password Hashing
- **Asynchronous Execution**: Password verification and hashing use Node.js **asynchronous** `crypto.scrypt` (`util.promisify(crypto.scrypt)`). Synchronous `scryptSync` is strictly prohibited in request handlers to prevent blocking the Node.js event loop.
- **Scrypt Parameters**:
  - `N` = 16384 (CPU/memory cost)
  - `r` = 8 (block size)
  - `p` = 1 (parallelization)
  - `keylen` = 64 bytes
  - `salt` = 16 cryptographically secure random bytes (`crypto.randomBytes(16)`)
- **Credential Hygiene**:
  - `passwordHash` and `salt` are **never returned in any API response** and **never logged**.
  - Login failures always return a generic error: `"Invalid email or password"`.
  - Dedicated `authRateLimiter` enforces max 5 failed attempts per 15 minutes per IP/account.

### 4.8 Session Store: Local Development vs. Production Architecture
- **Local Development**: Uses an in-process, memory-bounded session map.
- **Production Architecture**: In-memory sessions are strictly local-only. Production requires a shared durable session store (Redis / Valkey cluster) to support horizontal scaling, zero-downtime rolling restarts, distributed revocation, and centralized monitoring.


---

---

## 5. Purpose-Aware Patient Consent Model

| Consent Type | Purpose | Mandatory |
|---|---|---|
| `data_collection` | Recording demographic information, chief complaint | Yes |
| `document_processing` | Parsing uploaded paper records | Conditional |
| `ai_processing` | Generating intake questions via Gemini proxy | Yes |
| `record_sharing` | Transmitting encounter to physician | Yes |
| `abha_integration` | Linking ABDM health records | Optional |

> Consent is versioned (`policyVersion: "v1.2-2026"`). Withdrawal (`withdrawnAt`) immediately disables subsequent processing for that purpose. Having consent fields does NOT constitute legal certification — formal institutional review and BAA agreements are required prior to live deployment.

---

## 6. FAISS Vector Store Isolation

1. **Application-Level Enforced Isolation**: Isolation enforced by filesystem namespace: `vector_index/{patientUid}/index.faiss`
2. **Authorization prerequisite**: The Node API must verify the requesting actor is authorized for the `patientUid` BEFORE calling the Python RAG service
3. **Concurrency**: Process locks via `filelock` (`vector_index/{patientUid}/.lock`). Atomic writes via `.tmp` → `os.replace`

---

## 7. Error Handling & Information Disclosure

Errors use the consistent structured envelope:
```json
{ "error": { "code": "ERROR_CODE", "message": "...", "requestId": "..." } }
```

**Never exposed in errors**:
- API keys or secrets
- Stack traces (filesystem paths may leak)
- Raw database error messages
- Complete medical documents
- Patient PHI beyond what the requester is authorized for

---

## 8. Service-to-Service Security (Phase 5 Preparation)

When the Python RAG service is introduced, Node will authenticate to it using:
- `Authorization: Bearer <RAG_SERVICE_INTERNAL_TOKEN>` header
- `RAG_SERVICE_INTERNAL_TOKEN` in root `.env` — strong random secret
- The RAG service must validate this token on every request
- The RAG service must NOT be exposed on a public port without this check
- Kubernetes deployment: NetworkPolicy restricts RAG pod to Node API pod only

---

## 9. PostgreSQL Status

| Item | Status |
|---|---|
| Schema defined and validated | ✅ |
| SQLite local development validated | ✅ |
| PostgreSQL live staging validation | ⏳ PENDING INFRASTRUCTURE |

**System is NOT called production-ready until PostgreSQL live validation completes.**

---

## 10. Compliance Reminders (Non-Implementation)

These are NOT implemented features — they are documented requirements for live deployment:
- Formal DISHA / IT Act 2000 compliance review required before handling real patient data
- Business Associate Agreement (BAA) required with Google (Gemini) for PHI processing
- Institutional Review Board (IRB) or equivalent approval required
- Penetration testing required before production launch
- Full audit log retention policy to be defined per local law
