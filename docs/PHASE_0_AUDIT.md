# PHASE 0: READ-ONLY TECHNICAL AUDIT REPORT (REVISED)

**Projects Audited**:
1. `MedSync` (`Patient-case-taking-software-`)
2. `AuraHealth Nexus` (`aiml-crash-yash-verma-Aurahealth_final_project (1)/aiml-crash-yash-verma-Aurahealth_final_project`)

**Repository Root**: `f:\SIH`
**Audit Date**: 2026-09-19
**Audit Mode**: Read-Only Inspection

---

## 1. Executive Summary & Inventory

| Component | Current Stack | Key Files | Audit Status |
| :--- | :--- | :--- | :--- |
| **MedSync Frontend** | React 19.3.0, Vite 8.3.0, Tailwind CSS v4, Lucide React, jsPDF | `src/App.jsx`, `src/AppContent.jsx`, `src/context/DemoContext.jsx`, `src/pages/*.jsx` | Working kiosk & doctor UX; client-side Gemini calls need backend proxying. |
| **MedSync Backend** | Node.js v22.14 / Express 5.2.1, CORS, Port 5000 | `server.js`, `server/db.json` | Flat JSON file persistence; queue & intake routes work. Needs migration to canonical relational database. |
| **AuraHealth RAG** | Python 3.13.3, Streamlit, FAISS CPU, MiniLM-L6-v2 (384-dim), Groq LLM | `app.py`, `rag_pipeline.py`, `vectorstore.py`, `loader.py`, `chunker.py`, `generator.py` | Working longitudinal RAG pipeline; hardcoded single patient (`SYN-PAT-001`). Needs multi-patient scoping and service wrapping. |
| **Persistence** | Flat JSON (`server/db.json`) + Local filesystem (`vector_index/`) | `server/db.json`, `chunks.pkl`, `index.faiss` | Lacks ACID transactional DB; no Postgres or Docker running natively on Windows host. |

---

## 2. In-Depth Evaluation of the 30 Audit Points

### Point 1: Repository Structure
- **Inspected Files**: `f:\SIH`, `Patient-case-taking-software-`, `aiml-crash-yash-verma-Aurahealth_final_project (1)/aiml-crash-yash-verma-Aurahealth_final_project`
- **Existing Behavior**: Two loosely coupled subdirectories in a single git repository (`https://github.com/rahulmandal76/SIH.git`). Node modules and Python venvs are isolated within each folder.
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**: Introduce a unified root `package.json` with workspace orchestrator scripts (`npm run dev:all`) while keeping existing folder structures intact to avoid breaking relative paths.
- **Verification Criterion**: Verification through automated dev-startup checks and path-resolution smoke tests.

### Point 2: Frontend Architecture
- **Inspected Files**: `src/App.jsx`, `src/AppContent.jsx`, `vite.config.js`
- **Existing Behavior**: Single-page application using React 19.3.0 and Vite 8.3.0. Navigation is state-driven via `activeTab` inside `AppContent.jsx` rather than `react-router`.
- **Classification**: **KEEP AS-IS**
- **Proposed Change**: Retain the clean tab-driven architecture. Add `longitudinal` tab in `AppContent.jsx` and embed AuraHealth RAG inside `DoctorDashboardPage.jsx`.
- **Verification Criterion**: Regression tests verifying that all existing tab navigations render without unhandled exceptions.

### Point 3: Backend Architecture
- **Inspected Files**: `Patient-case-taking-software-/server.js`
- **Existing Behavior**: Standalone Express 5.2.1 application on port 5000 with CORS enabled and body JSON parsing. Reads and writes directly to `server/db.json`.
- **Classification**: **WRAP WITH NEW SERVICE**
- **Proposed Change**: Retain `server.js` as the primary API Gateway. Modularize routes into controllers/services (`/api/queue`, `/api/intake`, `/api/patients`, `/api/documents`, `/api/rag`) and proxy RAG calls to Python service.
- **Verification Criterion**: API contract integration tests matching existing response schemas.

### Point 4: Existing API Endpoints
- **Inspected Files**: `server.js`
- **Existing Behavior**:
  - `GET /api/queue` — Returns normalized patient list from `db.json`.
  - `POST /api/intake` — Appends or updates patient by `token`.
  - `PUT /api/patient/:token/complete` — Updates status and doctor notes.
  - `GET /api/patient/:token` — Fetches patient by token.
  - `GET /api/health` — Health check endpoint.
- **Classification**: **KEEP AS-IS (EXTEND ADDITIVELY)**
- **Proposed Change**: Preserve all existing endpoints without breaking schemas. Add versioned endpoints (`/api/v1/patients`, `/api/v1/documents`, `/api/v1/rag`).
- **Verification Criterion**: End-to-end HTTP integration tests comparing legacy endpoint outputs with canonical database responses.

### Point 5: Existing State Management
- **Inspected Files**: `src/context/DemoContext.jsx`
- **Existing Behavior**: Single React Context managing `activeTab`, `userRole`, `patientData`, `activeQueue`, `scannedDocs`, `patientConversation`, `latestToken`, and `activeScannedDoc` with `localStorage` synchronization.
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**: Maintain `DemoContext` as the global state orchestrator. Add states for `selectedPatientId`, `activeRAGHistory`, and `documentProcessingStatus`.
- **Verification Criterion**: React component tests verifying state updates across roles and tab switches.

### Point 6: Existing Patient Identity Flow
- **Inspected Files**: `src/pages/PatientAuth.jsx`, `src/context/DemoContext.jsx`, `server.js`
- **Existing Behavior**: Generates token numbers (`105`, `106`, etc.) and uses synthetic IDs (`P-8801`). ABHA ID defaults to `"91-1123-8822-7711"`. No real deduplication or patient database lookup.
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**: Implement dual-layer identifier: system `patient_uid` (UUID) + human-friendly `patient_id` (`PAT-YYYY-XXXX`). Support dynamic mobile and ABHA lookup with existing patient auto-fill.
- **Verification Criterion**: Unit tests for patient lookup by mobile/ABHA, duplicate creation prevention, and encounter linkage.

### Point 7: Existing Intake Questionnaire Flow
- **Inspected Files**: `src/pages/AIInterviewPage.jsx`, `src/utils/clinicalDialogEngine.js`
- **Existing Behavior**: 6-step sequential intake (`CLINICAL_STEPS`). Checks red flags (chest, breathlessness) and queries Gemini with fallback to `clinicalDialogEngine.js`.
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**: Upgrade to a dynamic adaptive question planner. Eliminate repetitive questions, support explicit Skip / "I don't know", and produce structured JSON output.
- **Verification Criterion**: Clinical dialog simulation tests verifying no repeat questions and proper red-flag escalation triggers.

### Point 8: Existing Document Upload Flow
- **Inspected Files**: `src/pages/DocumentScannerPage.jsx`
- **Existing Behavior**: Camera capture via WebRTC and file input via `<input type="file">`. Runs simulated `setTimeout` progress bar attaching `mockSampleDocuments[0]`.
- **Classification**: **WRAP WITH NEW SERVICE**
- **Proposed Change**: Retain UI, but connect upload handler to backend `POST /api/documents/upload` using `multipart/form-data`. Store original file on disk and record metadata.
- **Verification Criterion**: File upload integration tests asserting file persistence on disk and metadata creation in database.

### Point 9: Existing OCR Implementation or Simulation
- **Inspected Files**: `src/pages/DocumentScannerPage.jsx`, `src/pages/OCRResultsPage.jsx`
- **Existing Behavior**: Currently simulated in frontend via timer milestones (35%, 68%, 90%, 100%) loading mock extracted medications and vitals.
- **Classification**: **WRAP WITH NEW SERVICE**
- **Proposed Change**: Connect to backend extraction service (using Python `pypdf`, `python-docx` for digital files, and OCR engine where binaries exist). Display truthful processing statuses (`Extracting`, `Ready`, `Failed`).
- **Verification Criterion**: Document extraction tests validating text output from `.pdf`, `.docx`, and fallback error handling when OCR binaries are uninstalled.

### Point 10: Existing PDF Generation
- **Inspected Files**: `src/utils/pdfGenerator.js`, `src/pages/ClinicalSummaryPage.jsx`
- **Existing Behavior**: High-quality client-side PDF generation using `jspdf` formatting bilingual hospital OPD case summaries with QR codes and vitals.
- **Classification**: **KEEP AS-IS**
- **Proposed Change**: Keep `pdfGenerator.js` intact; extend to include RAG summary citations where available.
- **Verification Criterion**: Unit tests verifying PDF document structure and successful binary output generation.

### Point 11: Existing Doctor Dashboard
- **Inspected Files**: `src/pages/DoctorDashboardPage.jsx`
- **Existing Behavior**: Comprehensive doctor interface with sidebar tabs (`queue`, `history`, `documents`, `settings`), patient details panel, triage priority alerts, vitals display, and consultation completion.
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**: Add a dedicated "Longitudinal Intelligence (AuraHealth RAG)" panel tab alongside "Case Summary" and "Chat History".
- **Verification Criterion**: UI tests verifying doctor patient selection, queue filtering, consultation completion, and RAG panel loading.

### Point 12: Existing Queue and Consultation Lifecycle
- **Inspected Files**: `server.js`, `DoctorDashboardPage.jsx`, `DemoContext.jsx`
- **Existing Behavior**: Queue items have status `waiting` -> `in_progress` -> `completed`. Completed items save `doctorNotes` and `completedAt`.
- **Classification**: **KEEP AS-IS**
- **Proposed Change**: Retain existing state transitions and endpoints; synchronize with relational database.
- **Verification Criterion**: Status transition tests asserting state changes from `waiting` to `completed` persist in canonical database.

### Point 13: Existing AI Provider Calls & Data Governance
- **Inspected Files**: `src/pages/AIInterviewPage.jsx` (`@google/generative-ai`), `aiml-crash-yash-verma-Aurahealth_final_project/generator.py` (Groq API)
- **Existing Behavior**:
  - MedSync calls Google Gemini directly in browser via `import.meta.env.VITE_GEMINI_API_KEY`.
  - AuraHealth calls Groq API via Python `requests` using `GROQ_API_KEY`.
- **Classification**: **WRAP WITH NEW SERVICE**
- **Data Governance Strategy**:
  - **Gemini (Intake Questions)**: Receives current patient complaint, immediate symptom answers, language, and age. Does NOT receive historical documents, full historical medical records, or government ID numbers.
  - **Groq (Longitudinal RAG)**: Receives retrieved medical history text chunks, document excerpts, current encounter summary, and doctor's clinical query.
  - **Provider Boundaries**: All AI calls routed through backend microservices (Node API for Gemini, FastAPI for Groq) with secret isolation. No API keys in browser bundles.
  - **Production Approval Requirement**: Requires clinical safety signoff, Business Associate Agreement (BAA) / DPDP / ABDM compliance agreement with AI vendors, and explicit patient consent prior to cloud AI transmission in production.
- **Verification Criterion**: Network inspection tests verifying zero client-side external AI requests and secret-free frontend bundles.

### Point 14: Existing Fallback Clinical Logic
- **Inspected Files**: `src/utils/clinicalDialogEngine.js`
- **Existing Behavior**: 265 lines of heuristics in Hindi/Hinglish handling chest pain, abdominal pain, respiratory issues, fever, and reassurance.
- **Classification**: **KEEP AS-IS**
- **Proposed Change**: Keep `clinicalDialogEngine.js` as the resilient offline/no-LLM fallback.
- **Verification Criterion**: Jest/Vitest unit tests asserting exact keyword matching and fallback response structures.

### Point 15: Existing Database/Mock Persistence & One-Time Migration
- **Inspected Files**: `server/db.json`
- **Existing Behavior**: Single JSON file storing 1299 lines of patient queue items. Read and written synchronously with `fs.readFileSync` / `fs.writeFileSync`.
- **Classification**: **MODIFY MINIMALLY**
- **Migration & Persistence Rule**:
  - **Provider-Neutral Schema**: Prisma schema using standard SQLite/PostgreSQL compatible types (avoiding PostgreSQL-specific `@db.JsonB` or raw dialect types). Text/JSON stored via standard Prisma `Json` or stringified serializations verified across both SQLite and PostgreSQL.
  - **One-Time Migration**: Migrate `server/db.json` ONCE into the canonical database using an automated script (`scripts/migrate_db_json.js`).
  - **NO Continuous Dual-Write**: Once migrated, the canonical database becomes the sole source of truth; `server/db.json` is archived and not continuously dual-written.
- **Verification Criterion**: Migration verification script validating record count, patient IDs, encounter tokens, and field integrity before and after migration.

### Point 16: Existing AuraHealth Ingestion Pipeline
- **Inspected Files**: `aiml-crash-yash-verma-Aurahealth_final_project/app.py`, `rag_pipeline.py`
- **Existing Behavior**: Triggered via Streamlit file uploader button `⚡ Ingest & Update Patient Index`. Reads files into `data_dir`, invokes `pipeline.index(force_rebuild=True)`.
- **Classification**: **WRAP WITH NEW SERVICE**
- **Proposed Change**: Expose ingestion via FastAPI endpoint `POST /rag/ingest-file` and `POST /rag/ingest-text`, called automatically by Node API when MedSync documents or intakes are finalized.
- **Verification Criterion**: End-to-end ingestion test verifying text extraction, chunking, and index persistence upon API trigger.

### Point 17: Existing Loader Behavior
- **Inspected Files**: `aiml-crash-yash-verma-Aurahealth_final_project/loader.py`
- **Existing Behavior**: Parses `.txt`, `.pdf`, `.docx`. Extracts year and patient ID using regex on filenames or header text (`SYN-PAT-\d+`).
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**: Generalize regex and accept explicit `patient_id` parameter instead of defaulting to `"SYN-PAT-001"`. Preserve page numbers for PDF documents.
- **Verification Criterion**: Unit tests with sample `.txt`, `.pdf`, `.docx` files asserting correct metadata dictionary outputs.

### Point 18: Existing Chunking Strategy
- **Inspected Files**: `aiml-crash-yash-verma-Aurahealth_final_project/chunker.py`
- **Existing Behavior**: Splits by double newlines into 800-character chunks with 120-character sliding-window overlap. Prepends `[patient_id | Year: year]`.
- **Classification**: **KEEP AS-IS**
- **Proposed Change**: Retain 800/120 chunking parameters. Add `page_number` and `provenance` into chunk metadata.
- **Verification Criterion**: Chunker tests verifying token/character length boundaries and metadata propagation.

### Point 19: Existing Embedding Strategy
- **Inspected Files**: `aiml-crash-yash-verma-Aurahealth_final_project/vectorstore.py`
- **Existing Behavior**: Uses `sentence-transformers/all-MiniLM-L6-v2` generating 384-dimensional dense vectors with L2 normalization (`_normalize`).
- **Classification**: **KEEP AS-IS**
- **Proposed Change**: Maintain `all-MiniLM-L6-v2` exactly as-is.
- **Verification Criterion**: Embedding dimension and vector normalization tests verifying 384 dimensions and unit norm.

### Point 20: Existing FAISS Index Format & Tenant Isolation
- **Inspected Files**: `vectorstore.py`, `vector_index/SYN-PAT-001/index.faiss`
- **Existing Behavior**: `faiss.IndexFlatIP(384)` with cosine similarity via normalized inner product. Persisted to disk with `faiss.write_index` and `faiss.read_index`.
- **Classification**: **KEEP AS-IS**
- **CRITICAL ISOLATION RULE**:
  - FAISS itself is a raw mathematical library with **no internal concept of multi-tenancy, authentication, or patient isolation**.
  - Patient isolation is **strictly enforced at the application boundary**:
    1. Node API Gateway enforces authenticated user permissions and patient scoping.
    2. Python RAG service routes requests to isolated filesystem paths: `vector_index/{patient_id}/index.faiss`.
    3. Retrieval queries load ONLY the requested patient's index file. Cross-patient vector search is architecturally impossible because indexes are stored in separate files and loaded dynamically per request.
- **Verification Criterion**: Security regression tests verifying that queries for Patient A never access Patient B's index file or retrieved chunks.

### Point 21: FAISS Concurrency & Atomic Index Updates
- **Inspected Files**: `vectorstore.py`, `rag_pipeline.py`
- **Existing Behavior**: Writes directly to `index.faiss` and `chunks.pkl` without locking or transactional isolation.
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**:
  - Implement process/file locking using `filelock` during index mutation and rebuilds.
  - Implement atomic write pattern: new index and chunk metadata are written to `.tmp` files (`index.faiss.tmp`, `chunks.pkl.tmp`), flushed to disk, and atomically renamed over active files.
  - Prevent concurrent write conflicts via per-patient memory mutexes in the FastAPI service.
- **Verification Criterion**: Concurrency tests simulating simultaneous ingestion and search requests on the same patient index.

### Point 22: Existing RAG Retrieval Strategy
- **Inspected Files**: `aiml-crash-yash-verma-Aurahealth_final_project/rag_pipeline.py`
- **Existing Behavior**: Analyzes temporal intent via `_analyze_query` into 4 modes: `TIMELINE_SUMMARY`, `SPECIFIC_YEAR`, `LONGITUDINAL_TREND`, and `STANDARD_SEMANTIC`. Retains chronological sorting by year.
- **Classification**: **KEEP AS-IS**
- **Proposed Change**: Preserve the 4-mode longitudinal retrieval strategy. Add handling for patients with zero historical records (return current intake only).
- **Verification Criterion**: Automated test suite asserting correct strategy categorization and chronological sorting across test queries.

### Point 23: Existing Confidence Calculation
- **Inspected Files**: `rag_pipeline.py`
- **Existing Behavior**: Evaluates top inner product similarity score:
  - `>= 0.50`: "High"
  - `>= 0.30`: "Medium"
  - `< 0.30`: "Low"
- **Classification**: **KEEP AS-IS**
- **Proposed Change**: Keep exact threshold logic. Add explanatory text for doctor view.
- **Verification Criterion**: Unit tests asserting boundary score classifications.

### Point 24: Existing Source Citation & Provenance
- **Inspected Files**: `rag_pipeline.py`, `generator.py`, `app.py`
- **Existing Behavior**: Returns list of source files (`sources`) and years (`years`). `app.py` renders expandable chunk viewer.
- **Classification**: **MODIFY MINIMALLY**
- **Provenance System**:
  - Explicitly tag every piece of data with its clinical provenance:
    1. `PATIENT_REPORTED` (Intake questionnaire responses, kiosk input)
    2. `DOCUMENT_EXTRACTED` (Native PDF/DOCX text parsed from uploaded files)
    3. `OCR_EXTRACTED` (Image/scanned document text from OCR engine)
    4. `DOCTOR_APPROVED` (Extracted document data formally verified by physician)
    5. `DOCTOR_ENTERED` (OPD notes, clinical Rx, physical exam findings)
    6. `AI_GENERATED_SUMMARY` (Intake synthesis, longitudinal timelines)
    7. `AI_CLINICAL_SUGGESTION` (Non-diagnostic decision support prompts)
    8. `MISSING_OR_UNKNOWN` (Explicit documentation of unrecorded history)
  - Citations include document name, page number, record date, and provenance tag.
- **Verification Criterion**: Citation validation tests verifying provenance tags and page numbers on retrieved chunks.

### Point 25: Existing Hardcoded Patient Assumptions
- **Inspected Files**: `generator.py` (lines 19-31), `rag_pipeline.py` (lines 24-27), `app.py` (lines 20, 295), `loader.py` (line 36)
- **Existing Behavior**: Hardcoded string `"SYN-PAT-001"` and `"Arjun Mehta"` embedded in system prompts, function defaults, and UI titles.
- **Classification**: **BLOCKER** (Must be parameterized)
- **Proposed Change**: Parameterize `patient_id` across `RAGPipeline`, `Generator`, and system prompts. Retain `SYN-PAT-001` as a selectable pre-loaded test patient.
- **Verification Criterion**: Multi-patient test suite verifying RAG pipeline execution on both `SYN-PAT-001` and newly created dynamic patient IDs.

### Point 26: Existing Deployment Assumptions
- **Inspected Files**: `f:\SIH\README.md`, `vite.config.js`, `server.js`, `requirements.txt`
- **Existing Behavior**: Assumes 3 concurrent terminal processes running on Windows:
  1. `npm run dev` (Vite, port 5173)
  2. `node server.js` (Express, port 5000)
  3. `streamlit run app.py` (Streamlit, port 8501)
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**: Provide a unified root startup script (`npm run dev:all` using `concurrently`) that starts Vite, Node API Gateway, and Python FastAPI service simultaneously, with optional Streamlit runner.
- **Verification Criterion**: Process management tests verifying all services initialize and respond on their configured ports.

### Point 27: Existing Security Weaknesses
- **Inspected Files**: `src/pages/AIInterviewPage.jsx`, `.env.example`, `server.js`
- **Existing Behavior**:
  - `VITE_GEMINI_API_KEY` exposed in Vite frontend bundle.
  - No authentication or role-based authorization in Express endpoints.
  - Express accepts raw JSON with no schema validation or rate limiting.
- **Classification**: **BLOCKER** (Security hardening required)
- **Proposed Change**:
  - Move Gemini API calls behind Express `/api/ai/intake-question`.
  - Validate all payloads with Zod / JSON schemas.
  - Implement patient-level authorization checks.
- **Verification Criterion**: Security vulnerability tests verifying rejection of unauthenticated/unscoped patient requests and payload validation failures.

### Point 28: Existing Technical Debt
- **Inspected Files**: `server.js`, `src/data/mockData.js`, `app.py`
- **Existing Behavior**:
  - Synchronous file I/O in Node API (`fs.writeFileSync`).
  - Document OCR simulation in frontend rather than real file processing.
  - Redundant patient records in `server/db.json`.
- **Classification**: **MODIFY MINIMALLY**
- **Proposed Change**: Transition to async database queries via Prisma ORM; connect real document upload & extraction.
- **Verification Criterion**: Automated load tests verifying non-blocking async operations under concurrent API requests.

### Point 29: Existing Reusable Components
- **Inspected Files**:
  - `RedFlagAlert.jsx`, `AudioPlayer.jsx`
  - `Header.jsx`, `Footer.jsx`, `DemoBanner.jsx`
  - `pdfGenerator.js`, `clinicalDialogEngine.js`
  - `vectorstore.py`, `chunker.py`, `rag_pipeline.py`, `generator.py`
- **Existing Behavior**: High visual quality, well-styled components with Lucide icons and smooth CSS animations.
- **Classification**: **KEEP AS-IS (REUSE)**
- **Proposed Change**: Retain and reuse these components directly in the unified platform.
- **Verification Criterion**: Component test suite asserting rendering and interaction integrity across all reused components.

### Point 30: Existing Risks and Blockers
- **Identified Items**:
  1. **Host Database Environment**: No PostgreSQL service or Docker is installed on the user's Windows machine. Running PostgreSQL natively would require manual installer setup.
     - *Resolution*: Use Prisma ORM configured with SQLite locally (zero installation, instant execution) and PostgreSQL schema config ready for cloud deployment. Avoid provider-specific JSONB decorators.
  2. **OCR Engine on Windows**: Tesseract OCR requires native C++ binary installation on Windows.
     - *Resolution*: Implement Python extraction using `pypdf` and `python-docx` for native text, and add a graceful OCR fallback boundary with manual doctor verification in `OCRResultsPage.jsx`.
  3. **Groq API Rate Limits / Key Requirement**: Python generator requires `GROQ_API_KEY`.
     - *Resolution*: Gracefully handle missing or rate-limited Groq keys with clear fallback messaging.
- **Classification**: **BLOCKER & NEEDS USER DECISION**
- **Verification Criterion**: Environment check scripts verifying system operations when optional external services are absent.

---

## 3. Proposed Unified Architecture

### System Topology: Option A (Node/Express API Gateway + Python RAG Microservice)

```
+-----------------------------------------------------------------------------------+
|                               Unified React 19 Frontend                           |
|  - Patient Kiosk (Registration, Audio Consent, Adaptive AI Intake, Doc Upload)     |
|  - Doctor Dashboard (Queue, Triage Alerts, Case Summary, Longitudinal RAG Tab)    |
+------------------------------------------+----------------------------------------+
                                           |
                              HTTP / REST  | (Proxy: /api -> localhost:5000)
                                           v
+-----------------------------------------------------------------------------------+
|                        Node.js / Express API Gateway (:5000)                      |
|  - Patient Registry & Encounter Management                                        |
|  - Document Storage (/data/uploads) & Metadata Tracking                           |
|  - Secure AI Proxy (/api/ai/intake-question - keeps Gemini key secret)            |
|  - Prisma Database Adapter (SQLite for local zero-dependency, Postgres for cloud)  |
|  - Reverse proxy to Python RAG service for clinical queries                       |
+---------------------+-------------------------------------+-----------------------+
                      |                                     |
    Canonical Storage |                   Internal RAG Call | (HTTP: localhost:8000)
                      v                                     v
+-------------------------------+   +-----------------------------------------------+
|     Prisma Database Engine    |   |           Python RAG Microservice (:8000)     |
|  - patients                   |   |  - Dynamic patient-scoped RAGPipeline         |
|  - encounters                 |   |  - PDF / DOCX / TXT Extraction                |
|  - documents                  |   |  - MiniLM-L6-v2 Embeddings (384-dim)          |
|  - intake_sessions            |   |  - Per-patient FAISS: vector_index/{id}/      |
|  - audit_logs                 |   |  - Groq LLM Grounded Generation (Generator)   |
+-------------------------------+   +-----------------------------------------------+
```

---

## 4. Files Impact Matrix

### 4.1 Files to KEEP AS-IS (Reused)
- `Patient-case-taking-software-/src/components/common/AudioPlayer.jsx`
- `Patient-case-taking-software-/src/components/common/RedFlagAlert.jsx`
- `Patient-case-taking-software-/src/components/layout/DemoBanner.jsx`
- `Patient-case-taking-software-/src/components/layout/Footer.jsx`
- `Patient-case-taking-software-/src/components/layout/Header.jsx`
- `Patient-case-taking-software-/src/pages/ConsentPage.jsx`
- `Patient-case-taking-software-/src/pages/KioskWelcome.jsx`
- `Patient-case-taking-software-/src/pages/LandingPage.jsx`
- `Patient-case-taking-software-/src/pages/LanguageSelectPage.jsx`
- `Patient-case-taking-software-/src/pages/AyushIntakePage.jsx`
- `Patient-case-taking-software-/src/pages/ArchitecturePage.jsx`
- `Patient-case-taking-software-/src/pages/SecurityPage.jsx`
- `Patient-case-taking-software-/src/utils/clinicalDialogEngine.js`
- `Patient-case-taking-software-/src/utils/pdfGenerator.js`
- `Patient-case-taking-software-/src/utils/textCleaner.js`
- `aiml-crash-yash-verma-Aurahealth_final_project/SYN-PAT-001_15yr_RAG_medical_history/*` (All 15 historical text files preserved)
- `aiml-crash-yash-verma-Aurahealth_final_project/vector_index/SYN-PAT-001/*` (`index.faiss` & `chunks.pkl` preserved)
- `aiml-crash-yash-verma-Aurahealth_final_project/app.py` (Streamlit standalone app preserved)
- `aiml-crash-yash-verma-Aurahealth_final_project/evaluate.py`
- `aiml-crash-yash-verma-Aurahealth_final_project/evaluation_results.json`

### 4.2 Files to MODIFY MINIMALLY
- `Patient-case-taking-software-/server.js` — Add patient lookup, document upload endpoint, and RAG proxy.
- `Patient-case-taking-software-/src/AppContent.jsx` — Add navigation tabs for longitudinal intelligence.
- `Patient-case-taking-software-/src/context/DemoContext.jsx` — Support dynamic patient IDs and real RAG states.
- `Patient-case-taking-software-/src/pages/PatientAuth.jsx` — Add existing patient lookup and non-hardcoded ID assignment.
- `Patient-case-taking-software-/src/pages/AIInterviewPage.jsx` — Add question planner, skip, "I don't know", and backend proxy.
- `Patient-case-taking-software-/src/pages/DocumentScannerPage.jsx` — Connect real multipart file upload to backend.
- `Patient-case-taking-software-/src/pages/DoctorDashboardPage.jsx` — Integrate Longitudinal Intelligence RAG panel.
- `aiml-crash-yash-verma-Aurahealth_final_project/rag_pipeline.py` — Support dynamic `patient_id` parameter.
- `aiml-crash-yash-verma-Aurahealth_final_project/generator.py` — Remove hardcoded patient prompt strings.
- `aiml-crash-yash-verma-Aurahealth_final_project/loader.py` — Support dynamic patient metadata extraction.
- `aiml-crash-yash-verma-Aurahealth_final_project/vectorstore.py` — Support dynamic index directory loading, locking, and atomic writes.

### 4.3 Files to ADD (New Services & Documentation)
- `f:\SIH\package.json` — Root workspace script orchestrator (`npm run dev:all`).
- `f:\SIH\docs/*` — Complete engineering documentation suite (PRD, TRD, ARCHITECTURE, etc.).
- `f:\SIH\scripts/migrate_db_json.js` — One-time migration script from `db.json` to canonical Prisma DB.
- `aiml-crash-yash-verma-Aurahealth_final_project/rag_service.py` — Python FastAPI microservice exposing RAG pipeline.
- `Patient-case-taking-software-/prisma/schema.prisma` — Relational schema for patients, encounters, documents, and audit logs.
- `Patient-case-taking-software-/src/components/doctor/LongitudinalIntelligenceTab.jsx` — Doctor RAG query component.

---

## 5. Recommended Implementation Order

1. **Gate 0 (Current)**: Audit & Architecture Approval.
2. **Phase 1**: Workspace consolidation, backups, and full engineering documentation (`docs/PRD.md`, `TRD.md`, etc.).
3. **Phase 2**: Database layer & dynamic patient identity model (Prisma schema + SQLite/Postgres adapter) + One-time `db.json` migration.
4. **Phase 3**: Node.js API Gateway extension & secure AI proxy.
5. **Phase 4**: Patient registration & lookup (Mobile + ABHA readiness).
6. **Phase 5**: Clinical intake agent modernization (Dynamic questions, skip, edit, review).
7. **Phase 6**: Document upload, storage, and text extraction pipeline.
8. **Phase 7**: MedSync -> AuraHealth data ingestion bridge.
9. **Phase 8**: Dynamic multi-patient Python FastAPI RAG service (with concurrency locking & atomic index writes).
10. **Phase 9**: Unified React frontend integration (Doctor Dashboard + Longitudinal Intelligence).
11. **Phase 10**: Doctor review & approval workflow for ingested documents.
12. **Phase 11**: Security hardening, offline handling, and deployment readiness.
13. **Phase 12**: End-to-end acceptance testing and verification.
