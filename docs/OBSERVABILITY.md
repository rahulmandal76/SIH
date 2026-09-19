# Observability & Clinical Auditability Specification

## 1. Structured Request Logging (Phase 3 — IMPLEMENTED)

All Node.js API requests generate structured JSON log entries:

```json
{
  "requestId":  "a2f120be-3f9e-4717-850c-345f8def586e",
  "method":     "POST",
  "path":       "/api/ai/intake-question",
  "statusCode": 200,
  "durationMs": 1347,
  "model":      "gemini-2.0-flash-lite",
  "source":     "gemini"
}
```

**PHI Redaction Policy** (enforced at logger level):
- `GEMINI_API_KEY`, `GROQ_API_KEY`, or any `apiKey` field → never logged
- `password`, `token`, `session` → never logged
- Raw stack traces → not logged (to prevent filesystem path leakage)
- Patient names, mobile numbers, ABHA numbers → not included in log entries

**RequestId tracing**:
- Generated as UUID v4 per request
- Returned in both `X-Request-Id` response header and error response body `error.requestId`
- Use to correlate frontend errors with server logs

---

## 2. Health & Readiness Probes

| Endpoint | Service | What It Checks |
|---|---|---|
| `GET /api/health` | Node.js Gateway | Prisma DB connectivity, patient/encounter counts, timestamp |
| `GET /rag/health` | Python FastAPI (Phase 5) | FAISS memory check, Groq API connectivity |

**Sample healthy response**:
```json
{
  "status":     "healthy",
  "database":   "connected",
  "provider":   "sqlite",
  "patients":   14,
  "encounters": 14,
  "time":       "2026-09-19T06:00:00.000Z"
}
```

---

## 3. Clinical Audit Trails & Multi-Actor Model (Phase 4 Specification)

Every clinical, administrative, device, and automated action creates an immutable `AuditLog` record. To prevent fabricating fake `User` records for terminals or background workers, the schema supports four distinct actor types:

| Field | Type | Description | Attribution Guarantee |
|---|---|---|---|
| `patientUid` | String? | Target patient UUID | Verified against encounter or target resource |
| `actorType` | String | `USER`, `DEVICE`, `SERVICE`, `SYSTEM` | Explicit classification of initiating actor |
| `actorUserId` | Int? | FK -> `User.id` | **Strictly `req.user.id` when `actorType === "USER"`**; null for devices/services |
| `actorDeviceId` | String? | Terminal/hardware identifier | Set when `actorType === "DEVICE"` (e.g. `KIOSK-TERMINAL-04`) |
| `actorService` | String? | Microservice identifier | Set when `actorType === "SERVICE"` (e.g. `fastapi-rag-service`) |
| `action` | String | e.g. `PATIENT_LOOKUP`, `REGISTER_PATIENT`, `CLAIM_ENCOUNTER`, `VIEW_RECORD`, `COMPLETE_OPD` | Audited clinical or security event |
| `resourceType` | String | `patient`, `encounter`, `care_relationship`, `document`, `rag_query` | Target entity classification |
| `resourceId` | String? | Target identifier (e.g. `ENC-2026-0105`) | Exact resource reference |
| `metadataJson` | String? | Sanitized contextual details | Never includes raw PHI, passwords, or session tokens |
| `timestamp` | DateTime | Audit event generation time | Server-generated ISO 8601 timestamp |

### Audit Event Examples:
```json
// Doctor completing OPD consultation
{
  "actorType": "USER",
  "actorUserId": 3,
  "action": "COMPLETE_OPD",
  "resourceType": "encounter",
  "resourceId": "ENC-2026-0105",
  "metadataJson": "{\"tokenNumber\":\"105\",\"consultationStatus\":\"completed\"}"
}

// Kiosk terminal performing anti-enumerated mobile search
{
  "actorType": "DEVICE",
  "actorDeviceId": "KIOSK-01",
  "action": "PATIENT_LOOKUP",
  "resourceType": "patient",
  "metadataJson": "{\"lookupType\":\"mobileNumber\",\"candidateCount\":2}"
}

// Background OCR worker extracting page text
{
  "actorType": "SERVICE",
  "actorService": "ocr-worker",
  "action": "TEXT_EXTRACTION",
  "resourceType": "document",
  "resourceId": "DOC-2026-0012"
}
```


---

## 4. AI Provenance Tracking (Phase 3 — IMPLEMENTED)

Every AI response is tagged with its source:

| Source | Value | Description |
|---|---|---|
| Gemini proxy | `source: "gemini"`, `model: "gemini-2.0-flash-lite"` | AI-generated response |
| Local fallback | Not tagged (returned only to frontend) | `clinicalDialogEngine.js` rule-based response |

The two are **never conflated**. When Gemini is unavailable, the backend returns a truthful error (503/504/429) and the frontend uses the offline engine — never labelled as Gemini.

---

## 5. Rate Limiting Observability

Two independent rate limiters are tracked:
1. **AI Endpoint Limiter**: Logged with `rateExceeded: true` on `/api/ai/intake-question`.
2. **Authentication Brute-Force Limiter**: Logged with `reason: "AUTH_BRUTE_FORCE_THROTTLED"` on `/api/auth/login` (max 5 failed attempts per 15 min).

---

## 6. Security Event & Access Control Observability (Phase 4)

Security authorization boundaries are explicitly tracked in structured logs:

### Logged Security Events

| Event | Status Code | Log Field | Description | Severity |
|---|---|---|---|---|
| Unauthenticated access | 401 | `reason: "no_session_token"` | Protected route called without valid cookie | Low |
| Expired session | 401 | `reason: "session_expired"` | Session past TTL window | Low |
| Invalid session | 401 | `reason: "SESSION_NOT_FOUND"` | Stale or fabricated session token | Medium |
| **Cross-patient scope mismatch** | **403** | `reason: "PATIENT_SCOPE_MISMATCH"` | **Kiosk session A requesting Patient B** | **HIGH** |
| **Doctor access denied** | **403** | `reason: "CLINICAL_ACCESS_DENIED"` | **Doctor requesting unassigned patient** | **HIGH** |
| **CSRF validation failed** | **403** | `reason: "CSRF_VIOLATION"` | **Cross-origin state-changing attack** | **HIGH** |
| **Lookup handle kiosk mismatch** | **403** | `reason: "HANDLE_CONTEXT_MISMATCH"` | **Handle replayed from different device/session** | **HIGH** |
| **Lookup handle expired / consumed** | **403/409** | `reason: "INVALID_LOOKUP_HANDLE"` | **Reused or expired handle presentation** | **HIGH** |
| **Auth brute force throttled** | **429** | `reason: "AUTH_BRUTE_FORCE_THROTTLED"` | **Exceeded 5 login failures / 15 min** | **HIGH** |
| **Legacy token bypass attempt** | **401/403** | `reason: "UNAUTHORIZED_TOKEN_ACCESS"` | **Token route called without session** | **HIGH** |


### Security Violation Log Example
```json
{
  "requestId":  "d66043bd-0224-4358-bf25-dc98e87d8eeb",
  "method":     "GET",
  "path":       "/api/patient/105",
  "statusCode": 403,
  "durationMs": 2,
  "actorUserId": 3,
  "reason":     "CLINICAL_ACCESS_DENIED"
}
```

> **Security Distinction in Observability**:
> - **Patient Existence**: Proves only that `findUnique` succeeded/failed. Never used as an audit signal for authorized access.
> - **Patient Authorization**: Verifies session token claims match the resource namespace (`session.patientUid === requestedUid`) and doctor assignment (`encounter.assignedDoctorId === req.user.id`). Logged with explicit violation reasons when blocked.

---

## 7. PostgreSQL Production Readiness Status

| Item | Status |
|---|---|
| Schema defined | ✅ |
| SQLite validated | ✅ |
| PostgreSQL live validation | ⏳ PENDING INFRASTRUCTURE |

System is **not** called production-ready until PostgreSQL live validation is confirmed.
