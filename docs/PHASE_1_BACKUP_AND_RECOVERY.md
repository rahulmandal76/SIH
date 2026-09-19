# Phase 1: Backup and Disaster Recovery Record

**Date**: 2026-09-19
**Branch**: `integration/phase-1-foundation`
**Base Commit**: `c17de66a489865beaf941eefe633760108550efa`
**Repository**: `https://github.com/rahulmandal76/SIH.git`

---

## 1. Preserved Existing Project Roots

1. **MedSync Kiosk & Doctor Software**:
   - Location: `f:\SIH\Patient-case-taking-software-`
   - State: Preserved in place without moving or destructive alterations.
2. **AuraHealth Nexus Longitudinal RAG Engine**:
   - Location: `f:\SIH\aiml-crash-yash-verma-Aurahealth_final_project (1)\aiml-crash-yash-verma-Aurahealth_final_project`
   - State: Preserved in place without moving or destructive alterations.

---

## 2. Critical Asset Cryptographic Verification (SHA-256)

| Asset | Path | SHA-256 Checksum | Backup Path | Status |
| :--- | :--- | :--- | :--- | :--- |
| **MedSync Database** | `Patient-case-taking-software-/server/db.json` | `B218C3D90451BAD832FCE14C4F726CB65C42AC1F54EC0127248CE80BEBADC9D6` | `.../server/db.json.bak` | Verified Exact Copy |
| **SYN-PAT-001 Chunks** | `.../vector_index/SYN-PAT-001/chunks.pkl` | `2998C4342BD6A68378547393D63ADF366068BBAF6332FDE8EF6DE4CD577AFF71` | `.../chunks.pkl.bak` | Verified Exact Copy |
| **SYN-PAT-001 Index** | `.../vector_index/SYN-PAT-001/index.faiss` | `01943874E07F89EBB82148E37C9E6C40E3CF1E2EF74D43C189EAB8E050189527` | `.../index.faiss.bak` | Verified Exact Copy |
| **Historical Records (15yr)** | `.../SYN-PAT-001_15yr_RAG_medical_history/` | All 15 annual clinical records (2010–2024) | Source folder preserved | Read-only preserved |

---

## 3. Disaster Recovery & Rollback Procedure

If any regression occurs during integration work:

### Procedure A: Restore Single File from Backup
1. **Restore `db.json`**:
   ```powershell
   Copy-Item "Patient-case-taking-software-\server\db.json.bak" -Destination "Patient-case-taking-software-\server\db.json" -Force
   ```
2. **Restore Vector Store**:
   ```powershell
   Copy-Item "aiml-crash-yash-verma-Aurahealth_final_project (1)\aiml-crash-yash-verma-Aurahealth_final_project\vector_index\SYN-PAT-001\*.bak" ...
   ```

### Procedure B: Full Git Rollback to Clean Main
```powershell
git checkout main
git reset --hard c17de66a489865beaf941eefe633760108550efa
```
