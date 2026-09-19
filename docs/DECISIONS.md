# Architecture Decision Records (ADRs)

## Project: MedSync + AuraHealth Nexus Unified Platform

---

### ADR-001: Production Database Selection (PostgreSQL) and Local Development (SQLite) Strategy

#### Status: Accepted

#### Context:
The production platform requires relational integrity, concurrency control, ACID compliance, robust indexing, and scalability for multi-patient healthcare workflows. The target production environment is PostgreSQL. However, local developer workstations (such as Windows development environments) may not have PostgreSQL or Docker pre-installed.
Prisma ORM handles database connections via provider configurations (`provider = "postgresql"` vs `provider = "sqlite"`). In Prisma, `DATABASE_URL` specifies the connection string, but the `provider` property inside the `datasource` block strictly dictates the SQL dialect, AST generation, and migration formats. Changing `DATABASE_URL` alone does **NOT** switch database providers.

#### Decision:
1. **Production Database**: PostgreSQL is the canonical, non-negotiable production database engine.
2. **Local Development**: SQLite is supported as an optional, lightweight, zero-dependency local development provider using a dedicated local schema configuration (`prisma/schema.sqlite.prisma` or a build-time provider generator).
3. **Provider Compatibility**:
   - The relational schema must NOT utilize PostgreSQL-specific types (e.g. `@db.JsonB`, raw PostgreSQL enum types, or tsvector) in schemas targeted for SQLite.
   - Provider compatibility across SQLite and PostgreSQL must be validated by automated integration test suites running migrations and query assertions against both engines in CI/CD.
   - We explicitly disclaim that `DATABASE_URL` alone can switch providers.

#### Consequences:
- High local developer productivity without blocking on Docker/Postgres daemon installation on Windows.
- Clean, reliable path to cloud PostgreSQL deployment.
- Zero dialect-dependent lock-in in core relational models.

---

### ADR-002: Immutable `patientUid` as Vector Index Storage Namespace

#### Status: Accepted

#### Context:
AuraHealth historically hardcoded a single synthetic patient ID string (`SYN-PAT-001`). As we transition to a multi-patient longitudinal system, patient identifiers exist in two forms:
1. Human-readable identifiers: `patientId` (e.g. `PAT-2026-0001`, `P-8801`, `SYN-PAT-001`). These can be subject to formatting changes, renumbering, or user input.
2. System immutable identifiers: `patientUid` (RFC 4122 UUID v4).

#### Decision:
1. Vector storage namespaces on the filesystem MUST strictly use the immutable internal `patientUid`:
   `vector_index/{patientUid}/index.faiss`
   `vector_index/{patientUid}/chunks.pkl`
   `vector_index/{patientUid}/.lock`
2. Human-readable `patientId` is preserved strictly for clinician display, OPD queue presentation, search lookups, and case summaries.
3. Node API Gateway verifies authentication and patient-access authorization, resolves the canonical `patientUid` from the database, and passes only the validated `patientUid` to the Python RAG service.
4. User-provided raw strings are never passed directly to filesystem path resolvers, preventing path-traversal attacks.

#### Consequences:
- Safe, collision-free, immutable vector storage per patient.
- `SYN-PAT-001` is assigned a deterministic canonical `patientUid` to maintain full historical continuity.
- No possibility of accidental filesystem namespace collisions between patients.

---

### ADR-003: FAISS Boundary Isolation vs. Application-Level Security

#### Status: Accepted

#### Context:
FAISS (`IndexFlatIP`) is a pure mathematical library for dense vector similarity computation. It possesses no concept of user accounts, authentication, authorization, multi-tenant scoping, or row-level security.

#### Decision:
1. FAISS is explicitly recognized as a compute engine, NOT a security boundary.
2. Multi-tenant patient isolation is strictly enforced at the **Application and Gateway Boundary**:
   - The Node.js API Gateway authenticates the requesting clinician and verifies clinical authorization to view the target patient.
   - The Python FastAPI RAG microservice accepts queries with an explicit `patientUid`.
   - The RAG engine opens and searches **ONLY** the isolated index file belonging to that specific `patientUid` (`vector_index/{patientUid}/index.faiss`).
3. Cross-patient vector search is architecturally impossible because no global shared index exists across patients.

#### Consequences:
- Transparent, auditable security architecture that does not rely on vector database claims.
- Zero risk of cross-patient clinical data leakage during vector similarity retrieval.

---

### ADR-004: Decoupling Document Pages, Processing Jobs, Approvals, and RAG Ingestion

#### Status: Accepted

#### Context:
Medical documents uploaded in clinical workflows (e.g. 15-page hospital discharge summaries, multi-page lab reports) progress through distinct operational stages. Merging document upload, text extraction, page parsing, doctor clinical verification, and vector indexing into a single synchronous model creates data loss risks, prevents page-level citations, and risks indexing unverified or inaccurate data.
Additionally, document upload date is often different from the document's actual clinical visit date.

#### Decision:
Decouple document structure and processing lifecycle into discrete relational entities:
1. `Document`: File metadata, MIME type, storage path, checksum, upload date, and clinical/document date.
2. `DocumentPage`: Page-level text extraction, page number, OCR confidence, and page status.
3. `DocumentProcessingJob`: Asynchronous extraction/OCR tracking, execution states (`QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`), and retry counts.
4. `DocumentApproval`: Formal physician review before clinical indexing (`PENDING_REVIEW`, `APPROVED`, `REJECTED`, `approvedByUserId`, comments).
5. `RAGIngestionJob`: Tracking chunk generation, vector generation, and index update status.

#### Consequences:
- High-fidelity, page-aware citations for RAG responses (`[Source: Discharge_Summary_2023.pdf, Page 2]`).
- Clinical safety: Documents do not enter longitudinal RAG context until approved according to hospital policy.
- Complete auditability and graceful asynchronous retry for OCR failures.

---

### ADR-005: Explicit Clinical Information Provenance and Purpose-Aware Consent

#### Status: Accepted

#### Context:
Healthcare decision-support systems must never present unverified inferences, patient-reported symptoms, and objective laboratory values as having equal clinical validity. Furthermore, blanket "granted=true" boolean consent violates modern healthcare privacy guidelines (such as ABDM and DPDP).

#### Decision:
1. **8-Tier Provenance Taxonomy**: Every data point, encounter record, and citation carries an immutable provenance tag:
   - `PATIENT_REPORTED`
   - `DOCUMENT_EXTRACTED`
   - `OCR_EXTRACTED`
   - `DOCTOR_APPROVED`
   - `DOCTOR_ENTERED`
   - `AI_GENERATED_SUMMARY`
   - `AI_CLINICAL_SUGGESTION`
   - `MISSING_OR_UNKNOWN`
2. **Purpose-Aware Consent Model (`PatientConsent`)**:
   - Tracks explicit purposes: `data_collection`, `ai_processing`, `document_processing`, `record_sharing`, `abha_integration`.
   - Records `policyVersion`, `grantedAt`, `withdrawnAt`, and `capturedByType`.
   - Preserves complete consent audit history and supports withdrawal.

#### Consequences:
- Clinicians can instantly distinguish objective doctor-verified labs from subjective patient statements in the UI.
- Strict compliance with purpose-specific data protection regulations.
