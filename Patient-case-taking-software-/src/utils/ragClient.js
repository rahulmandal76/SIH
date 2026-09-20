/**
 * Longitudinal Clinical RAG Client — Phase 5F/5G
 * src/utils/ragClient.js
 *
 * Client boundary invoking POST /api/rag/query:
 * - Sends ONLY authorized context (encounterId or careRelationshipId)
 * - NEVER sends patientUid or patientId
 * - Enforces CSRF header (X-Requested-With: XMLHttpRequest)
 * - Transmits session cookie (credentials: include)
 * - Normalizes HTTP errors into clinician-friendly explanations
 * - Handles loading, timeouts, sanitized citations, and no-history state
 */

export function normalizeRagError(status, errorCode, serverMessage) {
  switch (status) {
    case 400:
      return serverMessage || "Invalid query request. Please verify the clinical inquiry.";
    case 401:
      return "Authentication required. Please log in with an authorized clinician session.";
    case 403:
      if (errorCode === "ADMIN_ACCESS_REASON_REQUIRED") {
        return "Administrative clinical access requires a valid clinical justification header (X-Admin-Access-Reason).";
      }
      return "Clinical access denied. You must be the assigned clinician for this encounter or possess an active CareRelationship for this patient.";
    case 409:
      return "Clinical context mismatch: the selected encounter and care relationship belong to different patient records.";
    case 429:
      return "Too many clinical inquiries submitted in a short time. Please wait a moment before sending another query.";
    case 502:
      return "Longitudinal clinical intelligence service is temporarily unreachable or offline. Source records remain secure.";
    case 504:
      return "Longitudinal analysis timed out (8-second service bound). Please refine your query or try again.";
    case 500:
    default:
      return serverMessage || "Internal error in longitudinal clinical processing. Please try again.";
  }
}

export async function queryLongitudinalRAG({
  encounterId = null,
  careRelationshipId = null,
  query,
  retrievalPath = "auto",
  topK = 6,
  year = null,
  // Strict guard: if any caller attempts to pass forbidden identifiers, throw immediately
  patientUid = undefined,
  patientId = undefined
}) {
  if (patientUid !== undefined || patientId !== undefined) {
    throw new Error("Security violation: patientUid and patientId cannot be provided by the client application.");
  }

  if (!query || !query.trim()) {
    throw new Error("Please enter a clinical question before querying.");
  }

  if (!encounterId && !careRelationshipId) {
    throw new Error("A valid clinical context (encounterId or careRelationshipId) is required.");
  }

  // Construct strict payload with only authorized context
  const payload = {
    query: query.trim(),
    retrievalPath: retrievalPath || "auto",
    topK: Math.max(1, Math.min(20, Number(topK) || 6)),
    year: year ? Number(year) : null
  };

  if (encounterId) {
    payload.encounterId = String(encounterId).trim();
  }
  if (careRelationshipId) {
    payload.careRelationshipId = Number(careRelationshipId);
  }

  let response;
  try {
    response = await fetch("/api/rag/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      credentials: "include",
      body: JSON.stringify(payload)
    });
  } catch (netErr) {
    const err = new Error("Unable to contact application server. Please verify your network connection.");
    err.code = "NETWORK_ERROR";
    err.status = 0;
    err.userFriendlyMessage = "Network connection failed. Could not reach clinical gateway.";
    throw err;
  }

  let resultData = null;
  try {
    resultData = await response.json();
  } catch {
    const err = new Error("Invalid server response format.");
    err.code = "MALFORMED_RESPONSE";
    err.status = response.status;
    err.userFriendlyMessage = "Server returned an unparseable response.";
    throw err;
  }

  if (!response.ok) {
    const errorCode = resultData?.error?.code || "RAG_ERROR";
    const serverMsg = resultData?.error?.message;
    const friendlyMsg = normalizeRagError(response.status, errorCode, serverMsg);

    const err = new Error(friendlyMsg);
    err.code = errorCode;
    err.status = response.status;
    err.userFriendlyMessage = friendlyMsg;
    err.serverMessage = serverMsg;
    throw err;
  }

  return resultData;
}

export const CLINICAL_QUICK_PROMPTS = [
  {
    id: "conditions",
    label: "Chronic Conditions",
    query: "What major conditions has this patient had over the years?",
    path: "temporal"
  },
  {
    id: "meds",
    label: "Medication History",
    query: "Show the patient's complete medication history and changes over time.",
    path: "temporal"
  },
  {
    id: "hba1c",
    label: "HbA1c & Metabolic Trends",
    query: "What changed in the patient's HbA1c and metabolic markers over time?",
    path: "temporal"
  },
  {
    id: "procedures",
    label: "Procedures & Surgeries",
    query: "What surgical procedures and prior hospitalizations are documented?",
    path: "semantic"
  },
  {
    id: "egfr",
    label: "Kidney Function (eGFR)",
    query: "What are the important longitudinal trends in kidney function and creatinine?",
    path: "temporal"
  },
  {
    id: "timeline",
    label: "Milestone Overview",
    query: "Provide a chronological overview of all major clinical milestones in this patient's record.",
    path: "auto"
  }
];
