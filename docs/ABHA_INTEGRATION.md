# ABHA / ABDM Integration Architecture & Readiness

## 1. Scope & Truthfulness Guarantee

The platform strictly avoids simulated or fake ABHA verifications:
1. **Level 1: ABHA-Ready UI & Data Model (Active in Current Scope)**
   - Form fields for 14-digit ABHA Number (`XX-XXXX-XXXX-XXXX`) and ABHA Address (`name@abdm`).
   - "I don't have an ABHA ID" skip action with informational guidance on official creation.
   - Status indicators truthfully reflect integration state: `ABHA Unlinked`, `Integration Pending`, `Sandbox Verified`, `Live Verified`.
   - Never generate fake ABHA numbers or mock OTP verification presented as live ABDM verification.
2. **Level 2: Live ABDM Gateway Integration (Adapter Boundary)**
   - Clear architectural adapter boundary (`AbdmIntegrationAdapter`).
   - Requires official National Health Authority (NHA) ABDM Sandbox credentials, client ID, client secret, and digital certificate signing.

---

## 2. ABHA Integration Adapter Interface

```typescript
export interface AbdmIntegrationAdapter {
  /**
   * Search for existing ABHA profile by 14-digit ABHA number.
   */
  lookupByAbhaNumber(abhaNumber: string): Promise<AbhaLookupResult>;

  /**
   * Search for existing ABHA profile by ABHA Address (@abdm).
   */
  lookupByAbhaAddress(abhaAddress: string): Promise<AbhaLookupResult>;

  /**
   * Initiate Aadhaar / Mobile OTP for ABHA creation or verification.
   */
  initiateAuth(identifier: string, authMode: "MOBILE_OTP" | "AADHAAR_OTP"): Promise<AuthSession>;

  /**
   * Confirm OTP and retrieve verified ABHA profile.
   */
  confirmAuth(sessionId: string, otp: string): Promise<VerifiedAbhaProfile>;

  /**
   * Query patient consent status under ABDM Health Information Exchange.
   */
  getConsentArtefact(consentId: string): Promise<ConsentArtefactResult>;
}
```

---

## 4. Verification State Machine (Phase 4 Specification)

Entering an ABHA identifier does **NOT** constitute verification. The system manages the following explicit states:

```
[ Identifier Input ]
       │
       ▼
   "entered" ──────────► [ Adapter Check ]
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
       "not_configured"  "unavailable"   "lookup_pending"
        (No NHA keys)     (NHA Down)          │
                                              ▼
                                       [ OTP Challenge ]
                                              │
                                   ┌──────────┴──────────┐
                                   ▼                     ▼
                              "verified"      "verification_failed"
                           (abhaVerified=true)  (abhaVerified=false)
```

| `abhaStatus` DB Value | `abhaVerified` DB Flag | Description | Kiosk UX Display |
|---|---|---|---|
| `entered` | `false` | Patient entered 14-digit number or address | `ABHA Entered (Unverified)` |
| `lookup_pending` | `false` | Waiting for ABDM gateway response | `Verifying with ABDM...` |
| `verified` | `true` | Cryptographically validated via official OTP flow | `ABDM Verified ✅` |
| `verification_failed` | `false` | OTP mismatch or expired challenge | `Verification Incomplete (Proceeding with Mobile)` |
| `not_configured` | `false` | Sandbox / Live credentials not in `.env` | `ABHA Recorded (Integration Pending Sandbox)` |
| `unavailable` | `false` | ABDM Gateway network timeout / 503 | `ABDM Service Busy (Proceeding with Mobile)` |

### Database Persistence & Invariants:
1. **Authoritative Field**: `Patient.abhaStatus` is the canonical authoritative field in the database.
2. **Boolean Invariant**: `Patient.abhaVerified` is strictly computed as `(abhaStatus === "verified")`. It must never contradict `abhaStatus`.
3. **No Unauthenticated Verification**: No state may transition to `verified` without official National Health Authority (NHA) / ABDM cryptographic confirmation.


---

## 5. Integration Credentials & Sandbox Prerequisites

Live or Sandbox ABDM integration requires official NHA registration:
- `ABDM_BASE_URL`: e.g. `https://dev.abdm.gov.in/gateway`
- `ABDM_CLIENT_ID`: Official Client ID assigned by NHA
- `ABDM_CLIENT_SECRET`: Secret key for token exchange
- `ABDM_FACILITY_ID`: Registered Healthcare Facility HFR ID

> **Truthfulness Mandate**:
> In the absence of valid NHA Sandbox credentials, the adapter returns `not_configured`. The system **never fabricates verification**, generates fake OTPs, or presents self-signed synthetic profiles as live ABDM verifications. Kiosk registration continues unhindered via the mobile-first pathway.
