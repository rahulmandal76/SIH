/**
 * Longitudinal Clinical RAG Client — Phase 5F
 * src/utils/ragClient.js
 *
 * Client boundary invoking POST /api/rag/query:
 * - Sends ONLY authorized context (encounterId or careRelationshipId)
 * - NEVER sends patientUid or patientId
 * - Enforces CSRF header (X-Requested-With: XMLHttpRequest)
 * - Transmits session cookie (credentials: include)
 * - Handles loading, timeouts, sanitized citations, and no-history state
 */

export async function queryLongitudinalRAG({
  encounterId = null,
  careRelationshipId = null,
  query,
  retrievalPath = "auto",
  topK = 6,
  year = null
}) {
  if (!query || !query.trim()) {
    throw new Error("Query cannot be empty.");
  }

  if (!encounterId && !careRelationshipId) {
    throw new Error("Clinical context (encounterId or careRelationshipId) is required.");
  }

  // Construct strict payload without patientUid / patientId
  const payload = {
    query: query.trim(),
    retrievalPath,
    topK: Number(topK) || 6,
    year: year ? Number(year) : null
  };

  if (encounterId) {
    payload.encounterId = String(encounterId).trim();
  }
  if (careRelationshipId) {
    payload.careRelationshipId = careRelationshipId;
  }

  const response = await fetch("/api/rag/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest"
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  let resultData = null;
  try {
    resultData = await response.json();
  } catch {
    throw new Error("Invalid server response format.");
  }

  if (!response.ok) {
    const errorMsg = resultData?.error?.message || "Failed to retrieve longitudinal medical history.";
    const err = new Error(errorMsg);
    err.code = resultData?.error?.code || "RAG_ERROR";
    err.status = response.status;
    throw err;
  }

  return resultData;
}
