# Error Handling & Resilience Specification

## 1. Standard Error Response Envelope (Phase 3+)

All API error responses use a consistent structured shape:

```json
{
  "error": {
    "code":      "ERROR_CODE",
    "message":   "Human-readable description of the error",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "issues":    [{ "field": "patientMessage", "message": "Required" }]
  }
}
```

The `requestId` is generated per-request (UUID v4) and returned in both the response body and the `X-Request-Id` response header. Use it to correlate logs.

---

## 2. Error Code Registry

| Code | HTTP Status | Description | Frontend Action |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod schema violation. `issues` array lists fields + messages | Display validation hint; do not retry automatically |
| `HANDLE_REQUIRED` | 400 | Client attempted to submit raw `patientUid`; a valid handle is required | Reject submission; prompt for proper lookup or registration handle |
| `ADMIN_ACCESS_REASON_REQUIRED` | 400 | Admin access attempted without `X-Admin-Access-Reason` header | Prompt administrator to supply a documented access reason |
| `AUTHENTICATION_REQUIRED` | 401 | Missing, invalid, or expired session cookie/token | Redirect to login / prompt for kiosk session |
| `FORBIDDEN` | 403 | Generic authorization failure | Show "Access denied" |
| `PATIENT_SCOPE_MISMATCH` | 403 | Session scoped to Patient A attempting to access Patient B | Terminate attempt; alert user to scope mismatch |
| `CLINICAL_ACCESS_DENIED` | 403 | Doctor attempting to access unassigned patient | Inform clinician to claim encounter from queue |
| `HANDLE_CONTEXT_MISMATCH` | 403 | Lookup/registration handle presented from a different kiosk or user context | Invalidate attempt; prompt user to re-lookup at their terminal |
| `HANDLE_EXPIRED` | 403 | Handle TTL (>5 minutes) expired | Prompt patient to re-enter mobile number or re-register |
| `LONGITUDINAL_ACCESS_DENIED` | 403 | Doctor has no active, non-expired CareRelationship or assigned encounter | Access denied; doctor must claim an encounter or have an active relationship |
| `CHAMBER_ROUTING_REQUIRED` | 403 | Encounter has no chamber assignment; doctor cannot claim until clinical staff routes it | Show "Not yet routed — please contact reception" |
| `CHAMBER_MISMATCH` | 403 | Encounter's chamber does not match the claiming doctor's assigned chamber | Inform doctor the encounter belongs to a different chamber |
| `CSRF_VIOLATION` | 403 | State-changing request failed Origin / AJAX header verification | Block request; refresh application session |
| `CARE_RELATIONSHIP_NOT_FOUND` | 404 | No CareRelationship found for the given id | Show "Relationship not found" |
| `PATIENT_NOT_FOUND` | 404 | Token, encounter, or UID not found in canonical database | Show "patient not found" |
| `HANDLE_ALREADY_CONSUMED` | 409 | Lookup or registration handle already used | Single-use violation; require fresh lookup |
| `ENCOUNTER_ALREADY_CLAIMED` | 409 | Encounter was claimed concurrently by another clinician | Show "Encounter taken — select another from queue" |
| `INVALID_LIFECYCLE_TRANSITION` | 409 | CareRelationship is already in the target status or transition is not permitted | Display current status; prompt valid action |
| `TOO_MANY_REQUESTS` | 429 | Authentication brute-force or endpoint rate limit exceeded | Display backoff countdown timer |
| `AI_PROVIDER_RATE_LIMITED` | 429 | Gemini rate limit exceeded | Fall back to `clinicalDialogEngine.js`; show "AI busy, continuing offline" |
| `AI_PROVIDER_UNAVAILABLE` | 503 | All Gemini models returned errors | Fall back to `clinicalDialogEngine.js`; show "AI unavailable, using offline assistant" |
| `AI_PROVIDER_TIMEOUT` | 504 | Gemini call exceeded 5.5 s timeout | Fall back to `clinicalDialogEngine.js`; show "AI timed out, using offline assistant" |
| `NOT_IMPLEMENTED` | 501 | Endpoint is a documented Phase N stub | Show "feature not yet available" |
| `INTERNAL_ERROR` | 500 | Unexpected server error | Show generic error with requestId for support |

### 2.1 Patient Existence vs. Patient Authorization Error Boundaries

These two security controls produce distinctly different error states at distinct pipeline stages:

```
Request Pipeline:
1. Zod Validation Check     ──[Invalid schema]──────────────► 400 VALIDATION_ERROR
            │ (valid)
2. Authentication Gate      ──[No X-Kiosk-Session header]───► 401 AUTHENTICATION_REQUIRED
            │                 [Expired / invalid token] ────► 401 AUTHENTICATION_REQUIRED
            │ (authenticated)
3. Scope Authorization Gate ──[Token Patient != Target UID]─► 403 FORBIDDEN (PATIENT_SCOPE_MISMATCH)
            │ (authorized)
4. DB Clinical Field Merge  ──[DB read age/gender]──────────► Authoritative fields applied
            │
5. AI Proxy Execution       ──[Gemini call]─────────────────► 200 OK (or 503/504 on provider error)
```

> **CRITICAL RULE**: The Authentication Gate (Stage 2) and Authorization Gate (Stage 3) **fire BEFORE any DB patient existence check or resource disclosure**.
> An attacker requesting an existing `patientUid` without a valid session receives **`401 AUTHENTICATION_REQUIRED`** — the system never confirms or denies whether the UUID exists in the database.

---

## 3. AI Provider Failure Handling

When Gemini fails, the API returns a **truthful** error. It never fabricates a Gemini response.

```
Gemini call fails
        ↓
Backend returns HTTP 503/504/429 with error.code
        ↓
Frontend (AIInterviewPage.jsx)
        ↓
Falls back to getAdaptiveClinicalResponse() (clinicalDialogEngine.js)
        ↓
Response is LOCAL RULE-BASED — never labelled as "Gemini"
```

**Fallback cascade in server.js**:
1. `gemini-2.0-flash-lite` → try
2. `gemini-2.0-flash` → try if first fails
3. `gemini-1.5-flash` → try if second fails
4. All exhausted → return `AI_PROVIDER_UNAVAILABLE`

---

## 4. Resilience Patterns

| Failure Mode | System Response | Impact |
|---|---|---|
| Gemini rate limit | All 3 model candidates tried; if all 429 → return `AI_PROVIDER_RATE_LIMITED` | Frontend uses offline clinical engine |
| Gemini timeout (> 5.5 s) | Next model candidate tried; if all timeout → `AI_PROVIDER_TIMEOUT` | Frontend uses offline clinical engine |
| Gemini key missing | Immediate `AI_PROVIDER_UNAVAILABLE` (no network call attempted) | Frontend uses offline clinical engine |
| Patient DB not found | `PATIENT_NOT_FOUND` (404) | Doctor dashboard shows "patient not found" |
| DB disconnection | `INTERNAL_ERROR` (500) with requestId | Clean error; DB auto-reconnects |
| Corrupt upload (Phase 5) | Document status → `failed`; reason recorded | Doctor alerted to rescan |
| Internet lost (kiosk) | Frontend AbortController fires at 8s; falls back to `clinicalDialogEngine` | Intake continues offline |
| RAG service offline (Phase 5) | Node returns `503 AI_PROVIDER_UNAVAILABLE` | Doctor alerted; current intake summary visible |

---

## 5. Structured Request Logging

Every request generates a structured JSON log line:

```json
{
  "requestId":  "a2f120be-3f9e-4717-850c-345f8def586e",
  "method":     "POST",
  "path":       "/api/ai/intake-question",
  "statusCode": 200,
  "durationMs": 1347,
  "model":      "gemini-2.0-flash-lite",
  "source":     "gemini",
  "stepIndex":  1
}
```

**Never logged**:
- `GEMINI_API_KEY` or any API key value
- Passwords or session tokens
- Raw stack traces (to prevent filesystem path leakage)
- Full patient names, phone numbers, or ABHA numbers
- Complete medical documents or raw AI prompts with PHI

---

## 6. Rate Limiting Configuration

| Parameter | Default | Env Var |
|---|---|---|
| Window duration | 10 minutes | `AI_RATE_LIMIT_WINDOW_MS=600000` |
| Max requests per window | 30 | `AI_RATE_LIMIT_MAX=30` |
| Scope | Per terminal IP | — |
| Storage | In-process Map (dev) | Replace with Redis in production |

**Rationale**: A kiosk patient intake session uses approximately 6–10 AI calls (one per clinical step). A limit of 30 per 10 minutes allows 3–5 complete intake sessions per terminal before reset, while preventing malicious flooding.
