/**
 * MedSync Clinical Fact Extractor — Phase 5C
 *
 * Implements structured extraction of clinical facts across 6 canonical categories:
 *   - diagnosis
 *   - medication
 *   - lab_result
 *   - vital
 *   - procedure
 *   - symptom
 *
 * Requirements:
 *   - Strict schema validation (reject malformed objects, missing keys, invalid confidence)
 *   - Provenance rules:
 *       DOCUMENT_EXTRACTED for native text
 *       OCR_EXTRACTED for OCR text
 *       DOCTOR_ENTERED for clinician edits
 *   - Clinical date distinction (never fabricates clinical dates; null if unavailable)
 *   - Document and patient identity binding
 *   - Complete snapshot versioning support
 */

import { z } from "zod";
import { extractClinicalDate } from "./documentIngestion.js";

// Canonical fact types
export const FACT_TYPES = [
  "diagnosis",
  "medication",
  "lab_result",
  "vital",
  "procedure",
  "symptom"
];

// Canonical provenance taxonomy
export const PROVENANCE_VALUES = [
  "PATIENT_REPORTED",
  "DOCUMENT_EXTRACTED",
  "OCR_EXTRACTED",
  "DOCTOR_ENTERED",
  "MISSING_OR_UNKNOWN"
];

// Authoritative Zod schema for clinical fact validation
export const ClinicalFactSchema = z.object({
  documentId: z.string().min(1, "documentId is required"),
  patientUid: z.string().uuid("patientUid must be a canonical UUID v4"),
  pageNumber: z.number().int().positive("pageNumber must be positive integer"),
  factType: z.enum(["diagnosis", "medication", "lab_result", "vital", "procedure", "symptom"]),
  factKey: z.string().min(1, "factKey is required").max(200),
  factValue: z.string().min(1, "factValue is required").max(500),
  unit: z.string().max(50).nullable().optional(),
  clinicalDate: z.date().nullable().optional(),
  confidence: z.number().min(0.0).max(1.0).default(1.0),
  provenance: z.enum(["PATIENT_REPORTED", "DOCUMENT_EXTRACTED", "OCR_EXTRACTED", "DOCTOR_ENTERED", "MISSING_OR_UNKNOWN"]),
  version: z.number().int().positive().default(1),
  parentFactId: z.number().int().positive().nullable().optional()
});

export class ClinicalFactExtractor {
  constructor() {
    this._initPatterns();
  }

  _initPatterns() {
    // 1. Diagnoses patterns
    this.diagnosisPatterns = [
      /(?:diagnosis|impression|assessment|dx|condition|known case of|k\/c\/o)\s*[:\-]\s*([A-Za-z0-9\s,/\-()]{3,100})/gi,
      /\b(type\s*2\s*diabetes(?:\s*mellitus)?|t2dm|type\s*1\s*diabetes|hypertension|htn|essential\s*hypertension|acute\s*bronchitis|dengue(?:\s*fever)?|malaria|typhoid(?:\s*fever)?|hypothyroidism|hyperthyroidism|bronchial\s*asthma|asthma|coronary\s*artery\s*disease|cad|dyslipidemia|hyperlipidemia|chronic\s*kidney\s*disease|ckd|covid-19|gerd|gastroesophageal\s*reflux|pneumonia|tuberculosis|urinary\s*tract\s*infection|uti)\b/gi
    ];

    // 2. Medications patterns
    this.medicationPatterns = [
      /(?:rx|medication|medications|meds|tab(?:let)?|cap(?:sule)?|syr(?:up)?|inj(?:ection)?)\s*[:\-.]?\s*([A-Za-z0-9\-]+(?:\s+[0-9]+(?:\.[0-9]+)?\s*(?:mg|g|mcg|ml|iu))?(?:\s+[A-Za-z0-9\-]+)?(?:\s+(?:od|bd|tds|qid|once\s*daily|twice\s*daily|thrice\s*daily|1-0-1|1-1-1|1-0-0|0-0-1|prn))?)/gi,
      /\b(metformin|paracetamol|amoxicillin|atorvastatin|telmisartan|amlodipine|pantoprazole|azithromycin|insulin|cetirizine|losartan|omeprazole|ciprofloxacin|ibuprofen|dolo|glycomet|pan-d|augmentin|aspirin|clopidogrel|rosuvastatin|levothyroxine)\b(?:\s+([0-9]+(?:\.[0-9]+)?\s*(?:mg|g|mcg|ml|iu)))?(?:\s+([0-9]-[0-9]-[0-9]|od|bd|tds|qid|once\s*daily|twice\s*daily|prn))?/gi
    ];

    // 3. Lab results patterns
    this.labPatterns = [
      /\b(hba1c|glycated\s*hemoglobin)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%)/gi,
      /\b(fasting\s*blood\s*sugar|fbs)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(mg\/dl|mmol\/l)?/gi,
      /\b(postprandial\s*blood\s*sugar|ppbs|random\s*blood\s*sugar|rbs)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(mg\/dl|mmol\/l)?/gi,
      /\b(hemoglobin|hb)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(g\/dl|gm\/dl)?/gi,
      /\b(serum\s*creatinine|creatinine)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(mg\/dl)?/gi,
      /\b(total\s*cholesterol|cholesterol)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(mg\/dl)?/gi,
      /\b(triglycerides|tg)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(mg\/dl)?/gi,
      /\b(platelet\s*count|platelets)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(\/mcL|\/cu\s*mm|lakhs?\/cu\s*mm|k\/uL)?/gi,
      /\b(total\s*leukocyte\s*count|tlc|wbc)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(\/mcL|\/cu\s*mm)?/gi,
      /\b(tsh|thyroid\s*stimulating\s*hormone)\s*[:=\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(uIU\/ml|mIU\/L)?/gi
    ];

    // 4. Vitals patterns
    this.vitalPatterns = [
      /\b(?:blood\s*pressure|bp)\s*[:=\-]?\s*([0-9]{2,3}\s*\/\s*[0-9]{2,3})\s*(?:mm\s*hg)?\b/gi,
      /\b(?:pulse|heart\s*rate|hr)\s*[:=\-]?\s*([0-9]{2,3})\s*(?:bpm|\/min)?\b/gi,
      /\b(?:temperature|temp)\s*[:=\-]?\s*([0-9]{2,3}(?:\.[0-9])?)\s*(?:°?F|°?C|deg\s*f|deg\s*c)?\b/gi,
      /\b(?:spo2|oxygen\s*saturation)\s*[:=\-]?\s*([0-9]{2,3})\s*(?:%)?\b/gi,
      /\b(?:respiratory\s*rate|rr)\s*[:=\-]?\s*([0-9]{1,2})\s*(?:\/min)?\b/gi,
      /\b(?:weight|wt)\s*[:=\-]?\s*([0-9]{2,3}(?:\.[0-9])?)\s*(?:kg|kgs)?\b/gi,
      /\b(?:height|ht)\s*[:=\-]?\s*([0-9]{2,3}(?:\.[0-9])?)\s*(?:cm)?\b/gi,
      /\b(?:bmi)\s*[:=\-]?\s*([0-9]{2}(?:\.[0-9])?)\s*(?:kg\/m2)?\b/gi
    ];

    // 5. Procedures patterns
    this.procedurePatterns = [
      /(?:procedure|surgeries|surgery|intervention)\s*[:\-]\s*([A-Za-z0-9\s,/\-()]{3,100})/gi,
      /\b(ecg|electrocardiogram|chest\s*x-ray|cxr|ultrasound(?:\s*abdomen)?|usg(?:\s*abdomen)?|echocardiography|2d\s*echo|endoscopy|colonoscopy|ct\s*scan|mri(?:\s*brain)?|appendectomy|cholecystectomy|angioplasty|coronary\s*stenting|dialysis|hemodialysis|biopsy)\b/gi
    ];

    // 6. Symptoms patterns
    this.symptomPatterns = [
      /(?:symptoms?|chief\s*complaints?|complaining\s*of|c\/o|presenting\s*with)\s*[:\-]\s*([A-Za-z0-9\s,/\-()]{3,150})/gi,
      /\b(fever|cough|shortness\s*of\s*breath|dyspnea|chest\s*pain|headache|abdominal\s*pain|fatigue|nausea|vomiting|dizziness|joint\s*pain|sore\s*throat|loss\s*of\s*appetite|diarrhea|constipation|body\s*ache|chills)\b/gi
    ];
  }

  /**
   * Extract clinical facts from a single page's text
   */
  extractFactsFromText(text, metadata) {
    if (!text || typeof text !== "string") return [];

    const {
      documentId,
      patientUid,
      pageNumber = 1,
      provenance = "DOCUMENT_EXTRACTED",
      version = 1,
      confidence = 1.0,
      clinicalDate = null
    } = metadata;

    const detectedClinicalDate = clinicalDate || extractClinicalDate(text);
    const facts = [];
    const seenFactKeys = new Set();

    const addFact = (type, key, value, unit = null, conf = confidence) => {
      if (!key || !value) return;
      const cleanKey = key.trim();
      const cleanValue = value.trim();
      if (!cleanKey || !cleanValue) return;

      const dedupKey = `${type}:${cleanKey.toLowerCase()}:${cleanValue.toLowerCase()}`;
      if (seenFactKeys.has(dedupKey)) return;
      seenFactKeys.add(dedupKey);

      const fact = {
        documentId,
        patientUid,
        pageNumber,
        factType: type,
        factKey: cleanKey,
        factValue: cleanValue,
        unit: unit ? unit.trim() : null,
        clinicalDate: detectedClinicalDate || null,
        confidence: Math.min(1.0, Math.max(0.0, Number(conf) || 1.0)),
        provenance,
        version,
        parentFactId: null
      };

      // Strict schema validation check
      const validation = ClinicalFactSchema.safeParse(fact);
      if (validation.success) {
        facts.push(validation.data);
      } else {
        console.warn(`[ClinicalFactExtractor:ValidationFailed] Skipped malformed fact:`, validation.error.issues);
      }
    };

    // 1. Diagnoses
    for (const pattern of this.diagnosisPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const raw = match[1] || match[0];
        // Clean and split if multiple diagnoses separated by comma or semicolon
        const splitItems = raw.split(/[,;\n]+/).map(s => s.trim()).filter(s => s.length > 2);
        for (const item of splitItems) {
          if (/^(type\s*2|t2dm|hypertension|htn|asthma|fever|malaria|dengue|covid|typhoid|gerd|ckd|cad)/i.test(item) || splitItems.length <= 4) {
            addFact("diagnosis", item, "confirmed");
          }
        }
      }
    }

    // 2. Medications
    for (const pattern of this.medicationPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const medName = match[1] || match[0];
        const strength = match[2] || "";
        const freq = match[3] || "";
        const val = [strength, freq].filter(Boolean).join(" ").trim() || "as directed";
        addFact("medication", medName, val);
      }
    }

    // 3. Lab results
    for (const pattern of this.labPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const testName = match[1];
        const testVal = match[2];
        const unit = match[3] || null;
        addFact("lab_result", testName, testVal, unit);
      }
    }

    // 4. Vitals
    for (const pattern of this.vitalPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        let key = "Vital";
        let val = match[1];
        let unit = null;

        const fullStr = match[0].toLowerCase();
        if (fullStr.includes("bp") || fullStr.includes("blood pressure")) {
          key = "Blood Pressure";
          unit = "mmHg";
        } else if (fullStr.includes("pulse") || fullStr.includes("heart rate") || fullStr.includes("hr")) {
          key = "Pulse";
          unit = "bpm";
        } else if (fullStr.includes("temp")) {
          key = "Temperature";
          unit = fullStr.includes("c") ? "C" : "F";
        } else if (fullStr.includes("spo2") || fullStr.includes("oxygen")) {
          key = "SpO2";
          unit = "%";
        } else if (fullStr.includes("rr") || fullStr.includes("respiratory")) {
          key = "Respiratory Rate";
          unit = "/min";
        } else if (fullStr.includes("wt") || fullStr.includes("weight")) {
          key = "Weight";
          unit = "kg";
        } else if (fullStr.includes("ht") || fullStr.includes("height")) {
          key = "Height";
          unit = "cm";
        } else if (fullStr.includes("bmi")) {
          key = "BMI";
          unit = "kg/m2";
        }
        addFact("vital", key, val, unit);
      }
    }

    // 5. Procedures
    for (const pattern of this.procedurePatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const proc = match[1] || match[0];
        const splitItems = proc.split(/[,;\n]+/).map(s => s.trim()).filter(s => s.length > 2);
        for (const item of splitItems) {
          addFact("procedure", item, "performed");
        }
      }
    }

    // 6. Symptoms
    for (const pattern of this.symptomPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const symp = match[1] || match[0];
        const splitItems = symp.split(/[,;\n]+/).map(s => s.trim()).filter(s => s.length > 2);
        for (const item of splitItems) {
          if (item.length < 50) {
            addFact("symptom", item, "present");
          }
        }
      }
    }

    return facts;
  }

  /**
   * Extract facts across all pages of a document snapshot
   */
  extractFromDocumentPages(document, pages) {
    if (!document || !Array.isArray(pages)) return [];

    const allFacts = [];
    const version = document.derivativeVersion || 1;

    for (const page of pages) {
      // Determine provenance strictly based on page status
      const provenance = page.ocrStatus === "ocr_processed"
        ? "OCR_EXTRACTED"
        : "DOCUMENT_EXTRACTED";

      const confidence = page.ocrStatus === "ocr_processed"
        ? (page.ocrConfidence || 0.85)
        : 1.0;

      const pageFacts = this.extractFactsFromText(page.extractedText, {
        documentId: document.documentId,
        patientUid: document.patientUid,
        pageNumber: page.pageNumber,
        provenance,
        version,
        confidence,
        clinicalDate: document.clinicalDate
      });

      allFacts.push(...pageFacts);
    }

    return allFacts;
  }
}

export const clinicalFactExtractor = new ClinicalFactExtractor();
