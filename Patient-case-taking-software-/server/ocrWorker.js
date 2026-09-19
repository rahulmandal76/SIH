import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { extractClinicalDate } from "./documentIngestion.js";

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

    // Update document record
    await this.prisma.document.update({
      where: { documentId: doc.documentId },
      data: {
        totalPages: result.totalPages || pages.length || 1,
        status: "ready",
        clinicalDate: detectedClinicalDate || doc.clinicalDate
      }
    });

    // Finalize job
    if (job) {
      await this.prisma.documentProcessingJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
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

    await this.prisma.document.update({
      where: { documentId: doc.documentId },
      data: {
        totalPages: 1,
        status: "ready",
        clinicalDate: detectedClinicalDate || doc.clinicalDate
      }
    });

    if (job) {
      await this.prisma.documentProcessingJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          completedAt: new Date()
        }
      });
    }
  }

  /**
   * Fetch extracted pages for a document (defaults to current derivativeVersion if not specified)
   */
  async getDocumentPages(documentId, version) {
    const where = { documentId };
    if (version !== undefined) {
      where.version = version;
    } else {
      const doc = await this.prisma.document.findUnique({
        where: { documentId },
        select: { derivativeVersion: true }
      });
      if (doc) {
        where.version = doc.derivativeVersion;
      }
    }
    return this.prisma.documentPage.findMany({
      where,
      orderBy: { pageNumber: "asc" }
    });
  }

  /**
   * Fetch full lifecycle status of a document
   */
  async getDocumentStatus(documentId) {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      include: {
        jobs: { orderBy: { id: "desc" }, take: 1 }
      }
    });
    if (!doc) return null;
    const pages = await this.prisma.documentPage.findMany({
      where: { documentId, version: doc.derivativeVersion },
      orderBy: { pageNumber: "asc" }
    });
    return { ...doc, pages };
  }
}
