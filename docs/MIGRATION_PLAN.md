# Migration Plan: Flat Persistence to Canonical Relational DB

## 1. Migration Overview

The existing MedSync application persists state in a single flat file (`Patient-case-taking-software-/server/db.json`). This file must be migrated **once** into the canonical relational database.

---

## 2. One-Time Migration Script (`scripts/migrate_db_json.js`)

1. **Step 1: File Backup**:
   Create a verified backup: `server/db.json.bak`.
2. **Step 2: Synthetic Patient Seed**:
   Seed `SYN-PAT-001` (Arjun Mehta) with deterministic canonical UUID:
   `patientUid: "00000000-0000-0000-0000-000000000001"`.
3. **Step 3: Patient Records Ingestion**:
   Iterate through `db.json.patients`:
   - Generate immutable `patientUid` (UUID v4) for each distinct patient.
   - Insert canonical `Patient` records.
   - Insert `Encounter` records preserving token numbers, chief complaints, vitals, and doctor notes.
4. **Step 4: Cutover & Archive**:
   Verify record count equality. Archive `db.json`.
   **Dual-write is disabled**: Express endpoints switch exclusively to Prisma Client queries.
