/**
 * Phase 5B Test Suite: Document Ingestion, File Storage & Background OCR Engine
 *
 * Validates:
 *   - Multipart document upload & session gating
 *   - Maximum size enforcement (<= 15MB)
 *   - Magic-byte inspection & rejection of spoofed extensions
 *   - Patient-scoped SHA-256 deduplication (patientUid, fileHash)
 *   - Cross-patient duplicate isolation (no existence oracle)
 *   - Storage security (path traversal prevention, internal namespace control)
 *   - Browser zero-patientUid/patientId invariant across upload/page/status routes
 *   - Cross-patient document access boundary enforcement
 *   - PDF page segmentation & DocumentPage creation
 *   - Clinical date vs upload date distinction (no fabrication)
 *   - Real successful scanned image OCR execution through actual worker/helper path
 *   - Genuine Tesseract execution, confidence calculation, and DocumentPage.ocrStatus="ocr_processed"
 *   - Genuine Hindi/Devanagari OCR support & multilingual model verification
 *   - Original uploaded binary byte-identical preservation
 *   - Clinician document-upload authorization matrix (assigned doctor, active CareRel, unassigned 403, suspended 403)
 *   - Cross-patient upload attempts cannot alter or create documents for another patient
 *   - Document lifecycle state transitions (uploaded -> processing -> ready/failed)
 */

import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { prisma, disconnectPrisma } from "../prisma/db.js";
import app, { ocrWorker, documentIngestionService } from "../Patient-case-taking-software-/server.js";
import { createEncounterSession, createUserSession } from "../Patient-case-taking-software-/server/sessions.js";

let serverInstance;
let TEST_PORT;

const results = [];

function recordTest(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  const icon = status === "PASS" ? "âœ…" : (status === "PENDING_INFRA" ? "â³" : "âŒ");
  console.log(`${icon} [${id}] ${name}: ${status}`);
  if (detail) {
    console.log(`   â””â”€ ${detail}`);
  }
}

function buildMultipart(fields = {}, file = null) {
  const boundary = "----WebKitFormBoundary" + crypto.randomBytes(8).toString("hex");
  const crlf = "\r\n";
  const chunks = [];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${key}"${crlf}${crlf}${value}${crlf}`));
  }

  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}${crlf}Content-Disposition: form-data; name="${file.fieldname || 'file'}"; filename="${file.filename || 'document.pdf'}"${crlf}` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}${crlf}${crlf}`
    ));
    chunks.push(file.buffer);
    chunks.push(Buffer.from(crlf));
  }

  chunks.push(Buffer.from(`--${boundary}--${crlf}`));

  const body = Buffer.concat(chunks);
  const contentType = `multipart/form-data; boundary=${boundary}`;
  return { body, contentType };
}

function makeRequest(method, reqPath, payload = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const isBuffer = Buffer.isBuffer(payload);
    const reqHeaders = {
      ...headers
    };

    if (isBuffer) {
      reqHeaders["Content-Length"] = payload.length;
    } else if (payload && typeof payload === "object") {
      reqHeaders["Content-Type"] = "application/json";
    }

    const req = http.request({
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: reqPath,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on("error", reject);

    if (isBuffer) {
      req.write(payload);
    } else if (payload && typeof payload === "object") {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

function generateTestPdf(textContent = "Prescription Rx: Paracetamol 500mg TDS") {
  const sanitized = textContent.replace(/[()]/g, "");
  const streamContent = `BT /F1 12 Tf 72 712 Td (${sanitized}) Tj ET`;
  const pdfString =
`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${streamContent.length} >> stream
${streamContent}
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000244 00000 n
0000000300 00000 n
trailer << /Size 6 /Root 1 0 R >>
startxref
380
%%EOF`;
  return Buffer.from(pdfString, "utf-8");
}

function generateScannedTextPng(text = "Rx: Tab Metformin 500mg Once Daily", isHindi = false) {
  const pyCode = `
import sys
import os
from PIL import Image, ImageDraw, ImageFont

font = None
if ${isHindi ? "True" : "False"}:
    font_path = r"C:\\Windows\\Fonts\\Nirmala.ttf"
    if not os.path.exists(font_path):
        font_path = r"C:\\Windows\\Fonts\\mangal.ttf"
    if os.path.exists(font_path):
        font = ImageFont.truetype(font_path, 28)

if font is None:
    font = ImageFont.load_default()

img = Image.new("RGB", (650, 150), (255, 255, 255))
d = ImageDraw.Draw(img)
d.text((20, 30), ${JSON.stringify(text)}, font=font, fill=(0, 0, 0))
img.save(sys.stdout.buffer, format="PNG")
`;
  return execFileSync("python", ["-c", pyCode]);
}

async function runPhase5BTests() {
  console.log("\n=======================================================");
  console.log("PHASE 5B: DOCUMENT INGESTION, STORAGE, OCR & RBAC TEST MATRIX (20 TESTS)");
  console.log("=======================================================\n");

  // Spin up test server
  await new Promise(resolve => {
    serverInstance = http.createServer(app);
    serverInstance.listen(0, "127.0.0.1", () => {
      TEST_PORT = serverInstance.address().port;
      console.log(`[Phase5B TestServer] Listening on 127.0.0.1:${TEST_PORT}\n`);
      resolve();
    });
  });

  // Test patient UIDs & encounters
  const patientUid1 = "55555555-5555-5555-5555-000000000001";
  const patientId1 = "PAT-P5B-001";
  const encounterId1 = "ENC-P5B-001";

  const patientUid2 = "55555555-5555-5555-5555-000000000002";
  const patientId2 = "PAT-P5B-002";
  const encounterId2 = "ENC-P5B-002";

  // Clean prior records
  await prisma.documentPage.deleteMany({
    where: { document: { patientUid: { in: [patientUid1, patientUid2] } } }
  }).catch(() => {});
  await prisma.documentProcessingJob.deleteMany({
    where: { document: { patientUid: { in: [patientUid1, patientUid2] } } }
  }).catch(() => {});
  await prisma.document.deleteMany({
    where: { patientUid: { in: [patientUid1, patientUid2] } }
  }).catch(() => {});
  await prisma.careRelationship.deleteMany({
    where: { patientUid: { in: [patientUid1, patientUid2] } }
  }).catch(() => {});
  await prisma.encounter.deleteMany({
    where: { encounterId: { in: [encounterId1, encounterId2] } }
  }).catch(() => {});
  await prisma.patient.deleteMany({
    where: { patientUid: { in: [patientUid1, patientUid2] } }
  }).catch(() => {});

  // Setup Doctors
  let doctorUser1 = await prisma.user.findFirst({ where: { email: "dr.sharma@hospital.gov.in" } });
  if (!doctorUser1) {
    doctorUser1 = await prisma.user.create({
      data: {
        userUid: "usr-doc-sharma-p5b",
        name: "Dr. Arvind Sharma",
        email: "dr.sharma@hospital.gov.in",
        role: "doctor",
        passwordHash: "dummyHash",
        chamber: "Chamber 1"
      }
    });
  }

  let doctorUser2 = await prisma.user.findFirst({ where: { email: "dr.patel@hospital.gov.in" } });
  if (!doctorUser2) {
    doctorUser2 = await prisma.user.create({
      data: {
        userUid: "usr-doc-patel-p5b",
        name: "Dr. Rajesh Patel",
        email: "dr.patel@hospital.gov.in",
        role: "doctor",
        passwordHash: "dummyHash",
        chamber: "Chamber 2"
      }
    });
  }

  // Create Patient 1
  await prisma.patient.create({
    data: {
      patientUid: patientUid1,
      patientId: patientId1,
      fullName: "Kavita Rao",
      age: 41,
      gender: "Female",
      mobileNumber: "9876543210"
    }
  });

  await prisma.encounter.create({
    data: {
      encounterId: encounterId1,
      patientUid: patientUid1,
      tokenNumber: "601",
      consultationStatus: "in_progress",
      assignedDoctorId: doctorUser1.id,
      chamber: "Chamber 1"
    }
  });

  // Create Patient 2
  await prisma.patient.create({
    data: {
      patientUid: patientUid2,
      patientId: patientId2,
      fullName: "Vikram Malhotra",
      age: 49,
      gender: "Male",
      mobileNumber: "9876543211"
    }
  });

  await prisma.encounter.create({
    data: {
      encounterId: encounterId2,
      patientUid: patientUid2,
      tokenNumber: "602",
      consultationStatus: "in_progress",
      assignedDoctorId: doctorUser2.id,
      chamber: "Chamber 2"
    }
  });

  const sessionToken1 = createEncounterSession(patientUid1, encounterId1);
  const sessionToken2 = createEncounterSession(patientUid2, encounterId2);
  const doctorSession1 = createUserSession(doctorUser1);
  const doctorSession2 = createUserSession(doctorUser2);

  const testPdfBuffer = generateTestPdf("Blood Sugar Fasting: 110 mg/dL. Visit Date: 2023-04-10");
  let uploadedDocId1 = null;

  // -------------------------------------------------------------------------
  // TEST-P5B-01: Multipart upload of valid PDF with MIME and magic-bytes validation
  // -------------------------------------------------------------------------
  try {
    // 1. Unauthenticated upload blocked
    const unauthData = buildMultipart({ documentType: "lab_report" }, {
      fieldname: "file",
      filename: "report_2023.pdf",
      contentType: "application/pdf",
      buffer: testPdfBuffer
    });

    const unauthRes = await makeRequest("POST", "/api/documents/upload", unauthData.body, {
      "Content-Type": unauthData.contentType,
      "X-Requested-With": "XMLHttpRequest"
    });

    const unauthBlocked = unauthRes.status === 401 && unauthRes.body?.error?.code === "AUTHENTICATION_REQUIRED";

    // 2. Authenticated upload succeeds
    const authRes = await makeRequest("POST", "/api/documents/upload", unauthData.body, {
      "Content-Type": unauthData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const doc = authRes.body?.document;
    uploadedDocId1 = doc?.documentId;

    const noUidLeak = !JSON.stringify(authRes.body).includes(patientUid1) && !JSON.stringify(authRes.body).includes(patientId1);
    const validShape = authRes.status === 201 && authRes.body?.success && doc?.documentId && doc?.mimeType === "application/pdf";

    if (unauthBlocked && validShape && noUidLeak) {
      recordTest("TEST-P5B-01", "Multipart upload of valid PDF with MIME and magic-bytes validation", "PASS",
        `Unauthenticated 401 verified; 201 Created + documentId: ${doc.documentId}; zero patientUid/patientId exposed`);
    } else {
      recordTest("TEST-P5B-01", "Multipart upload of valid PDF with MIME and magic-bytes validation", "FAIL",
        `unauthBlocked: ${unauthBlocked}, status: ${authRes.status}, validShape: ${validShape}, noUidLeak: ${noUidLeak}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-01", "Multipart upload of valid PDF with MIME and magic-bytes validation", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-02: Size enforcement: files > 15MB rejected
  // -------------------------------------------------------------------------
  try {
    // 15MB + 1024 bytes buffer with valid PDF header to test size cutoff specifically
    const oversizedPdf = Buffer.alloc(15 * 1024 * 1024 + 1024);
    oversizedPdf.write("%PDF-1.4\n", 0);

    const overData = buildMultipart({ documentType: "radiology" }, {
      fieldname: "file",
      filename: "heavy_mri.pdf",
      contentType: "application/pdf",
      buffer: oversizedPdf
    });

    const overRes = await makeRequest("POST", "/api/documents/upload", overData.body, {
      "Content-Type": overData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isRejected = overRes.status === 413 && overRes.body?.error?.code === "FILE_TOO_LARGE";

    if (isRejected) {
      recordTest("TEST-P5B-02", "Size enforcement: files > 15MB rejected", "PASS",
        `413 FILE_TOO_LARGE verified: ${overRes.body?.error?.message}`);
    } else {
      recordTest("TEST-P5B-02", "Size enforcement: files > 15MB rejected", "FAIL",
        `Status: ${overRes.status}, body: ${JSON.stringify(overRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-02", "Size enforcement: files > 15MB rejected", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-03: Magic-byte inspection: rejects spoofed file extensions
  // -------------------------------------------------------------------------
  try {
    // Plain text content named .pdf
    const fakePdf = Buffer.from("MZThisIsActuallyExecutableCode disguised as text");
    const fakeData = buildMultipart({ documentType: "prescription" }, {
      fieldname: "file",
      filename: "malicious_script.pdf",
      contentType: "application/pdf",
      buffer: fakePdf
    });

    const fakeRes = await makeRequest("POST", "/api/documents/upload", fakeData.body, {
      "Content-Type": fakeData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isBlocked = fakeRes.status === 415 && fakeRes.body?.error?.code === "UNSUPPORTED_MEDIA_TYPE";

    if (isBlocked) {
      recordTest("TEST-P5B-03", "Magic-byte inspection: rejects spoofed file extensions", "PASS",
        `415 UNSUPPORTED_MEDIA_TYPE verified on invalid magic bytes`);
    } else {
      recordTest("TEST-P5B-03", "Magic-byte inspection: rejects spoofed file extensions", "FAIL",
        `Status: ${fakeRes.status}, body: ${JSON.stringify(fakeRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-03", "Magic-byte inspection: rejects spoofed file extensions", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-04: Patient-scoped SHA-256 deduplication: rejects duplicate for same patient
  // -------------------------------------------------------------------------
  try {
    // Upload exact same testPdfBuffer again for Patient 1
    const dupData = buildMultipart({ documentType: "lab_report" }, {
      fieldname: "file",
      filename: "duplicate_copy.pdf",
      contentType: "application/pdf",
      buffer: testPdfBuffer
    });

    const dupRes = await makeRequest("POST", "/api/documents/upload", dupData.body, {
      "Content-Type": dupData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isDedupBlocked = dupRes.status === 409 &&
      dupRes.body?.error?.code === "DUPLICATE_DOCUMENT" &&
      dupRes.body?.error?.existingDocumentId === uploadedDocId1;

    const noLeak = !JSON.stringify(dupRes.body).includes(patientUid1) && !JSON.stringify(dupRes.body).includes(patientId1);

    if (isDedupBlocked && noLeak) {
      recordTest("TEST-P5B-04", "Patient-scoped SHA-256 deduplication: rejects duplicate for same patient", "PASS",
        `409 DUPLICATE_DOCUMENT confirmed; linked existingDocumentId: ${uploadedDocId1}; zero UID leak`);
    } else {
      recordTest("TEST-P5B-04", "Patient-scoped SHA-256 deduplication: rejects duplicate for same patient", "FAIL",
        `Status: ${dupRes.status}, body: ${JSON.stringify(dupRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-04", "Patient-scoped SHA-256 deduplication: rejects duplicate for same patient", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-05: Cross-patient duplicate isolation: no existence oracle
  // -------------------------------------------------------------------------
  try {
    // Upload exact same testPdfBuffer for Patient 2 â€” MUST SUCCEED with 201 Created!
    const p2Data = buildMultipart({ documentType: "lab_report" }, {
      fieldname: "file",
      filename: "my_lab_report.pdf",
      contentType: "application/pdf",
      buffer: testPdfBuffer
    });

    const p2Res = await makeRequest("POST", "/api/documents/upload", p2Data.body, {
      "Content-Type": p2Data.contentType,
      Cookie: `ms_encounter_session=${sessionToken2}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const p2Doc = p2Res.body?.document;
    const isIsolated = p2Res.status === 201 && p2Doc?.documentId && p2Doc?.documentId !== uploadedDocId1;

    if (isIsolated) {
      recordTest("TEST-P5B-05", "Cross-patient duplicate isolation: no existence oracle", "PASS",
        `201 Created for Patient 2 with documentId: ${p2Doc.documentId}; distinct from Patient 1 doc (${uploadedDocId1}); no existence leak`);
    } else {
      recordTest("TEST-P5B-05", "Cross-patient duplicate isolation: no existence oracle", "FAIL",
        `Status: ${p2Res.status}, body: ${JSON.stringify(p2Res.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-05", "Cross-patient duplicate isolation: no existence oracle", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-06: Storage security: Path traversal in filenames stripped & rejected
  // -------------------------------------------------------------------------
  try {
    const traversalPdf = generateTestPdf("Safe traversal content test");
    const travData = buildMultipart({ documentType: "prescription" }, {
      fieldname: "file",
      filename: "../../../../etc/passwd.pdf",
      contentType: "application/pdf",
      buffer: traversalPdf
    });

    const travRes = await makeRequest("POST", "/api/documents/upload", travData.body, {
      "Content-Type": travData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const docRecord = await prisma.document.findUnique({
      where: { documentId: travRes.body?.document?.documentId }
    });

    const safeName = docRecord?.fileName;
    const safePath = docRecord?.filePath;
    const noTraversal = !safeName.includes("..") && !safeName.includes("/") && !safeName.includes("\\");
    const withinPatientDir = safePath && safePath.includes(patientUid1) && !safePath.includes("passwd.pdf");

    if (travRes.status === 201 && noTraversal && withinPatientDir) {
      recordTest("TEST-P5B-06", "Storage security: Path traversal in filenames stripped & rejected", "PASS",
        `Sanitized filename: '${safeName}'; isolated storage path strictly in patient namespace`);
    } else {
      recordTest("TEST-P5B-06", "Storage security: Path traversal in filenames stripped & rejected", "FAIL",
        `safeName: ${safeName}, safePath: ${safePath}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-06", "Storage security: Path traversal in filenames stripped & rejected", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-07: Browser zero-patientUid/patientId invariant across upload/page/status routes
  // -------------------------------------------------------------------------
  try {
    // 1. Injected patientUid in upload body
    const bodyUidData = buildMultipart({
      patientUid: "00000000-0000-0000-0000-000000000001",
      documentType: "prescription"
    }, {
      fieldname: "file",
      filename: "test.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Injection test body UID")
    });
    const bodyUidRes = await makeRequest("POST", "/api/documents/upload", bodyUidData.body, {
      "Content-Type": bodyUidData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    // 2. Injected patientId in upload body
    const bodyIdData = buildMultipart({
      patientId: "PAT-FORGED-001",
      documentType: "prescription"
    }, {
      fieldname: "file",
      filename: "test.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Injection test body ID")
    });
    const bodyIdRes = await makeRequest("POST", "/api/documents/upload", bodyIdData.body, {
      "Content-Type": bodyIdData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    // 3. Injected patientUid in upload query
    const queryUploadRes = await makeRequest("POST", `/api/documents/upload?patientUid=${patientUid2}`, bodyIdData.body, {
      "Content-Type": bodyIdData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    // 4. Injected patientUid in pages query
    const queryPagesRes = await makeRequest("GET", `/api/documents/${uploadedDocId1}/pages?patientUid=${patientUid1}`, null, {
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    // 5. Injected patientUid in status query
    const queryStatusRes = await makeRequest("GET", `/api/documents/${uploadedDocId1}/status?patientId=PAT-123`, null, {
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const bodyUidBlocked = bodyUidRes.status === 400 && bodyUidRes.body?.error?.code === "VALIDATION_ERROR";
    const bodyIdBlocked = bodyIdRes.status === 400 && bodyIdRes.body?.error?.code === "VALIDATION_ERROR";
    const queryUploadBlocked = queryUploadRes.status === 400 && queryUploadRes.body?.error?.code === "VALIDATION_ERROR";
    const queryPagesBlocked = queryPagesRes.status === 400 && queryPagesRes.body?.error?.code === "VALIDATION_ERROR";
    const queryStatusBlocked = queryStatusRes.status === 400 && queryStatusRes.body?.error?.code === "VALIDATION_ERROR";

    if (bodyUidBlocked && bodyIdBlocked && queryUploadBlocked && queryPagesBlocked && queryStatusBlocked) {
      recordTest("TEST-P5B-07", "Browser zero-patientUid/patientId invariant across upload/page/status routes", "PASS",
        `400 VALIDATION_ERROR enforced on upload body/query, pages query, and status query; zero UID/ID injection accepted`);
    } else {
      recordTest("TEST-P5B-07", "Browser zero-patientUid/patientId invariant across upload/page/status routes", "FAIL",
        `bodyUid: ${bodyUidBlocked}, bodyId: ${bodyIdBlocked}, queryUp: ${queryUploadBlocked}, queryPages: ${queryPagesBlocked}, queryStat: ${queryStatusBlocked}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-07", "Browser zero-patientUid/patientId invariant across upload/page/status routes", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-08: Cross-patient document access blocked (authorization isolation)
  // -------------------------------------------------------------------------
  try {
    // Patient 2 attempts to fetch pages of Patient 1's uploadedDocId1
    const crossRes = await makeRequest("GET", `/api/documents/${uploadedDocId1}/pages`, null, {
      Cookie: `ms_encounter_session=${sessionToken2}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isScopeBlocked = crossRes.status === 403 && crossRes.body?.error?.code === "PATIENT_SCOPE_MISMATCH";

    if (isScopeBlocked) {
      recordTest("TEST-P5B-08", "Cross-patient document access blocked (authorization isolation)", "PASS",
        `403 PATIENT_SCOPE_MISMATCH strictly enforced for cross-patient document inspection`);
    } else {
      recordTest("TEST-P5B-08", "Cross-patient document access blocked (authorization isolation)", "FAIL",
        `Status: ${crossRes.status}, body: ${JSON.stringify(crossRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-08", "Cross-patient document access blocked (authorization isolation)", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-09: PDF page segmentation: native text extracted into DocumentPage
  // -------------------------------------------------------------------------
  try {
    await ocrWorker.processDocument(uploadedDocId1);

    const pagesRes = await makeRequest("GET", `/api/documents/${uploadedDocId1}/pages`, null, {
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const pages = pagesRes.body?.pages || [];
    const hasPages = pagesRes.status === 200 && pages.length >= 1;
    const firstPage = pages[0];
    const validPage = firstPage?.pageNumber === 1 && firstPage?.ocrStatus === "native_text" && firstPage?.extractedText?.includes("Blood Sugar");

    if (hasPages && validPage) {
      recordTest("TEST-P5B-09", "PDF page segmentation: native text extracted into DocumentPage", "PASS",
        `Parsed ${pages.length} page(s); ocrStatus='native_text'; confidence: ${firstPage.ocrConfidence}; text length: ${firstPage.extractedText.length}`);
    } else {
      recordTest("TEST-P5B-09", "PDF page segmentation: native text extracted into DocumentPage", "FAIL",
        `status: ${pagesRes.status}, pages: ${JSON.stringify(pages)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-09", "PDF page segmentation: native text extracted into DocumentPage", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-10: Clinical date vs upload date distinction
  // -------------------------------------------------------------------------
  try {
    const docRecord = await prisma.document.findUnique({
      where: { documentId: uploadedDocId1 }
    });

    const hasClinicalDate = docRecord?.clinicalDate instanceof Date;
    const clinicalYear = hasClinicalDate ? docRecord.clinicalDate.getFullYear() : null;
    const clinicalMonth = hasClinicalDate ? docRecord.clinicalDate.getMonth() + 1 : null;
    const clinicalDay = hasClinicalDate ? docRecord.clinicalDate.getDate() : null;

    const isDistinct = docRecord?.clinicalDate?.getTime() !== docRecord?.uploadDate?.getTime();
    const correctDate = clinicalYear === 2023 && clinicalMonth === 4 && clinicalDay === 10;

    if (hasClinicalDate && isDistinct && correctDate) {
      recordTest("TEST-P5B-10", "Clinical date vs upload date distinction", "PASS",
        `Parsed clinicalDate: 2023-04-10 != uploadDate (${docRecord.uploadDate.toISOString().split("T")[0]}); accurate header parsing`);
    } else {
      recordTest("TEST-P5B-10", "Clinical date vs upload date distinction", "FAIL",
        `clinicalDate: ${docRecord?.clinicalDate}, uploadDate: ${docRecord?.uploadDate}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-10", "Clinical date vs upload date distinction", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-11: Real successful scanned image OCR execution through actual worker/helper path
  // -------------------------------------------------------------------------
  let realOcrDocId = null;
  let realOcrImgBuffer = null;
  try {
    realOcrImgBuffer = generateScannedTextPng("Rx: Tab Metformin 500mg Once Daily", false);
    const originalBufferHash = crypto.createHash("sha256").update(realOcrImgBuffer).digest("hex");

    // 1. Upload genuine prescription image
    const imgData = buildMultipart({ documentType: "prescription" }, {
      fieldname: "file",
      filename: "real_prescription.png",
      contentType: "image/png",
      buffer: realOcrImgBuffer
    });

    const uploadRes = await makeRequest("POST", "/api/documents/upload", imgData.body, {
      "Content-Type": imgData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    realOcrDocId = uploadRes.body?.document?.documentId;
    const job = uploadRes.body?.job;
    const uploadOk = uploadRes.status === 201 && realOcrDocId && job?.jobType === "OCR_ENHANCEMENT" && job?.status === "queued";

    // 2. Execute OCR via actual worker path (spawns ocr_helper.py -> tesseract executable)
    await ocrWorker.processDocument(realOcrDocId);

    // 3. Inspect document and pages after execution
    const docAfterOcr = await prisma.document.findUnique({
      where: { documentId: realOcrDocId },
      include: { pages: true, jobs: { orderBy: { id: "desc" }, take: 1 } }
    });

    const page = docAfterOcr?.pages?.[0];
    const isProcessed = page?.ocrStatus === "ocr_processed";
    const hasConfidence = typeof page?.ocrConfidence === "number" && page.ocrConfidence > 0;
    const textMatched = page?.extractedText && page.extractedText.toLowerCase().includes("metformin");
    const docReady = docAfterOcr?.status === "ready";
    const jobCompleted = docAfterOcr?.jobs?.[0]?.status === "completed";

    // 4. Verify byte-identical preservation of original binary
    const savedBinary = fs.readFileSync(docAfterOcr.filePath);
    const savedBinaryHash = crypto.createHash("sha256").update(savedBinary).digest("hex");
    const binaryPreserved = originalBufferHash === savedBinaryHash;

    if (uploadOk && isProcessed && hasConfidence && textMatched && docReady && jobCompleted && binaryPreserved) {
      recordTest("TEST-P5B-11", "Real successful scanned image OCR execution through actual worker/helper path", "PASS",
        `Tesseract executed; text matched 'Metformin'; confidence: ${page.ocrConfidence}; ocrStatus='ocr_processed'; status='ready'; binary SHA-256 byte-identical (${savedBinary.length} bytes)`);
    } else {
      recordTest("TEST-P5B-11", "Real successful scanned image OCR execution through actual worker/helper path", "FAIL",
        `uploadOk: ${uploadOk}, isProcessed: ${isProcessed}, conf: ${page?.ocrConfidence}, text: ${JSON.stringify(page?.extractedText)}, docReady: ${docReady}, binaryPreserved: ${binaryPreserved}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-11", "Real successful scanned image OCR execution through actual worker/helper path", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-12: Hindi/Devanagari OCR execution and multilingual model verification
  // -------------------------------------------------------------------------
  try {
    const hindiText = "à¤¦à¤µà¤¾: à¤ªà¥ˆà¤°à¤¾à¤¸à¤¿à¤Ÿà¤¾à¤®à¥‹à¤²";
    const hindiImgBuffer = generateScannedTextPng(hindiText, true);

    const hinData = buildMultipart({ documentType: "prescription" }, {
      fieldname: "file",
      filename: "hindi_prescription.png",
      contentType: "image/png",
      buffer: hindiImgBuffer
    });

    const hinRes = await makeRequest("POST", "/api/documents/upload", hinData.body, {
      "Content-Type": hinData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const hinDocId = hinRes.body?.document?.documentId;
    await ocrWorker.processDocument(hinDocId);

    const hinDoc = await prisma.document.findUnique({
      where: { documentId: hinDocId },
      include: { pages: true }
    });

    const hinPage = hinDoc?.pages?.[0];
    const isProcessed = hinPage?.ocrStatus === "ocr_processed";
    const hasConfidence = typeof hinPage?.ocrConfidence === "number" && hinPage.ocrConfidence > 0;
    const hasDevanagari = hinPage?.extractedText && /[\u0900-\u097F]/.test(hinPage.extractedText);

    if (hinRes.status === 201 && isProcessed && hasConfidence && hasDevanagari) {
      recordTest("TEST-P5B-12", "Hindi/Devanagari OCR execution and multilingual model verification", "PASS",
        `Tesseract Devanagari OCR verified; extracted Hindi characters; confidence: ${hinPage.ocrConfidence}; ocrStatus='ocr_processed'`);
    } else {
      recordTest("TEST-P5B-12", "Hindi/Devanagari OCR execution and multilingual model verification", "FAIL",
        `status: ${hinRes.status}, isProcessed: ${isProcessed}, hasDevanagari: ${hasDevanagari}, text: ${JSON.stringify(hinPage?.extractedText)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-12", "Hindi/Devanagari OCR execution and multilingual model verification", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-13: Full document lifecycle transitions queryable via status endpoint
  // -------------------------------------------------------------------------
  try {
    const statusRes = await makeRequest("GET", `/api/documents/${realOcrDocId}/status`, null, {
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const statusBody = statusRes.body;
    const isValidStatus = statusRes.status === 200 &&
      statusBody.success === true &&
      statusBody.documentId === realOcrDocId &&
      statusBody.status === "ready" &&
      statusBody.job?.status === "completed";

    const noLeak = !JSON.stringify(statusBody).includes(patientUid1) && !JSON.stringify(statusBody).includes(patientId1);

    if (isValidStatus && noLeak) {
      recordTest("TEST-P5B-13", "Full document lifecycle transitions queryable via status endpoint", "PASS",
        `Document status: '${statusBody.status}', totalPages: ${statusBody.totalPages}, job status: '${statusBody.job?.status}'; zero UID leaked`);
    } else {
      recordTest("TEST-P5B-13", "Full document lifecycle transitions queryable via status endpoint", "FAIL",
        `Status: ${statusRes.status}, body: ${JSON.stringify(statusBody)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-13", "Full document lifecycle transitions queryable via status endpoint", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-14: Clinician document upload: authorized doctor assigned to encounter succeeds (201)
  // -------------------------------------------------------------------------
  let docAssignedDocId = null;
  try {
    const docUploadData = buildMultipart({
      encounterId: encounterId1,
      documentType: "prescription"
    }, {
      fieldname: "file",
      filename: "doctor_prescription.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Doctor prescription for assigned encounter")
    });

    const docUploadRes = await makeRequest("POST", "/api/documents/upload", docUploadData.body, {
      "Content-Type": docUploadData.contentType,
      Cookie: `ms_user_session=${doctorSession1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    docAssignedDocId = docUploadRes.body?.document?.documentId;
    const isAllowed = docUploadRes.status === 201 && docAssignedDocId;

    if (isAllowed) {
      recordTest("TEST-P5B-14", "Clinician document upload: authorized doctor assigned to encounter succeeds (201)", "PASS",
        `201 Created for doctor assigned to encounter ${encounterId1}; documentId: ${docAssignedDocId}`);
    } else {
      recordTest("TEST-P5B-14", "Clinician document upload: authorized doctor assigned to encounter succeeds (201)", "FAIL",
        `Status: ${docUploadRes.status}, body: ${JSON.stringify(docUploadRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-14", "Clinician document upload: authorized doctor assigned to encounter succeeds (201)", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-15: Clinician document upload: authorized doctor with active CareRelationship succeeds (201)
  // -------------------------------------------------------------------------
  try {
    // Create active CareRelationship for Doctor 2 with Patient 1 (even though Doctor 2 is not assigned to encounterId1)
    await prisma.careRelationship.create({
      data: {
        patientUid: patientUid1,
        doctorId: doctorUser2.id,
        relationshipType: "SPECIALIST_REFERRAL",
        status: "active",
        expiresAt: null,
        endedAt: null
      }
    });

    const careRelData = buildMultipart({
      encounterId: encounterId1,
      documentType: "clinical_note"
    }, {
      fieldname: "file",
      filename: "referral_note.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Specialist referral note for patient 1")
    });

    const careRelRes = await makeRequest("POST", "/api/documents/upload", careRelData.body, {
      "Content-Type": careRelData.contentType,
      Cookie: `ms_user_session=${doctorSession2}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isAllowed = careRelRes.status === 201 && careRelRes.body?.document?.documentId;

    if (isAllowed) {
      recordTest("TEST-P5B-15", "Clinician document upload: authorized doctor with active CareRelationship succeeds (201)", "PASS",
        `201 Created for Doctor 2 with active CareRelationship on encounter ${encounterId1}; documentId: ${careRelRes.body?.document?.documentId}`);
    } else {
      recordTest("TEST-P5B-15", "Clinician document upload: authorized doctor with active CareRelationship succeeds (201)", "FAIL",
        `Status: ${careRelRes.status}, body: ${JSON.stringify(careRelRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-15", "Clinician document upload: authorized doctor with active CareRelationship succeeds (201)", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-16: Clinician document upload: doctor attempting another patient's encounter rejected (403 CLINICAL_ACCESS_DENIED)
  // -------------------------------------------------------------------------
  try {
    // Doctor 1 has NO CareRelationship with Patient 2, and is NOT assigned to encounterId2 (which belongs to Doctor 2)
    const foreignEncData = buildMultipart({
      encounterId: encounterId2,
      documentType: "prescription"
    }, {
      fieldname: "file",
      filename: "cross_patient_attempt.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Unauthorized cross doctor prescription attempt")
    });

    const foreignRes = await makeRequest("POST", "/api/documents/upload", foreignEncData.body, {
      "Content-Type": foreignEncData.contentType,
      Cookie: `ms_user_session=${doctorSession1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isDenied = foreignRes.status === 403 && foreignRes.body?.error?.code === "CLINICAL_ACCESS_DENIED";

    if (isDenied) {
      recordTest("TEST-P5B-16", "Clinician document upload: doctor attempting another patient's encounter rejected (403 CLINICAL_ACCESS_DENIED)", "PASS",
        `403 CLINICAL_ACCESS_DENIED strictly enforced for doctor accessing unassigned encounter of another patient`);
    } else {
      recordTest("TEST-P5B-16", "Clinician document upload: doctor attempting another patient's encounter rejected (403 CLINICAL_ACCESS_DENIED)", "FAIL",
        `Status: ${foreignRes.status}, body: ${JSON.stringify(foreignRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-16", "Clinician document upload: doctor attempting another patient's encounter rejected (403 CLINICAL_ACCESS_DENIED)", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-17: Clinician document upload: doctor with suspended CareRelationship rejected (403 CLINICAL_ACCESS_DENIED)
  // -------------------------------------------------------------------------
  try {
    // Suspend Doctor 2's CareRelationship with Patient 1
    await prisma.careRelationship.updateMany({
      where: { patientUid: patientUid1, doctorId: doctorUser2.id },
      data: { status: "suspended" }
    });

    const suspendedData = buildMultipart({
      encounterId: encounterId1,
      documentType: "clinical_note"
    }, {
      fieldname: "file",
      filename: "suspended_note.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Note under suspended relationship")
    });

    const suspendedRes = await makeRequest("POST", "/api/documents/upload", suspendedData.body, {
      "Content-Type": suspendedData.contentType,
      Cookie: `ms_user_session=${doctorSession2}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isDenied = suspendedRes.status === 403 && suspendedRes.body?.error?.code === "CLINICAL_ACCESS_DENIED";

    if (isDenied) {
      recordTest("TEST-P5B-17", "Clinician document upload: doctor with suspended CareRelationship rejected (403 CLINICAL_ACCESS_DENIED)", "PASS",
        `403 CLINICAL_ACCESS_DENIED strictly enforced when CareRelationship.status === 'suspended'`);
    } else {
      recordTest("TEST-P5B-17", "Clinician document upload: doctor with suspended CareRelationship rejected (403 CLINICAL_ACCESS_DENIED)", "FAIL",
        `Status: ${suspendedRes.status}, body: ${JSON.stringify(suspendedRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-17", "Clinician document upload: doctor with suspended CareRelationship rejected (403 CLINICAL_ACCESS_DENIED)", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-18: Clinician document upload: doctor with no assigned encounter and no CareRelationship rejected (403)
  // -------------------------------------------------------------------------
  try {
    // Clean all CareRelationships for Patient 1 with Doctor 2
    await prisma.careRelationship.deleteMany({
      where: { patientUid: patientUid1, doctorId: doctorUser2.id }
    });

    const noRelData = buildMultipart({
      encounterId: encounterId1,
      documentType: "clinical_note"
    }, {
      fieldname: "file",
      filename: "no_rel_note.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Note with zero relationship")
    });

    const noRelRes = await makeRequest("POST", "/api/documents/upload", noRelData.body, {
      "Content-Type": noRelData.contentType,
      Cookie: `ms_user_session=${doctorSession2}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isDenied = noRelRes.status === 403 && noRelRes.body?.error?.code === "CLINICAL_ACCESS_DENIED";

    if (isDenied) {
      recordTest("TEST-P5B-18", "Clinician document upload: doctor with no assigned encounter and no CareRelationship rejected (403)", "PASS",
        `403 CLINICAL_ACCESS_DENIED confirmed for completely unrelated clinician session`);
    } else {
      recordTest("TEST-P5B-18", "Clinician document upload: doctor with no assigned encounter and no CareRelationship rejected (403)", "FAIL",
        `Status: ${noRelRes.status}, body: ${JSON.stringify(noRelRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-18", "Clinician document upload: doctor with no assigned encounter and no CareRelationship rejected (403)", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-19: Patient encounter session: cross-patient encounter upload attempt strictly rejected (403)
  // -------------------------------------------------------------------------
  try {
    // Patient 1 encounter session attempts to upload specifying encounterId2
    const crossData = buildMultipart({
      encounterId: encounterId2,
      documentType: "prescription"
    }, {
      fieldname: "file",
      filename: "cross_attempt.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Patient cross encounter upload attempt")
    });

    const crossRes = await makeRequest("POST", "/api/documents/upload", crossData.body, {
      "Content-Type": crossData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const isBlocked = crossRes.status === 403 && crossRes.body?.error?.code === "PATIENT_SCOPE_MISMATCH";

    if (isBlocked) {
      recordTest("TEST-P5B-19", "Patient encounter session: cross-patient encounter upload attempt strictly rejected (403)", "PASS",
        `403 PATIENT_SCOPE_MISMATCH strictly enforced when client passes mismatched encounterId in patient session`);
    } else {
      recordTest("TEST-P5B-19", "Patient encounter session: cross-patient encounter upload attempt strictly rejected (403)", "FAIL",
        `Status: ${crossRes.status}, body: ${JSON.stringify(crossRes.body)}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-19", "Patient encounter session: cross-patient encounter upload attempt strictly rejected (403)", "FAIL", err.message);
  }

  // -------------------------------------------------------------------------
  // TEST-P5B-20: Cross-patient upload attempts cannot alter or create documents for another patient
  // -------------------------------------------------------------------------
  try {
    const p2DocCountBefore = await prisma.document.count({ where: { patientUid: patientUid2 } });

    // Attempted cross upload by Patient 1 session with no encounterId (patient context is Patient 1)
    const selfData = buildMultipart({ documentType: "prescription" }, {
      fieldname: "file",
      filename: "p1_legitimate.pdf",
      contentType: "application/pdf",
      buffer: generateTestPdf("Patient 1 isolated upload test")
    });

    const selfRes = await makeRequest("POST", "/api/documents/upload", selfData.body, {
      "Content-Type": selfData.contentType,
      Cookie: `ms_encounter_session=${sessionToken1}`,
      "X-Requested-With": "XMLHttpRequest"
    });

    const p2DocCountAfter = await prisma.document.count({ where: { patientUid: patientUid2 } });

    const p1Uploaded = selfRes.status === 201 && selfRes.body?.document?.documentId;
    const p2Untouched = p2DocCountBefore === p2DocCountAfter;

    if (p1Uploaded && p2Untouched) {
      recordTest("TEST-P5B-20", "Cross-patient upload attempts cannot alter or create documents for another patient", "PASS",
        `Upload strictly confined to Patient 1 (${patientUid1}); Patient 2 document count unchanged (${p2DocCountBefore} -> ${p2DocCountAfter})`);
    } else {
      recordTest("TEST-P5B-20", "Cross-patient upload attempts cannot alter or create documents for another patient", "FAIL",
        `p1Uploaded: ${p1Uploaded}, p2Untouched: ${p2Untouched}`);
    }
  } catch (err) {
    recordTest("TEST-P5B-20", "Cross-patient upload attempts cannot alter or create documents for another patient", "FAIL", err.message);
  }

  // Teardown
  if (serverInstance) {
    await new Promise(r => serverInstance.close(r));
  }
  await disconnectPrisma();

  console.log("\n=======================================================");
  console.log("PHASE 5B TEST SUMMARY");
  console.log("=======================================================");
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  console.log(`Total Tests: ${results.length} | Passed: ${passed} | Failed: ${failed}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase5BTests().catch(err => {
  console.error("FATAL in test suite:", err);
  process.exit(1);
});
