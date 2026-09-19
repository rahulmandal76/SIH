# Comprehensive Quality Assurance & Test Plan

## 1. Quality Strategy & Compatibility Standard

Backward compatibility and architectural integrity are evaluated strictly through automated test suites. Subjective percentage claims are discarded. Every critical healthcare workflow, data boundary, and security control is covered by automated unit, integration, and security tests.

---

## 2. Mandatory Test Suites (17 Critical Test Suites)

| Test ID | Test Suite | Description | Target Component |
| :--- | :--- | :--- | :--- |
| **TEST-01** | Prisma Provider Configuration | Asserts that `schema.prisma` and `schema.sqlite.prisma` generate valid ASTs without PostgreSQL-specific decorators in SQLite configs. | Database / Prisma |
| **TEST-02** | PostgreSQL Production Migration | Executes migrations against a test PostgreSQL instance; verifies foreign keys, constraints, and indexes. | Database / PostgreSQL |
| **TEST-03** | SQLite Local Migration | Executes migrations against a local SQLite file; verifies that all models and queries operate identically. | Database / SQLite |
| **TEST-04** | User / Doctor Approval Link | Verifies that `DocumentApproval.approvedByUserId` strictly resolves to a valid `User` record and rejects anonymous approval strings. | Node API / Security |
| **TEST-05** | AuditLog Actor Relational Link | Verifies that `AuditLog.actorUserId` references valid `User.id` and logs action, resourceType, and timestamp. | Node API / Audit |
| **TEST-06** | Consent History & Withdrawal | Asserts that withdrawing a consent record sets `withdrawnAt` without deleting the historical audit record. | Database / Consent |
| **TEST-07** | Document Page Metadata | Asserts that multi-page PDFs decompose into distinct `DocumentPage` records with 1-indexed `pageNumber`. | Ingestion Service |
| **TEST-08** | Page Number Citation Preservation | Verifies that a chunk originating from Page 3 of a document produces a citation with `pageNumber: 3` in the final RAG response. | Python RAG Service |
| **TEST-09** | OCR Provenance Preservation | Verifies that scanned image pages carry `provenance: "OCR_EXTRACTED"` and retain OCR confidence scores. | Ingestion Service |
| **TEST-10** | Processing Job Retry Behavior | Simulates extraction worker timeout; verifies `retryCount` increments and status transitions to `failed` only after 3 retries. | Background Worker |
| **TEST-11** | RAG Ingestion Idempotency | Triggers indexing on the same document twice; asserts chunk count and vector index count do not double. | Python RAG Service |
| **TEST-12** | `patientUid` Vector Path Resolution | Verifies that FAISS indices are written to and loaded from `vector_index/{patientUid}/` where `patientUid` is a valid UUID v4. | Python RAG Service |
| **TEST-13** | Authorization Gate Before RAG Retrieval | Sends request with valid `patientId` but unauthenticated session; asserts API Gateway rejects request with `401 Unauthorized`. | Node API Gateway |
| **TEST-14** | Cross-Patient Isolation Verification | Ingests hypertension records for Patient A and diabetes records for Patient B. Queries Patient A for diabetes; asserts 0 Patient B chunks returned. | Security / RAG Engine |
| **TEST-15** | Concurrent FAISS Write Protection | Dispatches 10 simultaneous ingestion and search requests to the same patient index; verifies file locks prevent corrupt reads or crashes. | Vector Store / FAISS |
| **TEST-16** | Frontend Secret Leakage Scan | Inspects production build output (`dist/`) to verify `VITE_GEMINI_API_KEY` and `GROQ_API_KEY` are absent from bundled JavaScript. | Frontend / Vite |
| **TEST-17** | AI Provider Data-Boundary Enforcement | Intercepts payload sent to Gemini; asserts patient name, phone number, and ABHA ID are redacted. | Node AI Proxy |

---

## 3. Critical End-to-End Acceptance Test (Synthetic Test Flow)

1. **Patient Registration**: Register `Test Patient A` (`PAT-TEST-001`), assign UUID `patientUid`.
2. **Kiosk Intake**: Complete chief complaint ("Headache for 3 days"), test Skip on question 2, edit question 1 answer.
3. **Document Ingestion**: Upload test historical document (PDF, 2 pages, dated 2022).
4. **Doctor Verification**: Doctor logs in (`dr.sharma@hospital.gov.in`), inspects document extraction, clicks `Approve`.
5. **RAG Vector Ingestion**: Verify job executes, vectors added to `vector_index/{patientUid}/index.faiss`.
6. **Doctor Longitudinal Query**:
   - Query: "When was the previous headache episode documented?"
   - Assertion: Answer cites `[Source: test_report.pdf, Page 2 (2022)]`.
7. **No-History Patient Test**:
   - Register `Test Patient B` with no uploaded documents.
   - Query: "What is this patient's historical blood pressure trend?"
   - Assertion: RAG responds explicitly that no historical records exist in the system and references only current intake vitals.

---

## 4. Phase 4 Test Suite: Dynamic Patient Identity, Session Boundaries & Clinical RBAC Matrix

| Test ID | Exact Behavior | Target Component / Boundary | Expected Outcome |
|---|---|---|---|
| **TEST-P4-01** | Doctor login with valid credentials via async `scrypt` | Node Auth / Credentials | 200 OK + `Set-Cookie: ms_user_session=...; HttpOnly; SameSite=...` |
| **TEST-P4-02** | Login with invalid password | Node Auth / Credentials | 401 `AUTHENTICATION_REQUIRED` (generic, timing-safe) |
| **TEST-P4-03** | `GET /api/auth/session` with active `ms_user_session` cookie; verifies approved 8h user TTL (`Max-Age=28800`) | Node Auth / Session Probe | 200 OK with authenticated user profile (`userUid`, `role: doctor`, `chamber`); verified 8h TTL |
| **TEST-P4-04** | `POST /api/auth/logout` invalidates session cookie | Node Auth / Session Invalidation | 200 OK + cookie cleared (`Max-Age=0`), subsequent check 401 |
| **TEST-P4-05** | Repeated failed logins trigger brute-force throttle | Rate Limiter / Brute-Force | 429 `TOO_MANY_REQUESTS` after 5 failed attempts per 15 min |
| **TEST-P4-06** | Distinct session cookies maintain separation (`ms_device_session`, `ms_encounter_session`, `ms_user_session`); verifies approved 24h device TTL (`Max-Age=86400`) | Session Context Isolation | `ms_encounter_session` cannot access clinician routes; `ms_user_session` cannot claim encounter intake; verified 24h device TTL |
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
| **TEST-P4-23** | New patient encounter creation using valid `registrationHandle` succeeds; verifies approved 2h encounter TTL (`Max-Age=7200`) | New Patient Intake Flow | 201 Created + `ms_encounter_session` issued + handle consumed; verified 2h encounter TTL |
| **TEST-P4-24** | Attempting `POST /api/encounters` with arbitrary raw `patientUid` rejected | Forged UID Injection Defense | 400 `BAD_REQUEST (HANDLE_REQUIRED)` |
| **TEST-P4-25** | Assigned doctor accesses current encounter clinical record | Current Encounter Access | 200 OK allowed (`Encounter.assignedDoctorId === req.user.id`) |
| **TEST-P4-26** | Unassigned doctor attempting to view full clinical record of unclaimed chamber queue encounter receives 403 | Queue Visibility vs Clinical Boundary | 403 `FORBIDDEN (CLINICAL_ACCESS_DENIED)` (queue visibility != clinical record; claim required) |
| **TEST-P4-27** | Option B chamber rule: null-chamber encounter rejected with `CHAMBER_ROUTING_REQUIRED`; chambered encounter claimed successfully with `ATTENDING_OPD` CareRelationship created | OPD Chamber Routing (Option B) + Claim Flow | Part A: 403 `CHAMBER_ROUTING_REQUIRED` (null chamber). Part B: 200 OK + `assignedDoctorId` updated + `ATTENDING_OPD` CareRelationship created (`expiresAt: null`) |
| **TEST-P4-28** | Genuine concurrent `Promise.all` duplicate claim race: only one claimant wins the atomic conditional database update; loser receives 409 | Claim Concurrency Protection (Race-Safe) | One 200 OK (winner) + one 409 `ENCOUNTER_ALREADY_CLAIMED` (loser). `P2025` from Prisma is the sole race guard. |
| **TEST-P4-29** | Doctor with active `CareRelationship` accesses longitudinal patient history | Longitudinal Authorization | 200 OK allowed for historical visits and records |
| **TEST-P4-30** | CareRelationship creation authorization & full lifecycle denial boundary: rejects arbitrary doctor delegation (403), creates doctor self-relationship (201), rejects foreign doctor suspend/end (403), validates duplicate lifecycle transitions (409), and denies longitudinal access for unlinked, suspended, and ended states | Longitudinal Lifecycle & Authorization Boundary | 1: no-rel → 403. 2: doctor arbitrary delegation → 403. 3: create → 201 (doctorId: 1). 4: foreign doctor suspend/end → 403. 5: suspend → 200, repeat suspend → 409, suspended access → 403. 6: end → 200 (endedAt set), repeat end → 409, ended access → 403. |
| **TEST-P4-31** | Admin user accesses patient clinical record strictly requiring `X-Admin-Access-Reason` header | Administrative Access Audit | 200 OK allowed (missing header returns 400 `ADMIN_ACCESS_REASON_REQUIRED`; valid header logs `AuditLog` with reason in `metadataJson`) |
| **TEST-P4-32** | Patient intake session attempting cross-patient record access receives 403 | Patient Scope Isolation | 403 `FORBIDDEN (PATIENT_SCOPE_MISMATCH)` |
| **TEST-P4-33** | Cross-origin state-changing `POST` without AJAX header fails CSRF check | Multi-Layer CSRF Defense | 403 `FORBIDDEN (CSRF_VIOLATION)` |
| **TEST-P4-34** | Cross-origin mutating `PUT`, `PATCH`, `DELETE` fails CSRF check | Multi-Layer CSRF Defense | 403 `FORBIDDEN (CSRF_VIOLATION)` |
| **TEST-P4-35** | ABHA entered registers with truthful state machine without synthetic verification | ABHA Truthful State Machine | Database stores `abhaStatus: "not_configured"` and `abhaVerified: false`; entering ABHA identifier does NOT produce `verified`; absence of official credentials results in `not_configured`; no synthetic/fake verification occurs; `abhaVerified` remains false unless `abhaStatus == "verified"`; verified state is possible only from an official ABDM/NHA adapter confirmation (out of scope for Phase 4 live test) |
| **TEST-P4-36** | Consultation completion records `completedAt`, finalizes `CareRelationship.expiresAt = completedAt + 24h`, and logs `AuditLog.actorUserId = req.user.id` | Audit Trail & Lifecycle Finalization | Relational audit link verified + 24h review window assigned |
