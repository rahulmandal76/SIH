/**
 * ABDM / NHA Gateway Truthful Integration Adapter
 * Unified Healthcare Intelligence Platform: MedSync + AuraHealth Nexus
 *
 * Specification:
 * - Allowed abhaStatus values:
 *     entered, lookup_pending, verified, verification_failed, not_configured, unavailable
 * - Invariant: abhaVerified === (abhaStatus === "verified")
 * - Entering an ABHA identifier never produces "verified" without official gateway confirmation.
 * - Absence of live credentials in .env strictly yields "not_configured".
 * - Live ABDM/NHA production integration is out of scope in Phase 4.
 */

export const ALLOWED_ABHA_STATUSES = [
  "entered",
  "lookup_pending",
  "verified",
  "verification_failed",
  "not_configured",
  "unavailable"
];

/**
 * Evaluates provided ABHA identifiers and returns the truthful status and boolean flag.
 * In Phase 4 development, without live ABDM credentials, returns "not_configured" (or "entered")
 * with abhaVerified strictly false.
 */
export function evaluateAbhaStatus(abhaNumber, abhaAddress) {
  const hasAbha = Boolean(abhaNumber || abhaAddress);

  if (!hasAbha) {
    return {
      abhaStatus: "not_configured",
      abhaVerified: false
    };
  }

  const clientId = process.env.ABDM_CLIENT_ID;
  const clientSecret = process.env.ABDM_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      abhaStatus: "not_configured",
      abhaVerified: false,
      reason: "Official ABDM gateway credentials not configured in environment"
    };
  }

  // If credentials were provided but real gateway is not active/mocked:
  return {
    abhaStatus: "entered",
    abhaVerified: false,
    reason: "ABHA recorded. Gateway verification pending official sandbox/live OTP flow"
  };
}

/**
 * Validates the strict boolean invariant.
 */
export function validateAbhaInvariant(abhaStatus, abhaVerified) {
  return abhaVerified === (abhaStatus === "verified");
}
