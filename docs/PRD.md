# Product Requirements Document (PRD)

## 1. Product Overview & Problem Statement

### 1.1 Product Name
**MedSync + AuraHealth Nexus: Unified Healthcare Intelligence Platform**

### 1.2 Problem Statement
Public and private hospital Outpatient Departments (OPDs) in India face extreme patient volumes, resulting in severe clinical administrative overhead, long queue waiting times, fragmented paper-based medical histories, and lost previous investigation reports. Physicians have less than 3–5 minutes per patient, making it impossible to manually read through years of paper records or synthesize longitudinal trends (such as 10-year eGFR or HbA1c trajectories).

### 1.3 Solution & Product Vision
A unified, bilingual (Hindi/English) healthcare intelligence platform uniting:
1. **MedSync Kiosk Workflow**: Self-service patient intake, mobile/ABHA identity lookup, audio-assisted low-literacy consent, dynamic AI clinical interview, document scanning, and structured case summary generation.
2. **Doctor OPD Chamber Workflow**: Real-time queue management, triage alerts, physical examination documentation, and prescription generation.
3. **AuraHealth Longitudinal Intelligence**: Doctor-supporting clinical RAG engine that searches patient-specific historical records, previous hospital OPD visits, and newly uploaded documents to answer clinical questions with exact document and page-level source citations.

---

## 2. User Personas & Core Journeys

| Persona | Role | Primary Objectives |
| :--- | :--- | :--- |
| **Ramesh Sharma** (Patient / Kiosk User) | 48-year-old walk-in patient with chronic hypertension | Quick OPD check-in via mobile number, clear Hindi audio explanation, report paper prescriptions, review case summary. |
| **Dr. K. S. Sharma** (OPD Physician) | Senior MD in General Medicine, Chamber #04 | Prioritized triage queue, clear intake summaries, instant longitudinal queries (eGFR trends, past medication changes) with source-backed citations. |
| **Kiosk Field Operator / Clinical Staff** | Hospital assistant | Helping low-literacy patients, assisting with document scanning, hardware monitoring. |
| **System Administrator** | Hospital IT / Compliance Lead | Monitoring audit logs, managing role permissions, reviewing data protection compliance. |

---

## 3. Functional Requirements Summary

- **FR-1: Patient Identification & Onboarding**: Dynamic registration, mobile number lookup (non-unique, supporting shared family numbers without silent merges), optional ABHA Number / ABHA Address lookup with truthful "I don't have an ABHA ID" path, masked preview with single-use lookup handle (no unverified `patientUid` exposure), multi-signal duplicate prevention requiring explicit confirmation, and truthful ABHA verification status (`abhaVerified: false` unless cryptographically confirmed via official gateway).
- **FR-2: Purpose-Aware Consent**: Explicit, historical consent capture with audio read-aloud in Hindi/English.
- **FR-3: Adaptive AI Clinical Intake**: Complaint-first sequential questioning, avoiding repeated questions, supporting skip / "I don't know" / edit.
- **FR-4: Document Ingestion & Page Extraction**: Digital text and OCR scanning, page segmentation, separate tracking of `uploadDate` vs `clinicalDate`.
- **FR-5: Doctor Verification Gate**: Physician review and approval before historical documents are indexed for longitudinal clinical RAG.
- **FR-6: Dynamic Multi-Patient RAG**: Patient-scoped retrieval (`vector_index/{patientUid}/`), 4-mode chronological routing, page-aware citations.
- **FR-7: No-History Truthfulness**: Acknowledging absence of historical documentation when none exists, answering solely from current intake data.
- **FR-8: OPD Consultation Completion & Authorization**: Doctor notes, medication prescribing, real-time PDF generation. Doctor access is strictly authorized by clinical relationship (`assignedDoctorId` or active chamber queue claim). All audit actions attribute `AuditLog.actorUserId` to the authenticated clinician.

---

## 4. Non-Functional Requirements

- **NFR-1 (Security & Privacy)**: No cloud AI keys exposed in client bundles. Three distinct session namespaces (`ms_device_session`, `ms_encounter_session`, `ms_user_session`) ensuring patient intake sessions never escalate to doctor identity. Kiosk lookup uses ephemeral, single-use `lookupHandle` bound to terminal session. Clinical access enforced via three-tier model (assigned encounter, care relationship, administrative). Topology-aware cookie settings (`SameSite=Lax` dev, `SameSite=Strict` prod, `Secure` in prod, multi-layer CSRF validation). Non-blocking asynchronous `crypto.scrypt` password hashing. In-memory session store local-only; Redis mandatory for production.
- **NFR-2 (Latency)**: Kiosk intake question generation under 3.5s; doctor RAG retrieval and response generation under 4.0s.
- **NFR-3 (Resilience & Offline)**: Graceful fallback to `clinicalDialogEngine.js` when network connectivity is lost.
- **NFR-4 (Auditability)**: Relational audit log recording every clinical access, document approval, and RAG query linked to an authenticated user ID.
