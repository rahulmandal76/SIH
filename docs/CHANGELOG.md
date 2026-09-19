# Changelog & Version History

## [Phase 4 Plan] — 2026-09-19: Patient Registration + Mobile/ABHA Readiness Specification

### Added
- **Revised Phase 4 Architecture Specification**: Non-unique mobile numbers (supporting shared family phones), privacy-preserving patient lookup via short-lived `lookupHandle` without revealing `patientUid`, doctor-to-patient authorization via `assignedDoctorId`, three distinct session contexts (kiosk device, patient encounter, doctor user), HttpOnly cookie hardening, multi-layer CSRF defense, and failed login throttling.
- **ABHA Verification State Machine**: Formalized explicit status lifecycle (`entered`, `lookup_pending`, `verified`, `verification_failed`, `not_configured`, `unavailable`) with truthfulness guarantees and `AbdmIntegrationAdapter` boundary.
- **Phase 4 Test Suite Specification (TEST-P4-01 to TEST-P4-31)**: Comprehensive 31-test matrix covering authentication, RBAC, doctor-patient assignment, shared mobile numbers, CSRF protection, and audit attribution.
- Created `docs/PHASE_4_IMPLEMENTATION_PLAN.md` and updated full documentation suite.

---

## [Phase 3.1 Patch] — 2026-09-19: Phase 3 Security Hardening (Patient-Level Authorization)

### Added
- **Patient-Level Authorization Boundary**: Ephemeral `kioskSessionToken` issued upon `POST /api/intake` and bound to the specific `patientUid`.
- **`X-Kiosk-Session` Header Enforcement**: Required on `POST /api/ai/intake-question` whenever `patientUid` is supplied.
- **Cross-Patient Scope Protection**: Session for Patient A requesting Patient B returns `403 FORBIDDEN` (`PATIENT_SCOPE_MISMATCH`).
- **Unauthenticated Patient-Scope Gate**: Request with `patientUid` but no session returns `401 AUTHENTICATION_REQUIRED` (existence in DB does not grant access).
- **Tests TEST-P3-27 through TEST-P3-30**: Added to `tests/phase3_gateway.test.js` (cross-patient scope mismatch, bidirectional scope checks, authenticated access, unauthenticated rejection). Test suite now at **30/30 PASS**.

### Changed
- `Patient-case-taking-software-/server.js`: Added `validateKioskSession`, session token generation in `/api/intake`, and patient-scope authorization gate in `/api/ai/intake-question`.
- `Patient-case-taking-software-/src/context/DemoContext.jsx`: Captured and persisted `kioskSessionToken` across intake calls.
- `Patient-case-taking-software-/src/pages/AIInterviewPage.jsx`: Passed `X-Kiosk-Session` header on AI proxy calls.
- `docs/SECURITY_AND_PRIVACY.md`, `docs/API_CONTRACTS.md`, `docs/OBSERVABILITY.md`, `docs/ERROR_HANDLING.md`: Clearly distinguished **Patient Existence Check** from **Patient Authorization**.
- `docs/PHASE_3_CHANGE_REPORT.md`: Updated with 30/30 test matrix and hardened rollback procedure.

### Security
- **Rollback Policy Hardened**: Explicitly documented that client-side `VITE_GEMINI_API_KEY` restoration is a critical vulnerability. Safe rollback reverts to backend-proxy state or disables AI endpoint without exposing browser keys. Key revocation required if old keys ever leaked.

---

## [Phase 3] — 2026-09-19: Node API Gateway + Secure AI Proxy

### Added
- `POST /api/ai/intake-question` — Secure Gemini proxy endpoint with multi-model fallback, 5.5 s timeout, and honest failure codes.
- Zod request validation on all AI endpoint fields (patientMessage, conversationHistory, stepIndex, language, patientAge, patientGender, patientUid).
- PatientUid DB-existence check — unknown UID returns 403 FORBIDDEN.
- Rate limiter: 30 AI requests per 10-minute window per terminal IP.
- Structured JSON request logger with `requestId` (UUID v4) on every response (`X-Request-Id` header).
- Consistent error response shape `{ error: { code, message, requestId } }` across all endpoints.
- `POST /api/rag/query` Phase 5 stub (501 NOT_IMPLEMENTED — no fake data).
- `SYSTEM_PROMPT` migrated to server.js (no longer in browser bundle).
- AI data minimization DTO in `buildGeminiPayload` — name/phone/ABHA explicitly excluded.
- Prompt-injection boundary: patient text placed in `role: "user"` turns only.
- Root `.env` with `GEMINI_API_KEY` (server-side only).
- `@google/generative-ai`, `zod`, `dotenv` added to root `package.json`.
- `tests/phase3_gateway.test.js` — Phase 3 matrix.
- `docs/PHASE_3_CHANGE_REPORT.md`, updated documentation suite.

### Changed
- `AIInterviewPage.jsx` — removed `@google/generative-ai` browser import; `fetchAIResponse` now calls `/api/ai/intake-question`. Badge changed from "Gemini Active" to "AI Assisted".
- `Patient-case-taking-software-/.env` — removed `VITE_GEMINI_API_KEY`.
- `Patient-case-taking-software-/server.js` — added dotenv loading, request logger, rate limiter, Zod validation, AI proxy endpoint; all Phase 2 routes preserved.

### Security
- **GEMINI_API_KEY removed from browser bundle** — verified by TEST-P3-19 (4 bundle files scanned, key absent).
- **VITE_GEMINI_API_KEY removed from frontend .env** — verified by TEST-P3-20.
- **API key never in any response or log** — verified by TEST-P3-18.

---

## [Phase 2] — 2026-09-18: Database Architecture + Dynamic Patient Identity

### Added
- Canonical relational database via Prisma 7 with `@prisma/adapter-better-sqlite3`.
- PostgreSQL production schema (`prisma/schema.prisma`).
- SQLite local development schema (`prisma/schema.sqlite.prisma`).
- One-time migration of 14 legacy `server/db.json` patients.
- Immutable `patientUid` (UUID) + human-readable `patientId` (`PAT-YYYY-NNNN`).
- `Encounter`, `Document`, `User`, `PatientConsent`, `AuditLog`, `DocumentPage` models.
- `prisma/db.js` provider abstraction with driver adapters.
- `tests/phase2_database.test.js` — 14-test Phase 2 matrix (13/14 PASS, 1 PENDING INFRA).
- `docs/PHASE_2_CHANGE_REPORT.md`, `docs/PHASE_2_MIGRATION_REPORT.md`.

### Changed
- `Patient-case-taking-software-/server.js` — completely refactored to read/write from Prisma DB only; `server/db.json` archived.
- `package.json` (root) — added Prisma 7 dependencies.

---

## [Phase 1] — 2026-09-18: Foundation & Architecture

### Added
- Phase 0 Read-Only Technical Audit (`docs/PHASE_0_AUDIT.md`).
- Architecture Decision Records ADR-001 through ADR-005 (`docs/DECISIONS.md`).
- Canonical Database Schema Specification with dual-provider strategy (`docs/DATABASE_SCHEMA.md`).
- Patient Identity Architecture establishing `patientUid` vector storage (`docs/PATIENT_IDENTITY.md`).
- Document Processing Lifecycle & Page-aware Citation Pipeline (`docs/DOCUMENT_PROCESSING.md`).
- Security, Privacy & Consent Model (`docs/SECURITY_AND_PRIVACY.md`).
- ABHA Integration Readiness Framework (`docs/ABHA_INTEGRATION.md`).
- Comprehensive 17-Suite Test Plan (`docs/TEST_PLAN.md`).
- Engineering Documentation Suite (PRD, TRD, ARCHITECTURE, API_CONTRACTS, AGENT_FLOW, RAG_PIPELINE, DEPLOYMENT, MIGRATION_PLAN, OBSERVABILITY, ERROR_HANDLING).

### Changed
- Decoupled `patientUid` (UUID) for vector index namespace from human-readable `patientId`.
- Replaced provider-specific JSONB assumptions with provider-neutral Prisma definitions.
- Discarded continuous dual-write synchronization in favor of a one-time migration from `db.json`.
- Clarified FAISS application-boundary isolation and added process-level concurrency locking.
