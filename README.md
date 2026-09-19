# Unified Healthcare Intelligence Platform
## MedSync + AuraHealth Nexus Integration

A unified clinical intelligence platform combining **MedSync** (kiosk-based clinical intake and doctor OPD workflow) and **AuraHealth Nexus** (longitudinal RAG medical history engine).

---

## 1. Project Overview

- **MedSync**: Interactive clinical self-intake kiosk, bilingual audio consent (Hindi/English), complaint-first interview, document scanning, and physician OPD dashboard.
- **AuraHealth Nexus**: Longitudinal clinical history retrieval engine using dense embeddings (`all-MiniLM-L6-v2`), patient-partitioned FAISS vector store, and Groq LLM grounded generation.

---

## 2. Directory Structure

```
SIH/
├── README.md                                  # Root platform documentation
├── package.json                               # Root workspace dev orchestration
├── .gitignore                                 # Unified repository git ignore
├── .env.example                               # Unified environment configuration template
│
├── docs/                                      # Complete engineering documentation suite
│   ├── PHASE_0_AUDIT.md                       # Technical read-only audit
│   ├── PHASE_1_BACKUP_AND_RECOVERY.md         # Backup records & rollback procedures
│   ├── PHASE_1_CHANGE_REPORT.md               # Change control & test results
│   ├── DECISIONS.md                           # Architecture Decision Records (ADR-001 - 005)
│   ├── PRD.md                                 # Product Requirements Document
│   ├── TRD.md                                 # Technical Requirements Document
│   ├── ARCHITECTURE.md                        # High-level architecture & diagrams
│   ├── DATABASE_SCHEMA.md                     # Canonical database schema & specs
│   ├── PATIENT_IDENTITY.md                    # Dual-identifier & patientUid rules
│   ├── DOCUMENT_PROCESSING.md                 # Document lifecycle & page citations
│   ├── SECURITY_AND_PRIVACY.md                # RBAC, consent & AI data boundaries
│   ├── ABHA_INTEGRATION.md                    # Truthful ABHA readiness & adapter
│   ├── TEST_PLAN.md                           # 17 automated test suites
│   ├── API_CONTRACTS.md                       # REST API contracts
│   ├── AGENT_FLOW.md                          # Clinical intake dialog flow
│   ├── RAG_PIPELINE.md                        # Longitudinal temporal retrieval
│   ├── DEPLOYMENT.md                          # Local dev & cloud deployment guide
│   ├── MIGRATION_PLAN.md                      # One-time db.json migration plan
│   ├── OBSERVABILITY.md                       # Logging, tracing & audit trails
│   ├── ERROR_HANDLING.md                      # Resilience & offline behaviors
│   └── CHANGELOG.md                           # Version changelog
│
├── Patient-case-taking-software-/             # Preserved MedSync project
│   ├── server.js                              # Express API Gateway (:5000)
│   ├── src/                                   # React 19 / Vite Frontend (:5173)
│   └── server/db.json                         # Preserved legacy database
│
└── aiml-crash-yash-verma-Aurahealth_final_project (1)/
    └── aiml-crash-yash-verma-Aurahealth_final_project/ # Preserved AuraHealth project
        ├── app.py                             # Preserved Streamlit Dashboard (:8501)
        ├── rag_pipeline.py                    # Longitudinal RAG engine
        ├── vectorstore.py                     # FAISS IndexFlatIP vector store
        ├── SYN-PAT-001_15yr_RAG_medical_history/ # Preserved 15-year clinical records
        └── vector_index/                      # Preserved vector stores
```

---

## 3. Quick Start (Development)

### Step 1: Environment Setup
Copy the template configuration and supply your API keys:
```bash
cp .env.example .env
```

### Step 2: Running Existing Applications from Root
From the repository root:
- **Run MedSync Web Frontend**:
  ```bash
  npm run dev:web
  ```
- **Run MedSync API Gateway**:
  ```bash
  npm run dev:api
  ```
- **Run AuraHealth Streamlit App**:
  ```bash
  npm run dev:streamlit
  ```

---

## 4. Architectural Rules
1. **Production Database**: PostgreSQL is the canonical production database. SQLite is supported as an explicitly separate local-development configuration.
2. **Persistence Migration**: `server/db.json` will be migrated once into the canonical database during Phase 2. No ongoing dual-write.
3. **Patient Isolation**: Vector indices are partitioned by immutable UUID: `vector_index/{patientUid}/`. Patient isolation is enforced by the application gateway boundary before retrieval.
4. **Information Provenance**: All clinical data maintains explicit provenance (`PATIENT_REPORTED`, `DOCUMENT_EXTRACTED`, `DOCTOR_APPROVED`, etc.).
5. **AI Data Governance**: No frontend secret exposure. Patient PII is redacted prior to cloud AI inference.