import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { extractClinicalDate } from "./documentIngestion.js";
import { documentAiExtractor } from "./documentAiExtractor.js";

const execFileAsync = promisify(execFile);

export class DocumentOCRWorker {
  constructor(prismaClient) {
    this.prisma = prismaClient;
    this.pdfScriptPath = path.resolve(process.cwd(), "Patient-case-taking-software-", "server", "extract_pdf_pages.py");
    this.ocrScriptPath = path.resolve(process.cwd(), "Patient-case-taking-software-", "server", "ocr_helper.py");
  }

  /**
   * Process a document processing job by documentId
   */
  async processDocument(documentId) {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      include: { jobs: { orderBy: { id: "desc" }, take: 1 } }
    });

    if (!doc) {
      throw new Error(`Document not found for processing: ${documentId}`);
    }

    const job = doc.jobs && doc.jobs.length > 0 ? doc.jobs[0] : null;

    // Update document and job to processing
    await this.prisma.document.update({
      where: { documentId },
      data: { status: "processing" }
    });

    if (job) {
      await this.prisma.documentProcessingJob.update({
        where: { id: job.id },
        data: { status: "processing", startedAt: new Date() }
      });
    }

    try {
      if (doc.mimeType === "application/pdf") {
        await this._processPdf(doc, job);
      } else if (doc.mimeType === "image/png" || doc.mimeType === "image/jpeg") {
        await this._processImage(doc, job);
      } else {
        throw new Error(`Unsupported document MIME type: ${doc.mimeType}`);
      }
    } catch (err) {
      // Deterministic error state recording
      await this.prisma.document.update({
        where: { documentId },
        data: { status: "failed" }
      }).catch(() => {});

      if (job) {
        await this.prisma.documentProcessingJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            errorDetails: err.message || "Unknown processing error",
            completedAt: new Date()
          }
        }).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Internal PDF processing using pypdf
   */
  async _processPdf(doc, job) {
    let result = null;
    try {
      const { stdout } = await execFileAsync("python", [this.pdfScriptPath, doc.filePath]);
      const raw = stdout.trim();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        result = JSON.parse(raw.substring(start, end + 1));
      } else {
        result = JSON.parse(raw);
      }
    } catch (e) {
      throw new Error(`PDF_EXTRACTION_FAILED: ${e.message}`);
    }

    if (!result || !result.success) {
      throw new Error(`PDF_PARSER_ERROR: ${result?.error || "Failed to extract PDF pages"}`);
    }

    const pages = result.pages || [];
    let detectedClinicalDate = null;

    for (const p of pages) {
      const pageText = p.text || "";
      if (!detectedClinicalDate) {
        detectedClinicalDate = extractClinicalDate(pageText);
      }

      await this.prisma.documentPage.upsert({
        where: {
          documentId_pageNumber_version: {
            documentId: doc.documentId,
            pageNumber: p.pageNumber,
            version: doc.derivativeVersion || 1
          }
        },
        update: {
          extractedText: pageText,
          ocrStatus: "native_text",
          ocrConfidence: 1.0
        },
        create: {
          documentId: doc.documentId,
          pageNumber: p.pageNumber,
          version: doc.derivativeVersion || 1,
          extractedText: pageText,
          ocrStatus: "native_text",
          ocrConfidence: 1.0
        }
      });
    }

    // Aggregate all page texts for structured clinical fact extraction
    const fullPdfText = pages.map(p => p.text || "").join("\n");
    let extraction = null;
    try {
      extraction = await documentAiExtractor.extractDocument({
        documentId: doc.documentId,
        patientUid: doc.patientUid,
        pageNumber: 1,
        filePath: doc.filePath,
        rawOcrText: fullPdfText,
        mimeType: doc.mimeType
      });

      if (extraction?.facts && extraction.facts.length > 0) {
        for (const f of extraction.facts) {
          await this.prisma.documentClinicalFact.create({
            data: {
              documentId: doc.documentId,
              patientUid: doc.patientUid,
              pageNumber: f.pageNumber || 1,
              factType: f.factType,
              factKey: f.factKey,
              factValue: f.factValue,
              unit: f.unit,
              clinicalDate: f.clinicalDate || detectedClinicalDate || doc.clinicalDate,
              confidence: f.confidence || 1.0,
              provenance: f.provenance || "DOCUMENT_EXTRACTED",
              version: doc.derivativeVersion || 1,
              evidenceStatus: f.evidenceStatus || "VERIFIED",
              boundingBox: f.boundingBox,
              sourceSnippet: f.sourceSnippet
            }
          }).catch(err => console.warn(`[PDF_FACT_PERSIST_WARN] ${err.message}`));
        }
      }
    } catch (extractErr) {
      console.warn(`[PDF_AI_EXTRACT_WARN] ${extractErr.message}`);
    }

    // Update document record
    await this.prisma.document.update({
      where: { documentId: doc.documentId },
      data: {
        totalPages: result.totalPages || pages.length || 1,
        status: "ready",
        clinicalDate: detectedClinicalDate || extraction?.clinicalDate || doc.clinicalDate
      }
    });

    // Finalize job
    if (job) {
      await this.prisma.documentProcessingJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          aiModel: extraction?.model || "gemini-2.5-flash",
          promptVersion: extraction?.promptVersion || "v2.1-clinical-fact-extraction",
          completedAt: new Date()
        }
      });
    }
  }

  /**
   * Internal Image processing using Tesseract / pytesseract
   */
  async _processImage(doc, job) {
    let result = null;
    try {
      const { stdout } = await execFileAsync("python", [this.ocrScriptPath, doc.filePath, "eng+hin"]);
      const raw = stdout.trim();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        result = JSON.parse(raw.substring(start, end + 1));
      } else {
        result = JSON.parse(raw);
      }
    } catch (e) {
      result = {
        success: false,
        error: `OCR_PROCESS_SPAWN_ERROR: ${e.message}`
      };
    }

    if (!result || !result.success) {
      // Deterministic OCR failure: Record page as ocr_failed
      await this.prisma.documentPage.upsert({
        where: {
          documentId_pageNumber_version: {
            documentId: doc.documentId,
            pageNumber: 1,
            version: doc.derivativeVersion || 1
          }
        },
        update: {
          extractedText: "",
          ocrStatus: "ocr_failed",
          ocrConfidence: 0.0
        },
        create: {
          documentId: doc.documentId,
          pageNumber: 1,
          version: doc.derivativeVersion || 1,
          extractedText: "",
          ocrStatus: "ocr_failed",
          ocrConfidence: 0.0
        }
      });

      // Update Document status to failed
      await this.prisma.document.update({
        where: { documentId: doc.documentId },
        data: { status: "failed" }
      });

      // Update Job status to failed
      if (job) {
        await this.prisma.documentProcessingJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            errorDetails: result?.error || "OCR engine failed or unavailable",
            completedAt: new Date()
          }
        });
      }

      const err = new Error(result?.error || "OCR engine failed or unavailable");
      err.code = "OCR_FAILED";
      throw err;
    }

    // OCR Success
    const ocrText = result.text || "";
    const confidence = typeof result.confidence === "number" ? result.confidence : 0.85;
    const detectedClinicalDate = extractClinicalDate(ocrText);

    await this.prisma.documentPage.upsert({
      where: {
        documentId_pageNumber_version: {
          documentId: doc.documentId,
          pageNumber: 1,
          version: doc.derivativeVersion || 1
        }
      },
      update: {
        extractedText: ocrText,
        ocrStatus: "ocr_processed",
        ocrConfidence: confidence
      },
      create: {
        documentId: doc.documentId,
        pageNumber: 1,
        version: doc.derivativeVersion || 1,
        extractedText: ocrText,
        ocrStatus: "ocr_processed",
        ocrConfidence: confidence
      }
    });

    // Structured clinical fact extraction with multimodal Gemini & evidence verification
    let extraction = null;
    try {
      extraction = await documentAiExtractor.extractDocument({
        documentId: doc.documentId,
        patientUid: doc.patientUid,
        pageNumber: 1,
        filePath: doc.filePath,
        rawOcrText: ocrText,
        mimeType: doc.mimeType
      });

      if (extraction?.facts && extraction.facts.length > 0) {
        for (const f of extraction.facts) {
          await this.prisma.documentClinicalFact.create({
            data: {
              documentId: doc.documentId,
              patientUid: doc.patientUid,
              pageNumber: f.pageNumber || 1,
              factType: f.factType,
              factKey: f.factKey,
              factValue: f.factValue,
              unit: f.unit,
              clinicalDate: f.clinicalDate || detectedClinicalDate || doc.clinicalDate,
              confidence: f.confidence || confidence,
              provenance: f.provenance || "OCR_EXTRACTED",
              version: doc.derivativeVersion || 1,
              evidenceStatus: f.evidenceStatus || "VERIFIED",
              boundingBox: f.boundingBox,
              sourceSnippet: f.sourceSnippet
            }
          }).catch(err => console.warn(`[IMAGE_FACT_PERSIST_WARN] ${err.message}`));
        }
      }
    } catch (extractErr) {
      console.warn(`[IMAGE_AI_EXTRACT_WARN] ${extractErr.message}`);
    }

    await this.prisma.document.update({
      where: { documentId: doc.documentId },
      data: {
        totalPages: 1,
        status: "ready",
        clinicalDate: detectedClinicalDate || extraction?.clinicalDate || doc.clinicalDate
      }
    });

    if (job) {
      await this.prisma.documentProcessingJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          aiModel: extraction?.model || "gemini-2.5-flash",
          promptVersion: extraction?.promptVersion || "v2.1-clinical-fact-extraction",
          completedAt: new Date()
        }
      });
    }
  }

  /**
   * Fetch extracted pages for a document (defaults to current derivativeVersion if not specified)
   */
  async getDocumentPages(identifier, version) {
    const doc = await this.prisma.document.findFirst({
      where: {
        OR: [
          { documentId: identifier },
          { documentHandle: identifier }
        ]
      },
      select: { documentId: true, derivativeVersion: true }
    });
    const canonicalId = doc ? doc.documentId : identifier;
    const targetVersion = version !== undefined ? version : (doc ? doc.derivativeVersion : 1);
    return this.prisma.documentPage.findMany({
      where: {
        documentId: canonicalId,
        version: targetVersion
      },
      orderBy: { pageNumber: "asc" }
    });
  }

  /**
   * Fetch full lifecycle status of a document
   */
  async getDocumentStatus(identifier) {
    const doc = await this.prisma.document.findFirst({
      where: {
        OR: [
          { documentId: identifier },
          { documentHandle: identifier }
        ]
      },
      include: {
        jobs: { orderBy: { id: "desc" }, take: 1 }
      }
    });
    if (!doc) return null;
    const pages = await this.prisma.documentPage.findMany({
      where: { documentId: doc.documentId, version: doc.derivativeVersion },
      orderBy: { pageNumber: "asc" }
    });
    return { ...doc, pages };
  }

  /**
   * Recover abandoned job locks (jobs in 'processing' or 'locked' for > 5 minutes)
   */
  async recoverAbandonedLocks(timeoutMinutes = 5) {
    const staleThreshold = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    const recovered = await this.prisma.documentProcessingJob.updateMany({
      where: {
        status: { in: ["processing", "locked"] },
        startedAt: { lt: staleThreshold },
        retryCount: { lt: 3 }
      },
      data: {
        status: "queued"
      }
    }).catch(() => ({ count: 0 }));
    return recovered.count || 0;
  }

  /**
   * Atomically claim the next queued job for durable background worker processing
   */
  async claimNextJob() {
    await this.recoverAbandonedLocks();

    const pendingJob = await this.prisma.documentProcessingJob.findFirst({
      where: {
        status: "queued",
        retryCount: { lt: 3 }
      },
      orderBy: { id: "asc" }
    });

    if (!pendingJob) return null;

    // Atomically claim by transitioning status to 'processing'
    const claimed = await this.prisma.documentProcessingJob.update({
      where: { id: pendingJob.id },
      data: {
        status: "processing",
        startedAt: new Date(),
        retryCount: { increment: 1 }
      }
    }).catch(() => null);

    return claimed;
  }
}
