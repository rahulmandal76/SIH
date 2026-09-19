# Technical Requirements Document (TRD)

## 1. Technology Stack Specification

| Component | Target Technology | Justification & Compatibility Notes |
| :--- | :--- | :--- |
| **Frontend** | React 19.3.0, Vite 8.3.0, Tailwind CSS v4 | Preserves existing MedSync UI components, Lucide icons, and responsive layouts. |
| **API Gateway** | Node.js v22.14 / Express 5.2.1 | Lightweight, non-blocking asynchronous gateway for queue management, file uploads, and RAG proxying. |
| **RAG Microservice** | Python 3.13.3, FastAPI, Uvicorn | Exposes existing AuraHealth pipeline (`rag_pipeline.py`, `vectorstore.py`, `generator.py`) as high-performance REST APIs. |
| **Vector Engine** | FAISS CPU (`IndexFlatIP`, 384-dim), MiniLM-L6-v2 | Fast inner product dense search. Partitioned strictly by `patientUid` with process locking. |
| **LLM Inference** | Groq API (`openai/gpt-oss-20b` or compatible model) | Ultra-fast token latency for clinical timeline synthesis. Isolated in backend. |
| **Session Store (Prod)** | Redis v7+ / Valkey Cluster | Shared durable session storage, distributed instant revocation, horizontal multi-instance scaling. |
| **Session Store (Dev)** | In-Memory Map (Node.js Heap) | Local development only; functional for single-instance offline validation. |
| **Database (Prod)** | PostgreSQL v15+ (Prisma ORM) | Robust ACID transactional persistence, relational integrity, connection pooling. |
| **Database (Dev)** | SQLite v3.40+ (Prisma ORM) | Lightweight, zero-dependency local option validated against provider-neutral schema. |

---

## 2. Service Topology & Communication Contracts

```
[ Vite Frontend (:5173) ]
       │
       │ HTTP / REST (Vite Proxy: /api -> :5000)
       ▼
[ Node.js API Gateway (:5000) ]
       │
       ├─► [ PostgreSQL / SQLite (Prisma) ] (Canonical Storage)
       ├─► [ Local File Storage (/data/uploads) ]
       │
       │ HTTP / Internal REST (:8000)
       ▼
[ Python FastAPI RAG Service (:8000) ]
       │
       ├─► [ SentenceTransformers MiniLM-L6-v2 ]
       ├─► [ FAISS Store: vector_index/{patientUid}/ ]
       └─► [ Groq LLM API ]
```

---

## 3. Database Migration Strategy
- One-time automated migration from `server/db.json` into canonical Prisma database (`scripts/migrate_db_json.js`).
- Dual-write is explicitly rejected. All writes target the canonical relational store.
- Schema uses provider-neutral types tested against both PostgreSQL and SQLite.

---

## 4. Concurrency & High-Availability Safeguards
- Vector file updates protected by `filelock` and process-level mutexes.
- Atomic file replacement (`index.faiss.tmp` -> `index.faiss`) ensures reader consistency during ongoing uploads.
- Uploaded files verified with SHA-256 hashes to prevent redundant disk storage.

---

## 5. Authentication & Session Infrastructure (Phase 4 Specification)
- **Session Namespaces**:
  - `ms_device_session`: Kiosk terminal device session (TTL 24h, terminal IP/identifier bound).
  - `ms_encounter_session`: Ephemeral patient intake session (TTL 2h, strictly scoped to single `encounterId` and `patientUid`).
  - `ms_user_session`: Clinician/staff authenticated user session (TTL 8h, role-bearing).
  - *Invariant*: Patient intake sessions cannot access clinician endpoints; clinician sessions cannot masquerade as patient intake sessions.
- **Lookup Handle Security**:
  - Opaque cryptographically random token (`lh_...`), single-use, 5-minute TTL.
  - Server-side binding to the originating `ms_device_session` and candidate patient set.
  - Immediate invalidation upon encounter creation; cross-device replays rejected with 403.
- **Topology-Aware Cookie & CSRF Policy**:
  - `HttpOnly`: Always enabled.
  - `Secure`: Enabled in production / HTTPS.
  - `SameSite`: `Lax` in development (cross-port Vite dev server proxy), `Strict` in production (single origin behind NGINX reverse proxy).
  - Multi-layer CSRF: `X-Requested-With` header verification + Origin/Referer matching on state-changing requests.
- **Asynchronous Password Hashing**:
  - Uses Node.js asynchronous `util.promisify(crypto.scrypt)` (N=16384, r=8, p=1, keylen=64).
  - 16-byte cryptographically secure random salt generated via `crypto.randomBytes(16)`.
  - Constant-time verification with `crypto.timingSafeEqual`.
  - Blocking `scryptSync` is strictly forbidden in event loop / request handlers.
  - Passwords and hashes are never exposed in API responses or logs.

