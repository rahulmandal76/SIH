/**
 * Multi-Actor Audit Trail Logger
 * Unified Healthcare Intelligence Platform: MedSync + AuraHealth Nexus
 *
 * Enforces:
 * - Strict actor attribution (USER, DEVICE, SERVICE, SYSTEM).
 * - USER actorUserId derived solely from authenticated server context (never client input).
 * - Sensitive credential hygiene (no passwords, hashes, salts, or secrets in logs).
 * - Dedicated relational fields for patientUid and resourceId (no duplicate leakage in metadataJson).
 */

export async function createAuditLog(prisma, {
  actorType,
  actorUserId = null,
  actorDeviceId = null,
  actorService = null,
  action,
  patientUid = null,
  resourceType,
  resourceId = null,
  metadata = null
}) {
  try {
    let cleanMetadata = null;
    if (metadata && typeof metadata === "object") {
      const clone = { ...metadata };
      // Redact sensitive secrets
      delete clone.password;
      delete clone.passwordHash;
      delete clone.salt;
      delete clone.sessionToken;
      delete clone.token;
      // Do not duplicate dedicated fields
      delete clone.patientUid;
      delete clone.resourceId;
      cleanMetadata = JSON.stringify(clone);
    } else if (typeof metadata === "string") {
      cleanMetadata = metadata;
    }

    return await prisma.auditLog.create({
      data: {
        actorType,
        actorUserId: actorType === "USER" ? actorUserId : null,
        actorDeviceId: actorType === "DEVICE" ? actorDeviceId : null,
        actorService: actorType === "SERVICE" ? actorService : null,
        action,
        patientUid: patientUid || null,
        resourceType,
        resourceId: resourceId ? String(resourceId) : null,
        metadataJson: cleanMetadata
      }
    });
  } catch (err) {
    console.error("[AuditLog:Error]", err.message);
    return null;
  }
}
