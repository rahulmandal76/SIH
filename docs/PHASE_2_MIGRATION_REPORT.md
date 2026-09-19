# Phase 2 Database Migration Report: Flat File to Canonical Relational DB

## Executive Summary
This report documents the execution, verification, and outcomes of the one-time migration from the legacy flat-file store (`Patient-case-taking-software-/server/db.json`) to the canonical relational database architecture (Prisma ORM with SQLite local development & PostgreSQL production target).

---

## 1. Source Verification & Integrity

| Property | Value |
|---|---|
| **Source File** | `f:\SIH\Patient-case-taking-software-\server\db.json` |
| **Source Checksum (SHA-256)** | `B218C3D90451BAD832FCE14C4F726CB65C42AC1F54EC0127248CE80BEBADC9D6` |
| **Source Records Read** | 14 patient queue entries |
| **Backup Verification** | Verified exact match against `Patient-case-taking-software-/server/db.json.bak` |
| **Continuous Dual-Write** | **DISABLED** (Database is canonical runtime authority) |
| **Archive Status** | Original `db.json` preserved intact as legacy audit archive (not deleted) |

---

## 2. Migration Execution Statistics

The one-time migration was executed via `scripts/migrate_db_json.js`:

| Category | Count | Notes |
|---|---|---|
| **Records Read** | **14** | All queue entries from legacy `db.json` |
| **Clinical Users Created** | **1** | Default clinician Dr. K. S. Sharma (`dr.sharma@hospital.gov.in`) |
| **Synthetic Patients Seeded** | **1** | `SYN-PAT-001` (Arjun Mehta) with deterministic canonical UUID |
| **Distinct Patients Identified** | **9** | Resolved from 14 queue records by demographic & identifier grouping |
| **Canonical Patients Created** | **10** | 9 migrated real patients + 1 synthetic patient (`SYN-PAT-001`) |
| **Encounters Created** | **14** | All 14 legacy tokens preserved (120, 119, 118, 113, 112, 111, 110, 109, 108, 107, 106, 101, 102, 103) |
| **Documents Created** | **33** | Extracted diagnostic and clinical lab reports preserved with page citations |
| **Conflicts / Validation Failures** | **0** | All records parsed, sanitized, and stored cleanly |
| **Migration Idempotency** | **VERIFIED** | Second execution resulted in 0 duplicates created |

---

## 3. Patient Identity Mapping & Deduplication Analysis

### The Legacy Problem
In `db.json`, the string `"P-8801"` was indiscriminately assigned across multiple distinct individuals (Ram, Niraj Kumar Mandal, Rahul Verma, Ramesh Sharma, Rahul Kumar, Rahul), while other entries had `patientId: undefined` (Ramesh Kumar, Sushila Devi, Anil Singh). Simultaneously, multiple queue tokens belonged to the same patient (e.g. Ram had tokens 120, 119, 118, 113).

### Canonical Resolution
The migration applied the 2-level identity architecture:
- **`patientUid` (UUID v4)**: Canonical immutable database primary identity & vector index namespace.
- **`patientId` (Alphanumeric)**: Human-readable clinician and patient-facing display key (`PAT-2026-XXXX`).

| Legacy Patient Name | Age/Gender | Legacy Token(s) | Assigned `patientId` | Canonical `patientUid` (UUID v4) | Encounters Linked |
|---|---|---|---|---|---|
| **Arjun Mehta** (Synthetic) | 45 / Male | N/A (AuraHealth) | `SYN-PAT-001` | `00000000-0000-0000-0000-000000000001` | 0 (Vector RAG Scope) |
| **Ram** | 18 / Male | 120, 119, 118, 113 | `PAT-2026-0001` | `06d5ef08-4199-437f-97aa-f7ff459adbac` | 4 (`ENC-2026-0120`, `0119`, `0118`, `0113`) |
| **Niraj Kumar Mandal** | 24 / Male | 112 | `PAT-2026-0002` | `02032fb3-94a5-4ba5-b940-cd2a9e04a429` | 1 (`ENC-2026-0112`) |
| **Rahul Verma** | 22 / Male | 111, 110 | `PAT-2026-0003` | `9314705e-6208-42cb-9c24-3b3f9ef7d004` | 2 (`ENC-2026-0111`, `0110`) |
| **Ramesh Sharma** | 52 / Male | 109 | `PAT-2026-0004` | `b1047cf0-c81d-453a-97fb-cc0a86510942` | 1 (`ENC-2026-0109`) |
| **Rahul Kumar** | 29 / Male | 108, 107 | `PAT-2026-0005` | `610bf71f-4774-436a-8074-b7ca5ea25e09` | 2 (`ENC-2026-0108`, `0107`) |
| **Rahul** | 21 / Male | 106 | `PAT-2026-0006` | `620ae2a8-375e-4cc4-a6a9-dad3891457c9` | 1 (`ENC-2026-0106`) |
| **Ramesh Kumar** | 45 / Male | 101 | `PAT-2026-0007` | `18d1f0c0-7f8d-4b3e-b32f-ff269b34393a` | 1 (`ENC-2026-0101`) |
| **Sushila Devi** | 60 / Female | 102 | `PAT-2026-0008` | `926bacaf-95dd-4c7c-b0c8-2db826c2e7be` | 1 (`ENC-2026-0102`) |
| **Anil Singh** | 38 / Male | 103 | `PAT-2026-0009` | `f09099b1-cc9f-488a-8df8-4ce2d6db135a` | 1 (`ENC-2026-0103`) |

---

## 4. Synthetic Patient (`SYN-PAT-001`) Preservation
- **Identity Stability**: Seeded with deterministic UUID `00000000-0000-0000-0000-000000000001` and display ID `SYN-PAT-001`.
- **Vector Storage Unmodified**: The 15 annual historical clinical files and FAISS indices in `aiml-crash-yash-verma-Aurahealth_final_project` were **NOT** touched, rebuilt, or altered:
  - `vector_index/SYN-PAT-001/chunks.pkl`: Checksum `2998C4342BD6A68378547393D63ADF366068BBAF6332FDE8EF6DE4CD577AFF71` (**MATCH**).
  - `vector_index/SYN-PAT-001/index.faiss`: Checksum `01943874E07F89EBB82148E37C9E6C40E3CF1E2EF74D43C189EAB8E050189527` (**MATCH**).

---

## 5. Rollback Procedure
If database rollback is ever required:
1. Stop the active Express server process:
   ```powershell
   powershell -Command "Stop-Process -Name node -Force"
   ```
2. Restore the original `db.json` from cryptographic backup if corrupted:
   ```powershell
   Copy-Item "Patient-case-taking-software-\server\db.json.bak" "Patient-case-taking-software-\server\db.json" -Force
   ```
3. Remove the local SQLite database file:
   ```powershell
   Remove-Item "prisma\dev.db" -Force
   ```
4. Revert `Patient-case-taking-software-/server.js` using git:
   ```powershell
   git checkout HEAD -- Patient-case-taking-software-/server.js
   ```
5. Restart the server:
   ```powershell
   node Patient-case-taking-software-/server.js
   ```
