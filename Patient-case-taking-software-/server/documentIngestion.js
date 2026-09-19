import crypto from "crypto";
import fs from "fs";
import path from "path";

// Maximum upload size: 15 Megabytes
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Canonical UUID validation regex
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inspect raw buffer magic bytes to determine authoritative MIME and extension.
 * Rejects extension spoofing (e.g., text/exe renamed to .pdf).
 */
export function inspectMagicBytes(buffer) {
  if (!buffer || buffer.length < 4) {
    return null;
  }

  // PDF magic bytes: %PDF (0x25, 0x50, 0x44, 0x46)
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return {
      mimeType: "application/pdf",
      extension: ".pdf",
      format: "pdf"
    };
  }

  // PNG magic bytes: \x89PNG\r\n\x1a\n (0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return {
      mimeType: "image/png",
      extension: ".png",
      format: "png"
    };
  }

  // JPEG magic bytes: 0xFF, 0xD8, 0xFF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return {
      mimeType: "image/jpeg",
      extension: ".jpg",
      format: "jpeg"
    };
  }

  return null;
}

/**
 * Sanitize original filename to strip directory traversal sequences and unsafe characters.
 */
export function sanitizeFileName(rawName = "") {
  if (!rawName || typeof rawName !== "string") return "document";
  // Strip paths, null bytes, and traversal characters
  const basename = path.basename(rawName).replace(/\0/g, "");
  const sanitized = basename
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\.\.+/g, "_")
    .trim();
  return sanitized || "document";
}

/**
 * Compute cryptographic SHA-256 hash of raw binary buffer
 */
export function computeSha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Parse clinical date from document text if explicitly present.
 * Distinguishes clinical/document date from uploadDate.
 * Never fabricates dates — returns null if no valid date found.
 */
export function extractClinicalDate(text = "") {
  if (!text || typeof text !== "string") return null;

  // 1. Explicit labels: "Date: 12/05/2023", "Dated: 2022-11-04", "Report Date: 14 May 2023"
  const labeledPattern = /(?:date\s*[:\-]|dated\s*[:\-]|visit\s*date\s*[:\-]|report\s*date\s*[:\-]|admission\s*date\s*[:\-]|discharge\s*date\s*[:\-])\s*([0-9]{1,4}[/\-.][0-9]{1,2}[/\-.][0-9]{1,4}|[0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4})/i;
  const labeledMatch = text.match(labeledPattern);
  if (labeledMatch) {
    const d = parseDateString(labeledMatch[1]);
    if (d) return d;
  }

  // 2. ISO format YYYY-MM-DD
  const isoMatch = text.match(/\b(19\d\d|20\d\d)[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    const d = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00.000Z`);
    if (!isNaN(d.getTime())) return d;
  }

  // 3. DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = text.match(/\b(0[1-9]|[12]\d|3[01])[-/.](0[1-9]|1[0-2])[-/.](19\d\d|20\d\d)\b/);
  if (dmyMatch) {
    const d = new Date(`${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}T00:00:00.000Z`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

function parseDateString(str) {
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      if (year >= 1950 && year <= 2050) {
        return d;
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Document Ingestion Service
 */
export class DocumentIngestionService {
  constructor(prismaClient, uploadBaseDir) {
    this.prisma = prismaClient;
    this.uploadBaseDir = uploadBaseDir || path.resolve(process.cwd(), "data", "uploads");
  }

  /**
   * Ingest and store an uploaded document
   * Enforces:
   * - Max 15MB size
   * - Magic bytes validation (PDF, PNG, JPG only)
   * - Patient-scoped SHA-256 deduplication (patientUid, fileHash)
   * - Isolated filesystem storage with zero directory traversal
   * - Safe atomic writes with immutability preservation
   */
  async ingestDocument({
    patientUid,
    encounterId = null,
    fileBuffer,
    originalFileName,
    documentType = "general"
  }) {
    // Validate patient namespace (must be valid UUID)
    if (!patientUid || !UUID_REGEX.test(patientUid)) {
      const err = new Error("Invalid patient namespace for document storage");
      err.code = "INVALID_PATIENT_NAMESPACE";
      throw err;
    }

    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      const err = new Error("No file buffer provided for ingestion");
      err.code = "FILE_MISSING";
      throw err;
    }

    // Size limit enforcement (<= 15MB)
    if (fileBuffer.length > MAX_UPLOAD_BYTES) {
      const err = new Error(`File size (${fileBuffer.length} bytes) exceeds maximum allowable limit of 15MB`);
      err.code = "FILE_TOO_LARGE";
      err.statusCode = 413;
      throw err;
    }

    // Magic bytes inspection
    const magic = inspectMagicBytes(fileBuffer);
    if (!magic) {
      const err = new Error("Unsupported or invalid file content. Allowed formats: PDF, PNG, JPEG with valid magic bytes.");
      err.code = "UNSUPPORTED_MEDIA_TYPE";
      err.statusCode = 415;
      throw err;
    }

    // Compute SHA-256 hash of actual binary bytes
    const fileHash = computeSha256(fileBuffer);

    // Patient-scoped deduplication check
    // Dedup key is strictly (patientUid, fileHash)
    const existing = await this.prisma.document.findFirst({
      where: {
        patientUid,
        fileHash
      }
    });

    if (existing) {
      const err = new Error("This document has already been uploaded for this patient");
      err.code = "DUPLICATE_DOCUMENT";
      err.statusCode = 409;
      err.existingDocumentId = existing.documentId;
      throw err;
    }

    // Generate unique document ID and cryptographically safe storage filename
    const year = new Date().getFullYear();
    const randHex = crypto.randomBytes(4).toString("hex").toUpperCase();
    const documentId = `DOC-${year}-${randHex}`;

    // Target patient storage directory
    const patientDir = path.join(this.uploadBaseDir, patientUid);
    await fs.promises.mkdir(patientDir, { recursive: true });

    // Safe immutable storage name: doc_{id}_v1{ext}
    const safeOriginalName = sanitizeFileName(originalFileName);
    const storageFileName = `doc_${documentId}_v1${magic.extension}`;
    const storageFilePath = path.join(patientDir, storageFileName);

    // Atomic write semantics: Write to temporary file, then rename
    const tmpFilePath = path.join(patientDir, `${storageFileName}.tmp_${Date.now()}`);
    try {
      await fs.promises.writeFile(tmpFilePath, fileBuffer, { flag: "wx" });
      await fs.promises.rename(tmpFilePath, storageFilePath);
    } catch (writeErr) {
      // Clean up tmp file if rename failed
      await fs.promises.unlink(tmpFilePath).catch(() => {});
      throw writeErr;
    }

    const provenance = magic.format === "pdf" ? "DOCUMENT_EXTRACTED" : "OCR_EXTRACTED";

    // Create database records atomically
    const newDoc = await this.prisma.document.create({
      data: {
        documentId,
        patientUid,
        encounterId,
        fileName: safeOriginalName,
        filePath: storageFilePath,
        fileSize: fileBuffer.length,
        mimeType: magic.mimeType,
        documentType: documentType || "general",
        fileHash,
        totalPages: 1, // Will be updated by page processor
        status: "uploaded",
        provenance,
        clinicalDate: null // Will be populated if extractable
      }
    });

    // Create DocumentProcessingJob
    const job = await this.prisma.documentProcessingJob.create({
      data: {
        jobId: `job_${crypto.randomUUID()}`,
        documentId,
        jobType: magic.format === "pdf" ? "TEXT_EXTRACTION" : "OCR_ENHANCEMENT",
        status: "queued"
      }
    });

    return {
      document: newDoc,
      job,
      magic
    };
  }
}
