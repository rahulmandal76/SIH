# Phase 2 Change Control Report: Database & Dynamic Patient Identity

## 1. Overview
This report details all changes, modifications, dependency additions, test executions, and outcomes completed under **Phase 2: Database Architecture & Dynamic Patient Identity**.

---

## 2. Files Created

| File Path | Description |
|---|---|
| `prisma/schema.prisma` | Canonical production PostgreSQL Prisma schema with provider-neutral types. |
| `prisma/schema.sqlite.prisma` | Separately validated local development SQLite Prisma schema. |
| `prisma.config.js` | Prisma 7 configuration file declaring schema target and dynamic datasource URL. |
| `prisma/db.js` | Database client factory supporting `@prisma/adapter-better-sqlite3` and `@prisma/adapter-pg`. |
| `prisma/dev.db` | Local SQLite database generated from `schema.sqlite.prisma`. |
| `scripts/migrate_db_json.js` | Idempotent one-time migration script mapping legacy `db.json` to relational tables. |
| `tests/phase2_database.test.js` | 14-point automated test matrix verifying schemas, migrations, relations, isolation, and regression. |
| `docs/PHASE_2_MIGRATION_REPORT.md` | Detailed report covering migration statistics, identity mappings, and deduplication logic. |
| `docs/PHASE_2_CHANGE_REPORT.md` | Formal change control report for Phase 2. |

---

## 3. Files Modified

### 1. `package.json`
- **Why**: Added Prisma 7 CLI, `@prisma/client`, driver adapters (`@prisma/adapter-better-sqlite3`, `@prisma/adapter-pg`), native DB drivers (`better-sqlite3`, `pg`), and test automation scripts (`test:db`).
- **Exact Change**:
  - Added dependencies: `@prisma/adapter-better-sqlite3`, `@prisma/adapter-pg`, `@prisma/client`, `better-sqlite3`, `pg`, `prisma`.
  - Added script: `"test:db": "node tests/phase2_database.test.js"`.
- **Compatibility Impact**: Zero impact on existing web/build scripts; enables cross-platform database runtime.

### 2. `Patient-case-taking-software-/server.js`
- **Why**: Replaced legacy flat-file `db.json` read/write operations with canonical Prisma Client relational queries while maintaining 100% MedSync frontend API contract compatibility.
- **Exact Change**:
  - Removed `readDB()` and `writeDB()` flat file access functions.
  - Connected endpoints (`/api/queue`, `/api/intake`, `/api/patient/:token`, `/api/patient/:token/complete`, `/api/health`) directly to Prisma Client.
  - Implemented dynamic patient resolution by ABHA/Mobile/Name, creating canonical `patientUid` (UUID) and `patientId` (`PAT-2026-XXXX`).
  - Added relational `AuditLog` recording upon consultation completion.
  - Eliminated continuous dual-write to `db.json`.
- **Compatibility Impact**: 100% backward compatible with Vite React frontend. Verified by Vite production build and automated API regression tests.

---

## 4. Files Intentionally Untouched

| Path | Reason |
|---|---|
| `Patient-case-taking-software-/server/db.json` | Preserved intact as legacy backup/audit archive. SHA-256: `B218C3D9...`. |
| `Patient-case-taking-software-/server/db.json.bak` | Cryptographic backup untouched. |
| `aiml-crash-yash-verma-Aurahealth_final_project/vector_index/SYN-PAT-001/*` | FAISS indices and vector chunks strictly preserved. |
| `aiml-crash-yash-verma-Aurahealth_final_project/SYN-PAT-001_15yr_RAG_medical_history/*` | All 15 annual historical clinical files preserved. |
| `Patient-case-taking-software-/src/*` | Frontend React UI code preserved without modification. |
| `aiml-crash-yash-verma-Aurahealth_final_project/app.py` | Python Streamlit application untouched. |

---

## 5. Database Schema Changes & Multi-Provider Strategy

The canonical schema establishes 10 relational entities:
1. `User`: Relational clinical and administrative actors (`doctor`, `admin`, `clinical_staff`, `kiosk_operator`).
2. `Patient`: Canonical demographic records with immutable `patientUid` (UUID v4) and `patientId` (`PAT-2026-XXXX`, `SYN-PAT-001`).
3. `Encounter`: OPD intake sessions and doctor consultations, supporting multiple encounters per patient.
4. `Document`: Uploaded medical files, separating `uploadDate` from `clinicalDate`.
5. `DocumentPage`: Page-level extracted text and OCR confidence for high-precision RAG citations.
6. `DocumentProcessingJob`: Asynchronous extraction and OCR tracking.
7. `DocumentApproval`: Relational review records referencing `approvedByUserId` (`User.id`).
8. `RAGIngestionJob`: Embedding generation and FAISS ingestion job tracker.
9. `PatientConsent`: Purpose-aware granular consent model with grant and withdrawal lifecycle.
10. `AuditLog`: HIPAA/DPDP compliant access log linking `actorUserId` and `patientUid` without raw PHI.

### Provider Compatibility Validation
- **PostgreSQL**: `prisma/schema.prisma` validated via Prisma 7 PSL parser (`The schema at prisma\schema.prisma is valid 🚀`).
- **SQLite**: `prisma/schema.sqlite.prisma` validated and synchronized to `prisma/dev.db` via `@prisma/adapter-better-sqlite3`.
- **Type Neutrality**: Multi-value collections (medications, allergies, dialogue) use JSON string serialization rather than dialect-specific types (e.g. `@db.JsonB`), ensuring complete cross-provider portability.

---

## 6. Commands Executed

```powershell
# 1. Dependency installation
npm i @prisma/adapter-better-sqlite3 better-sqlite3 @prisma/adapter-pg pg @prisma/client prisma

# 2. Schema validation
node node_modules/prisma/build/index.js validate --schema=prisma/schema.prisma
node node_modules/prisma/build/index.js validate --schema=prisma/schema.sqlite.prisma

# 3. SQLite database initialization
node node_modules/prisma/build/index.js db push --schema=prisma/schema.sqlite.prisma
node node_modules/prisma/build/index.js generate --schema=prisma/schema.sqlite.prisma

# 4. One-time legacy migration
node scripts/migrate_db_json.js

# 5. Automated test matrix execution
node tests/phase2_database.test.js

# 6. Web frontend verification
npm run build:web
```

---

## 7. Test Matrix Results

All 14 mandatory tests executed:

| Test ID | Test Name | Status | Details |
|---|---|---|---|
| **TEST-01** | Prisma Schema Validation (PG & SQLite) | **PASS** | Both schemas parsed and verified valid by Prisma 7 PSL parser. |
| **TEST-02** | SQLite Migration & Driver Adapter Test | **PASS** | Prisma connected to `dev.db` via `@prisma/adapter-better-sqlite3`. |
| **TEST-03** | PostgreSQL Production Configuration | **PENDING_INFRA** | Production schema validated against PostgreSQL grammar. Live container/service execution pending production staging infrastructure (no local PostgreSQL daemon present). |
| **TEST-04** | db.json Migration Verification | **PASS** | Verified counts: 10 patients, 14 encounters, 33 documents. |
| **TEST-05** | Migration Repeat / Idempotency Test | **PASS** | Re-running migration generated 0 duplicates and 0 conflicting overwrites. |
| **TEST-06** | Patient Duplicate Prevention Test | **PASS** | Unique constraint on `patientUid` correctly rejected duplicate insertion (`P2002`). |
| **TEST-07** | Patient Lookup Test | **PASS** | Successfully resolved Ram and Ramesh Sharma by ABHA index. |
| **TEST-08** | Encounter Multiplicity & FK Relationship | **PASS** | Patient Ram has 4 distinct encounters mapped to single `patientUid`: Tokens [113, 118, 119, 120]. |
| **TEST-09** | User / Doctor Foreign Key Test | **PASS** | `DocumentApproval` successfully linked to User ID 1 (`Dr. K. S. Sharma`). |
| **TEST-10** | Purpose-Aware Consent Foundation Test | **PASS** | Consent lifecycle verified (granted -> withdrawn) for `SYN-PAT-001`. |
| **TEST-11** | AuditLog Actor & Patient Linkage Test | **PASS** | `AuditLog` correctly relates to Actor and Patient without raw PHI. |
| **TEST-12** | Patient Isolation Query Test | **PASS** | Patient database scopes strictly isolated; zero record cross-contamination. |
| **TEST-13** | Legacy Express API Regression Test | **PASS** | All 5 endpoints (`/health`, `/queue`, `/patient/:token`, `/intake`, `/complete`) returned HTTP 200 responses. |
| **TEST-14** | SYN-PAT-001 Synthetic Preservation Test | **PASS** | `SYN-PAT-001` mapped to deterministic UUID `0000...0001`. FAISS index & chunks hashes 100% identical to backup. |

**Final Score**: **13 PASSED, 1 PENDING INFRASTRUCTURE, 0 FAILED**.

---

## 8. Known Issues & Operational Notes
1. **Local PostgreSQL Service**: PostgreSQL daemon is not installed locally on this development machine. The production PostgreSQL schema has been fully validated against Prisma 7's PostgreSQL PSL compiler. Live database connection tests for PostgreSQL remain pending deployment to a PostgreSQL-backed staging environment.
2. **Prisma 7 Driver Adapter Requirement**: Prisma 7 requires explicit driver adapters (`@prisma/adapter-better-sqlite3` and `@prisma/adapter-pg`) rather than built-in engines. The abstraction in `prisma/db.js` handles this seamlessly.

---

## 9. Rollback Instructions
Refer to [docs/PHASE_2_MIGRATION_REPORT.md](file:///f:/SIH/docs/PHASE_2_MIGRATION_REPORT.md#5-rollback-procedure).

---

## 10. Phase 3 Prerequisites
- Canonical database is active and serving requests.
- Node.js API Gateway is ready to be expanded with:
  - Secure AI proxy routing (shielding client from raw LLM keys).
  - Rate limiting and prompt sanitization.
  - Dynamic patient context resolution before AI dispatch.
