# Phase 4 Implementation Plan: Patient Identity, Session Security, RBAC & ABHA Readiness

**Status**: Authoritative Final Plan — **FULLY IMPLEMENTED** (Phase 4 Complete)  
**Target Scope**: Phase 4 ONLY (Patient Registration + Identity + Session Management + Clinical RBAC + Mobile Lookup + ABHA Readiness)  
**Strict Exclusions**: Phase 5 Dynamic Interview Planner, OCR Pipeline, RAG Ingestion, FastAPI RAG Service, FAISS Migration, Longitudinal Intelligence UI.

---

## 1. Goal
Establish a secure, production-grade dynamic patient identity and clinical access management foundation for the MedSync + AuraHealth Nexus platform. Specifically:
1. Replace demo/synthetic patient assumptions with real database-backed patient registration and intake.
2. Provide privacy-preserving mobile number lookup supporting legitimately shared family phones without silent merges or duplicate rejections.
3. Establish three distinct session namespaces (`ms_device_session`, `ms_encounter_session`, `ms_user_session`) with independent lifetimes and permission boundaries.
4. Enforce an explicit three-tier clinical authorization model distinguishing Current Encounter Access from Longitudinal Patient Access (via `CareRelationship`) and Administrative Access.
5. Provide a secure new-patient onboarding flow via trusted server-side `registrationHandle` preventing arbitrary `patientUid` submission.
6. Support ABHA Number and Address collection with a truthful verification state machine and an architectural adapter boundary without fabricating simulated verifications.
7. Implement non-blocking asynchronous `crypto.scrypt` password hashing, multi-layer CSRF defenses, and a multi-actor `AuditLog` model (`USER`, `DEVICE`, `SERVICE`, `SYSTEM`).

---

## 2. Architecture

```mermaid
graph TD
    subgraph ClientLayer["Client Contexts"]
        Kiosk["Kiosk Hardware Terminal"]
        PatientUI["Patient Intake Web UI"]
        DoctorUI["Doctor OPD Chamber Dashboard"]
    end

    subgraph CookieBoundaries["Independent Cookie Namespaces"]
        D_Cookie["ms_device_session (24h TTL)<br/>Kiosk Terminal IP/Device Context"]
        E_Cookie["ms_encounter_session (2h TTL)<br/>Scoped to single patientUid + encounterId"]
        U_Cookie["ms_user_session (8h TTL)<br/>Role-bearing Clinician Identity"]
    end

    subgraph GatewayLayer["Node.js Express API Gateway (:5000)"]
        AuthCtrl["Auth & Session Controller<br/>Async scrypt (N=16384, r=8, p=1)"]
        CSRFMiddleware["Topology-Aware CSRF Middleware<br/>Origin/Referer + Custom Header"]
        LookupService["Privacy-Preserving Lookup & Handle Service<br/>5-min Single-Use Handles bound to Device"]
        ClinicalAuth["Three-Tier Clinical Authorization Engine"]
        AbdmAdapter["Truthful ABDM Integration Adapter"]
    end

    subgraph PersistenceLayer["Relational Database (Prisma ORM)"]
        UserTable["User (passwordHash, salt, role)"]
        PatientTable["Patient (patientUid, non-unique mobileNumber)"]
        EncounterTable["Encounter (assignedDoctorId, tokenNumber)"]
        CareTable["CareRelationship (longitudinal authorization)"]
        AuditTable["AuditLog (actorType: USER/DEVICE/SERVICE/SYSTEM)"]
    end

    Kiosk -->|Cookie| D_Cookie --> LookupService
    PatientUI -->|Cookie| E_Cookie --> ClinicalAuth
    DoctorUI -->|Cookie| U_Cookie --> AuthCtrl

    LookupService --> PersistenceLayer
    ClinicalAuth --> PersistenceLayer
    AuthCtrl --> PersistenceLayer
    AbdmAdapter -.->|Sandbox (When Configured)| ABDMGateway["Official NHA Gateway"]
```

---

## 3. Database Changes

The schema changes will be applied symmetrically to `prisma/schema.prisma` (PostgreSQL production) and `prisma/schema.sqlite.prisma` (SQLite local validation):

```prisma
model User {
  id           Int      @id @default(autoincrement())
  userUid      String   @unique
  name         String
  email        String   @unique
  passwordHash String?  // Asynchronous scrypt hash (64 bytes)
  salt         String?  // 16-byte random salt
  role         String   // doctor, admin, clinical_staff, kiosk_operator
  chamber      String?
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  assignedEncounters Encounter[]        @relation("AssignedDoctor")
  careRelationships  CareRelationship[] @relation("DoctorCareRelationships")
  documentApprovals  DocumentApproval[]
  auditLogs          AuditLog[]         @relation("UserAuditLogs")
  capturedConsents   PatientConsent[]
}

model Patient {
  id           Int       @id @default(autoincrement())
  patientUid   String    @unique // System immutable UUID v4
  patientId    String    @unique // Human-readable reference (PAT-YYYY-NNNN)
  fullName     String
  dateOfBirth  DateTime?
  age          Int?
  gender       String?
  mobileNumber String?   // NOT UNIQUE; shared family phones permitted
  abhaNumber   String?
  abhaAddress  String?
  abhaVerified Boolean   @default(false) // Never true without official gateway confirmation
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  encounters        Encounter[]
  careRelationshipsReceived CareRelationship[] @relation("CareRelationshipDoctor")
  careRelationshipsAssigned CareRelationship[] @relation("CareRelationshipAssignedBy")
  documents         Document[]
  consents          PatientConsent[]
  auditLogs         AuditLog[]

  @@index([mobileNumber])
  @@index([abhaNumber])
}

model Encounter {
  id                 Int       @id @default(autoincrement())
  encounterId        String    @unique // ENC-YYYY-NNNN
  patientUid         String
  assignedDoctorId   Int?      // Enforces current encounter access boundary
  tokenNumber        String
  priority           String    @default("Normal")
  triageReason       String?
  consultationStatus String    @default("waiting") // waiting, in_progress, completed
  chiefComplaint     String?
  hpi                String?
  pastHistory        String?
  currentMedsJson    String?
  allergiesJson      String?
  doctorNotes        String?
  intakeConversation String?
  provenance         String    @default("PATIENT_REPORTED")
  createdAt          DateTime  @default(now())
  completedAt        DateTime?

  patient           Patient            @relation(fields: [patientUid], references: [patientUid], onDelete: Cascade)
  assignedDoctor    User?              @relation("AssignedDoctor", fields: [assignedDoctorId], references: [id])
  careRelationships CareRelationship[]
  documents         Document[]

  @@index([patientUid])
  @@index([assignedDoctorId])
  @@index([tokenNumber])
  @@index([consultationStatus])
}

model CareRelationship {
  id               Int       @id @default(autoincrement())
  patientUid       String
  doctorId         Int
  relationshipType String    // ATTENDING_OPD, PRIMARY_PHYSICIAN, SPECIALIST_REFERRAL
  status           String    @default("active") // active, suspended, ended
  encounterId      String?
  createdAt        DateTime  @default(now())
  expiresAt        DateTime?
  endedAt          DateTime?
  assignedByUserId Int?
  notes            String?

  patient          Patient    @relation(fields: [patientUid], references: [patientUid], onDelete: Cascade)
  doctor           User       @relation("CareRelationshipDoctor", fields: [doctorId], references: [id])
  assignedByUser   User?      @relation("CareRelationshipAssignedBy", fields: [assignedByUserId], references: [id])
  encounter        Encounter? @relation(fields: [encounterId], references: [encounterId])

  @@index([patientUid, doctorId, status])
}

model AuditLog {
  id            Int      @id @default(autoincrement())
  patientUid    String?
  actorType     String   // USER, DEVICE, SERVICE, SYSTEM
  actorUserId   Int?     // Set strictly when actorType == "USER"
  actorDeviceId String?  // Terminal ID when actorType == "DEVICE"
  actorService  String?  // Service name when actorType == "SERVICE"
  action        String   // PATIENT_LOOKUP, REGISTER_PATIENT, CLAIM_ENCOUNTER, etc.
  resourceType  String   // patient, encounter, care_relationship, document, rag_query
  resourceId    String?
  timestamp     DateTime @default(now())
  metadataJson  String?

  patient   Patient? @relation(fields: [patientUid], references: [patientUid])
  actorUser User?    @relation("UserAuditLogs", fields: [actorUserId], references: [id])

  @@index([patientUid])
  @@index([actorUserId])
  @@index([actorType, action])
}
```

---

## 4. Authentication

1. **Non-Blocking Asynchronous Hashing**:
   - Implemented via `util.promisify(crypto.scrypt)`. `scryptSync` is strictly prohibited.
   - Parameters: `N = 16384`, `r = 8`, `p = 1`, `keylen = 64`.
   - Salt: 16 cryptographically random bytes (`crypto.randomBytes(16)`).
   - Verification: Constant-time comparison using `crypto.timingSafeEqual` prevents timing attacks.
2. **Credential Hygiene**:
   - Passwords, salts, and password hashes are never returned in JSON payloads and never logged.
   - Authentication failures return generic errors (`"Invalid email or password"`).
3. **Brute-Force Throttling**:
   - `authRateLimiter` enforces a maximum of 5 failed login attempts per 15 minutes per IP/account.

---

## 5. Session Model

Three distinct, non-conflatable session namespaces:

| Attribute | Kiosk Device Session (`ms_device_session`) | Patient Encounter Session (`ms_encounter_session`) | Doctor/Staff User Session (`ms_user_session`) |
|---|---|---|---|
| **Audience** | Kiosk hardware / terminal operator | Walk-in patient completing intake | Authenticated physician, nurse, admin |
| **Lifetime** | 24 hours | 2 hours (or until encounter completed) | 8 hours |
| **Storage** | `HttpOnly; SameSite=Lax/Strict; Path=/` | `HttpOnly; SameSite=Lax/Strict; Path=/` | `HttpOnly; SameSite=Lax/Strict; Path=/` |
| **Permissions** | Patient lookup, candidate registration | Intake questionnaire, document upload for own encounter | OPD queue, encounter claiming, prescribing, longitudinal history |
| **Invalidation** | Terminal sign-off / restart | Consultation completion / timeout | Explicit logout (`/api/auth/logout`) |
| **Boundary Rule** | Cannot access queue or clinical data | Cannot escalate to doctor or access other patients | Cannot masquerade as patient intake session |

---

## 6. Patient Registration (New Patient Flow)

To prevent clients from submitting arbitrary `patientUid`s to create encounters, new onboarding uses a server-issued `registrationHandle`:

```
POST /api/patients { fullName, age, gender, mobileNumber, abhaNumber? }
[Requires ms_device_session OR staff ms_user_session]
      ↓
Server validates input & inserts canonical Patient record
Server generates short-lived registrationHandle (rh_<uuid>, 5-min TTL, single-use)
bound to caller's ms_device_session and new patientUid
      ↓
Response: 201 Created {
  registrationHandle: "rh_...",
  patient: { patientId: "PAT-2026-0017", fullName: "..." }
} (NO raw patientUid returned)
      ↓
POST /api/encounters { registrationHandle, chiefComplaint, priority }
[Sends ms_device_session]
      ↓
Server validates registrationHandle matches ms_device_session
Server resolves registrationHandle -> patientUid & invalidates handle
Server inserts Encounter record
Server sets Set-Cookie: ms_encounter_session=...
```

**Authorization on `POST /api/patients`**: Public unauthenticated calls are rejected with `401 AUTHENTICATION_REQUIRED`. Caller must present a valid `ms_device_session` or an authenticated staff `ms_user_session`.

---

## 7. Mobile Lookup & Anti-Enumeration

`POST /api/patients/lookup` protects patient privacy and prevents enumeration:
1. **Rate Limiting**: Enforces 10 requests per minute per terminal IP/device with progressive backoff.
2. **Session Requirement**: Requires a valid `ms_device_session` or authenticated clinician `ms_user_session`.
3. **Format Validation**: Strict regex verification (`/^[6-9]\d{9}$/` for mobile; `/^\d{2}-\d{4}-\d{4}-\d{4}$/` for ABHA) fires before executing database queries.
4. **Minimal Masked Preview**:
   - `fullName`: Masked as `"R**** K****"`
   - `maskedMobile`: Masked as `"******3210"`
   - Minimal fields: `patientId`, `age`, `gender`, `candidateId`
   - **Zero disclosure**: `patientUid`, clinical history, past visits, and uploaded documents are never returned.
5. **Kiosk-Bound `lookupHandle`**: Server returns a single-use `lookupHandle` (`lh_<uuid>`, 5-min TTL) bound to the caller's `ms_device_session`. Replay from another kiosk yields `403 FORBIDDEN (HANDLE_CONTEXT_MISMATCH)`.
6. **Shared Mobile Candidate Selection**:
   - When multiple candidates share a number, all candidates are returned as masked previews.
   - The user selects their specific candidate OR chooses "Register new patient on this phone".
   - The system never silently merges records.

---

## 8. ABHA Readiness

1. **Truthful State Machine**:
   - Supported states: `entered`, `lookup_pending`, `verified`, `verification_failed`, `not_configured`, `unavailable`.
   - Entering an ABHA identifier sets `abhaVerified = false`.
   - Entering an ABHA identifier never sets `abhaVerified = true` without official cryptographic OTP verification via the National Health Authority (NHA) gateway.
2. **Adapter Architecture (`abdmAdapter.js`)**:
   - Encapsulates ABDM gateway communication behind standard interfaces.
   - When official sandbox credentials are absent from `.env`, the adapter returns `not_configured`.
   - Zero synthetic OTPs or fabricated verifications are generated. Registration continues uninterrupted using mobile-first intake.

---

## 9. Doctor Access Control & CareRelationship Lifecycle

Access is governed by three explicit, server-enforced tiers:

```
Clinical Access Gate:
1. Current Encounter Access:
   - Allowed IF: Encounter.assignedDoctorId === req.user.id
   - Allowed IF: Encounter is in doctor's OPD chamber queue and doctor claims it:
     PUT /api/encounters/:id/claim -> Updates assignedDoctorId and creates ATTENDING_OPD CareRelationship
   - Otherwise -> 403 CLINICAL_ACCESS_DENIED

   CHAMBER RULE (Option B — IMPLEMENTED):
   - Encounters with Encounter.chamber === null are NOT claimable.
   - Doctor receives 403 CHAMBER_ROUTING_REQUIRED.
   - Clinical staff must explicitly assign a chamber before any doctor can claim.
   - If Encounter.chamber !== req.user.chamber -> 403 CHAMBER_MISMATCH.
   - Encounter must have a non-null, matching chamber for a successful claim.

2. Longitudinal Patient Access (Historical encounters, previous documents, FAISS RAG):
   - Allowed IF: Active CareRelationship exists (PRIMARY_PHYSICIAN, SPECIALIST_REFERRAL, or active ATTENDING_OPD within 24h)
   - status === "suspended" -> access DENIED
   - status === "ended" -> access DENIED
   - expiresAt < now() -> access DENIED
   - Otherwise -> 403 LONGITUDINAL_ACCESS_DENIED

3. Administrative Access:
   - Allowed for role: admin with audited access justification (writes high-priority AuditLog)
```

**CareRelationship Lifecycle (FULLY IMPLEMENTED)**:

| Operation | Route | Trigger | Details |
|---|---|---|---|
| Auto-create (ATTENDING_OPD) | `PUT /api/encounters/:id/claim` | Doctor claims chambered encounter | `status=active`, `expiresAt=null`, inside claim transaction |
| Manual create | `POST /api/care-relationships` | Doctor/admin creates PRIMARY_PHYSICIAN or SPECIALIST_REFERRAL | ATTENDING_OPD excluded from this route |
| Suspend | `PUT /api/care-relationships/:id/suspend` | Doctor (own) or admin | Only `active` → `suspended`; suspended relationship denies longitudinal access |
| End | `PUT /api/care-relationships/:id/end` | Doctor (own) or admin | Any non-ended → `ended`; `endedAt = now()`; ended relationship denies longitudinal access |
| Auto-expire | `PUT /api/patient/:token/complete` | Consultation completion | Sets `expiresAt = completedAt + 24h` on ATTENDING_OPD relationship; expired relationship denies longitudinal access |

**Authorization rules for lifecycle operations**:
- `doctorId`, `assignedByUserId`, `actorUserId` always sourced from `req.user.id`. Clients cannot supply actor identity.
- All lifecycle changes are atomic inside `prisma.$transaction` with a corresponding `AuditLog` entry.
- Canonical `actorType` values: `USER`, `DEVICE`, `SERVICE`, `SYSTEM`. Role strings (`doctor`, `admin`) are never used as `actorType`.


---

## 10. Audit Model

`AuditLog` supports multi-actor attribution without fabricating fake `User` records:
- `actorType`: `USER` (clinician/staff), `DEVICE` (kiosk terminal), `SERVICE` (microservice e.g. RAG), `SYSTEM` (automated job).
- `actorUserId`: Relational `User.id` when `actorType === "USER"`; `null` otherwise.
- `actorDeviceId`: Terminal identifier (e.g. `KIOSK-01`) when `actorType === "DEVICE"`.
- `actorService`: Service name (e.g. `fastapi-rag-service`) when `actorType === "SERVICE"`.
- `metadataJson`: Contextual details strictly stripped of PHI, plaintext passwords, and session secrets.

---

## 11. API Contracts

| Route | Method | Required Session | Request Body Highlights | Response Highlights |
|---|---|---|---|---|
| `/api/auth/login` | POST | None | `{ email, password }` | 200 OK + `Set-Cookie: ms_user_session=...` (zero tokens in JSON) |
| `/api/auth/logout` | POST | Any valid | None | 200 OK + clears cookie (`Max-Age=0`) + destroys server session |
| `/api/auth/session` | GET | `ms_user_session` | None | 200 OK `{ user: { id, email, name, role, chamber } }` |
| `/api/patients/lookup` | POST | `ms_device_session` | `{ mobileNumber }` or `{ abhaNumber }` | 200 OK `{ found, lookupHandle, candidates: [masked] }` |
| `/api/patients` | POST | `ms_device_session` or staff | `{ fullName, age, gender, mobileNumber, ... }` | 201 Created `{ registrationHandle, patient: { patientId } }` |
| `/api/encounters` | POST | `ms_device_session` | `{ lookupHandle, candidateId }` OR `{ registrationHandle }` | 201 Created + `Set-Cookie: ms_encounter_session=...` |
| `/api/encounters/:id/claim` | PUT | `ms_user_session` (doctor) | None | 200 OK `{ encounterId, assignedDoctorId }` |
| `/api/patients/:patientUid` | GET | `ms_user_session` / `ms_encounter_session` | None | 200 OK (Enforces clinical relationship or own encounter) |
| `/api/patient/:token` | GET | `ms_user_session` / `ms_encounter_session` | None | 200 OK (Enforces authentication & clinical assignment) |
| `/api/patient/:token/complete` | PUT | `ms_user_session` (doctor) | `{ notes, medications }` | 200 OK (Enforces assigned doctor; logs `actorUserId = req.user.id`) |

---

## 12. Frontend Changes

1. **`LoginPage.jsx`**:
   - Replaces hardcoded PIN check with real `POST /api/auth/login`.
   - Receives `ms_user_session` cookie; stores user profile in React auth state (no tokens in `localStorage`).
2. **`PatientAuth.jsx`**:
   - Multi-option intake: Mobile input, ABHA Number, ABHA Address, "I don't have an ABHA ID".
   - Shared mobile candidate selection card ("Select existing patient OR Register new patient").
   - Masked candidate card (`"R**** K****, ******3210"`).
   - Submits `registrationHandle` or `lookupHandle` to create the encounter.
3. **`DemoContext.jsx` & API Client**:
   - Configures `credentials: "include"` on all `fetch` requests.
   - Attaches `X-Requested-With: XMLHttpRequest` header to satisfy CSRF middleware.

---

## 13. Security Model

1. **Topology-Aware Cookie Settings**:
   - *Local Dev*: `HttpOnly; SameSite=Lax; Path=/` (`Secure=false` on HTTP).
   - *Production (Reverse Proxy)*: `HttpOnly; Secure; SameSite=Strict; Path=/`.
   - *Production (Subdomains)*: `HttpOnly; Secure; SameSite=Lax; Domain=.hospital.gov.in; Path=/`.
2. **Multi-Layer CSRF Defense**:
   - Independent of `SameSite`. All state-changing methods (`POST`, `PUT`, `PATCH`, `DELETE`) require `X-Requested-With` header + valid `Origin`/`Referer` matching authorized hostnames.
3. **Anti-Enumeration & Scope Isolation**:
   - Kiosk lookup never returns `patientUid` or clinical records.
   - `lookupHandle` and `registrationHandle` are single-use, 5-minute TTL, bound to `ms_device_session`.
   - Arbitrary `patientUid` submissions on encounter creation are rejected with 400.

---

## 14. Complete Single Test Matrix (36 Authoritative Tests in `tests/phase4_identity.test.js`)

| Test ID | Exact Behavior | Target Component / Boundary | Expected Outcome |
|---|---|---|---|
| **TEST-P4-01** | Doctor login with valid credentials via async `scrypt` | Node Auth / Credentials | 200 OK + `Set-Cookie: ms_user_session=...; HttpOnly; SameSite=...` |
| **TEST-P4-02** | Login with invalid password | Node Auth / Credentials | 401 `AUTHENTICATION_REQUIRED` (generic, timing-safe) |
| **TEST-P4-03** | `GET /api/auth/session` with active `ms_user_session` cookie | Node Auth / Session Probe | 200 OK with authenticated user profile (`userUid`, `role: doctor`, `chamber`) |
| **TEST-P4-04** | `POST /api/auth/logout` invalidates session cookie | Node Auth / Session Invalidation | 200 OK + cookie cleared (`Max-Age=0`), subsequent check 401 |
| **TEST-P4-05** | Repeated failed logins trigger brute-force throttle | Rate Limiter / Brute-Force | 429 `TOO_MANY_REQUESTS` after 5 failed attempts per 15 min |
| **TEST-P4-06** | Distinct session cookies maintain separation (`ms_device_session`, `ms_encounter_session`, `ms_user_session`) | Session Context Isolation | `ms_encounter_session` cannot access clinician routes; `ms_user_session` cannot claim encounter intake |
| **TEST-P4-07** | Patient intake session attempting doctor privilege escalation | RBAC / Escalation Defense | 403 `FORBIDDEN` (role mismatch) |
| **TEST-P4-08** | Passwords, hashes, and salts never appear in API responses or logs | Sensitive Credential Hygiene | Verified JSON payload and sanitized logger exclude `passwordHash` and `salt` |
| **TEST-P4-09** | Mobile lookup returns candidate array with masked demographics and bound `lookupHandle` | Patient Privacy & Anti-Enumeration | 200 OK with masked previews + bound `lookupHandle` (NO raw `patientUid` or `patientId`) |
| **TEST-P4-10** | Mobile lookup for non-existent number returns empty candidates list | Kiosk Lookup Non-Disclosure | 200 OK with `{ found: false, candidates: [] }` |
| **TEST-P4-11** | Shared mobile number creates second legitimate patient without silent merge | Shared Mobile Identity Integrity | 201 Created; two distinct `patientUid` records exist in database |
| **TEST-P4-12** | Shared mobile returns multiple candidates (Patient A and Patient B) in lookup preview | Shared Family Lookup Support | 200 OK with candidates array of masked records (`cand_1`, `cand_2`) |
| **TEST-P4-13** | Explicit candidate selection associates encounter with selected patient | Candidate Disambiguation | 201 Created; server resolves `candidateId -> patientUid` internally; encounter associated with selected patient; raw `patientUid` is NOT returned in HTTP response |
| **TEST-P4-14** | `lookupHandle` successfully creates single-use encounter and is consumed | Lookup Handle Lifecycle | 201 Created + `lookupHandle` invalidated |
| **TEST-P4-15** | Replay of already consumed `lookupHandle` rejected | Lookup Handle Single-Use Invariant | 409 `CONFLICT (HANDLE_ALREADY_CONSUMED)` |
| **TEST-P4-16** | Expired `lookupHandle` (>5 min TTL) rejected | Lookup Handle Expiry Invariant | 403 `FORBIDDEN (HANDLE_EXPIRED)` |
| **TEST-P4-17** | `lookupHandle` presented from different kiosk/session rejected | Kiosk Device Context Binding | 403 `FORBIDDEN (HANDLE_CONTEXT_MISMATCH)` |
| **TEST-P4-18** | Unauthenticated `POST /api/patients` without device or staff session rejected | Registration Authorization Gate | 401 `AUTHENTICATION_REQUIRED` |
| **TEST-P4-19** | Authorized `POST /api/patients` registers patient and returns `registrationHandle` | Dynamic Patient Registration | 201 Created + `registrationHandle` issued (NO raw `patientUid` in response) |
| **TEST-P4-20** | Replay of already consumed `registrationHandle` rejected | Registration Handle Single-Use | 409 `CONFLICT (HANDLE_ALREADY_CONSUMED)` |
| **TEST-P4-21** | Expired `registrationHandle` (>5 min TTL) rejected | Registration Handle Expiry | 403 `FORBIDDEN (HANDLE_EXPIRED)` |
| **TEST-P4-22** | `registrationHandle` presented from different kiosk/user context rejected | Handle Context Binding | 403 `FORBIDDEN (HANDLE_CONTEXT_MISMATCH)` |
| **TEST-P4-23** | New patient encounter creation using valid `registrationHandle` succeeds | New Patient Intake Flow | 201 Created + `ms_encounter_session` issued + handle consumed |
| **TEST-P4-24** | Attempting `POST /api/encounters` with arbitrary raw `patientUid` rejected | Forged UID Injection Defense | 400 `BAD_REQUEST (HANDLE_REQUIRED)` |
| **TEST-P4-25** | Assigned doctor accesses current encounter clinical record | Current Encounter Access | 200 OK allowed (`Encounter.assignedDoctorId === req.user.id`) |
| **TEST-P4-26** | Unassigned doctor attempting to view full clinical record of unclaimed chamber queue encounter receives 403 | Queue Visibility vs Clinical Boundary | 403 `FORBIDDEN (CLINICAL_ACCESS_DENIED)` (queue visibility != clinical record; claim required) |
| **TEST-P4-27** | Doctor claiming waiting encounter in assigned chamber assigns doctor, sets status in_progress, and creates CareRelationship | OPD Chamber Claim Flow | 200 OK + `assignedDoctorId` updated + `ATTENDING_OPD` CareRelationship created (`expiresAt: null`) |
| **TEST-P4-28** | Concurrent duplicate claim race condition rejected via atomic conditional update | Claim Concurrency Protection | 409 `CONFLICT (ENCOUNTER_ALREADY_CLAIMED)` for second claimant |
| **TEST-P4-29** | Doctor with active `CareRelationship` accesses longitudinal patient history | Longitudinal Authorization | 200 OK allowed for historical visits and records |
| **TEST-P4-30** | Doctor without active `CareRelationship` attempting to access historical patient records receives 403 | Longitudinal Access Boundary | 403 `FORBIDDEN (LONGITUDINAL_ACCESS_DENIED)` |
| **TEST-P4-31** | Admin user accesses patient clinical record strictly requiring `X-Admin-Access-Reason` header | Administrative Access Audit | 200 OK allowed (missing header returns 400 `ADMIN_ACCESS_REASON_REQUIRED`; valid header logs `AuditLog` with reason in `metadataJson`) |
| **TEST-P4-32** | Patient intake session attempting cross-patient record access receives 403 | Patient Scope Isolation | 403 `FORBIDDEN (PATIENT_SCOPE_MISMATCH)` |
| **TEST-P4-33** | Cross-origin state-changing `POST` without AJAX header fails CSRF check | Multi-Layer CSRF Defense | 403 `FORBIDDEN (CSRF_VIOLATION)` |
| **TEST-P4-34** | Cross-origin mutating `PUT`, `PATCH`, `DELETE` fails CSRF check | Multi-Layer CSRF Defense | 403 `FORBIDDEN (CSRF_VIOLATION)` |
| **TEST-P4-35** | ABHA entered registers with truthful state machine without synthetic verification | ABHA Truthful State Machine | Database stores `abhaStatus: "not_configured"` and `abhaVerified: false`; entering ABHA identifier does NOT produce `verified`; absence of official credentials results in `not_configured`; no synthetic/fake verification occurs; `abhaVerified` remains false unless `abhaStatus == "verified"`; verified state is possible only from an official ABDM/NHA adapter confirmation (out of scope for Phase 4 live test) |
| **TEST-P4-36** | Consultation completion records `completedAt`, finalizes `CareRelationship.expiresAt = completedAt + 24h`, and logs `AuditLog.actorUserId = req.user.id` | Audit Trail & Lifecycle Finalization | Relational audit link verified + 24h review window assigned |
---

## 15. Regression Tests & Test Runner Scripts

### Scripts Defined in `package.json`:
```json
{
  "scripts": {
    "test:phase2": "node tests/phase2_database.test.js",
    "test:phase3": "node tests/phase3_gateway.test.js",
    "test:phase4": "node tests/phase4_identity.test.js",
    "test:all": "node tests/phase2_database.test.js && node tests/phase3_gateway.test.js && node tests/phase4_identity.test.js"
  }
}
```

### Baseline Regressions:
- `npm run test:phase2`: 13/14 tests pass (1 pending PostgreSQL live infra).
- `npm run test:phase3`: 30/30 tests pass.
- `npm run test:phase4`: 36/36 tests must pass upon Phase 4 execution.
- **No subjective percentage or 100% claims will be made until `npm run test:all` executes and passes.**

---

## 16. Documentation Changes

The following project documents have been updated:
- [docs/PRD.md](file:///f:/SIH/docs/PRD.md): Updated NFR-1 with three session cookies, anti-enumeration, and CareRelationship model.
- [docs/TRD.md](file:///f:/SIH/docs/TRD.md): Added Section 5 detailing session namespaces, async scrypt hashing, and topology-aware cookies.
- [docs/ARCHITECTURE.md](file:///f:/SIH/docs/ARCHITECTURE.md): Added principles for three session namespaces, kiosk context binding, and three-tier clinical access.
- [docs/DATABASE_SCHEMA.md](file:///f:/SIH/docs/DATABASE_SCHEMA.md): Updated `AuditLog` actor model (`USER`, `DEVICE`, `SERVICE`, `SYSTEM`), `CareRelationship` lifecycle, and non-unique `Patient.mobileNumber`.
- [docs/API_CONTRACTS.md](file:///f:/SIH/docs/API_CONTRACTS.md): Updated `POST /api/patients` and `POST /api/encounters` to enforce registration handles and authorization boundaries.
- [docs/PATIENT_IDENTITY.md](file:///f:/SIH/docs/PATIENT_IDENTITY.md): Added registration handle lifecycle, anti-enumeration rules, and candidate selection flows.
- [docs/SECURITY_AND_PRIVACY.md](file:///f:/SIH/docs/SECURITY_AND_PRIVACY.md): Updated anti-enumeration, registration handles, CareRelationship lifecycle, and multi-actor audit model.
- [docs/DEPLOYMENT.md](file:///f:/SIH/docs/DEPLOYMENT.md): Documented cookie and CSRF configurations across development and production topologies.
- [docs/TEST_PLAN.md](file:///f:/SIH/docs/TEST_PLAN.md): Replaced duplicated test plan with single authoritative 36-test matrix.
- [docs/OBSERVABILITY.md](file:///f:/SIH/docs/OBSERVABILITY.md): Updated multi-actor audit log specifications and error telemetry.
- [docs/ERROR_HANDLING.md](file:///f:/SIH/docs/ERROR_HANDLING.md): Registered `HANDLE_CONTEXT_MISMATCH`, `LOOKUP_HANDLE_CONSUMED`, `LOOKUP_HANDLE_EXPIRED`.

---

## 17. Known Risks & Mitigations

1. **Risk: Shared Family Mobile Phone Clashes**
   - *Mitigation*: `mobileNumber` is non-unique. Lookups return candidate arrays. Kiosks require explicit selection or a "Register new patient on this phone" option without silent merging.
2. **Risk: Kiosk Lookup Enumeration Attacks**
   - *Mitigation*: Rate limiting (10 req/min), pre-query regex validation, heavy demographic masking (`R**** K****`), zero clinical history disclosure, and consistent query timing.
3. **Risk: Stolen Registration or Lookup Handles**
   - *Mitigation*: Handles are short-lived (5 min), single-use, and cryptographically bound to the initiating `ms_device_session`. Replays from other terminals are rejected with 403.
4. **Risk: Session Invalidation Across Clustered Gateways**
   - *Mitigation*: Local in-memory session map is explicitly documented as local-only. Distributed Redis/Valkey cluster is mandatory for production horizontal scaling.

---

## 18. Out-of-Scope Items (Strict Phase 4 Invariants)

The following items are strictly deferred to Phase 5 and beyond:
- Dynamic clinical question planner & adaptive AI interview engine
- Real OCR and multi-page document processing workers
- RAG ingestion pipeline & FastAPI Python service
- Multi-patient FAISS index migration & Longitudinal Intelligence UI
- Live NHA ABDM production gateway connection

---

## 19. Success Criteria

Phase 4 implementation will be considered complete and verified when:
1. `npm run test:phase4` executes all 36 tests and all 36 pass.
2. `npm run test:all` executes Phase 2, Phase 3, and Phase 4 suites with 0 regressions.
3. Doctor login, logout, and session verification operate via `ms_user_session` with async `scrypt` password verification.
4. Kiosk mobile lookup returns masked candidates and a bound `lookupHandle` without exposing `patientUid`.
5. New patient registration returns a bound `registrationHandle`, and `POST /api/encounters` creates the visit without the frontend submitting an arbitrary `patientUid`.
6. Unassigned doctors receive `403 CLINICAL_ACCESS_DENIED`; unassigned historical queries receive `403 LONGITUDINAL_ACCESS_DENIED`.
7. Existing MedSync workflows, bilingual audio consent, and `SYN-PAT-001` remain functional.
