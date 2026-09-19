"""
Unit & Integration Tests for Phase 5D VectorStore & Ingestion Engine
tests/test_phase5d_vectorstore.py
"""

import os
import shutil
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone

import faiss
import numpy as np

from services.rag_service.chunker import (
    ClinicalChunk,
    build_temporal_header,
    chunk_clinical_fact,
    chunk_document_bundle,
    chunk_document_page,
    split_into_paragraphs,
)
from services.rag_service.ingestion import (
    check_rag_eligibility,
    ingest_document,
    queue_rag_ingestion,
    rebuild_patient_index_from_db,
)
from services.rag_service.vectorstore import (
    EXPECTED_EMBEDDING_DIM,
    EXPECTED_EMBEDDING_MODEL,
    PatientVectorStore,
    normalize_vectors,
    validate_patient_uid,
)

TEST_PATIENT_A = "11111111-1111-4111-8111-111111111111"
TEST_PATIENT_B = "22222222-2222-4222-8222-222222222222"


class TestPhase5DVectorStore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.test_dir = tempfile.mkdtemp(prefix="test_vector_index_")
        cls.test_db_dir = tempfile.mkdtemp(prefix="test_db_")
        cls.test_db_path = os.path.join(cls.test_db_dir, "test.db")
        cls._init_test_db(cls.test_db_path)
        cls.store = PatientVectorStore(base_dir=cls.test_dir)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.test_dir, ignore_errors=True)
        shutil.rmtree(cls.test_db_dir, ignore_errors=True)

    @classmethod
    def _init_test_db(cls, db_path: str):
        con = sqlite3.connect(db_path)
        cur = con.cursor()
        # Create minimal required schema matching prisma/schema.sqlite.prisma
        cur.execute("""
            CREATE TABLE Patient (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patientUid TEXT UNIQUE NOT NULL,
                patientId TEXT UNIQUE NOT NULL,
                fullName TEXT NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cur.execute("""
            CREATE TABLE Document (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                documentId TEXT UNIQUE NOT NULL,
                patientUid TEXT NOT NULL,
                fileName TEXT NOT NULL,
                filePath TEXT NOT NULL,
                fileSize INTEGER NOT NULL,
                mimeType TEXT NOT NULL,
                documentType TEXT NOT NULL,
                totalPages INTEGER DEFAULT 1,
                uploadDate DATETIME DEFAULT CURRENT_TIMESTAMP,
                clinicalDate DATETIME,
                status TEXT DEFAULT 'uploaded',
                provenance TEXT DEFAULT 'DOCUMENT_EXTRACTED',
                derivativeVersion INTEGER DEFAULT 1,
                fileHash TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE DocumentPage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                documentId TEXT NOT NULL,
                pageNumber INTEGER NOT NULL,
                extractedText TEXT NOT NULL,
                ocrStatus TEXT DEFAULT 'native_text',
                ocrConfidence REAL,
                version INTEGER DEFAULT 1,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(documentId, pageNumber, version)
            )
        """)
        cur.execute("""
            CREATE TABLE DocumentClinicalFact (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                documentId TEXT NOT NULL,
                patientUid TEXT NOT NULL,
                pageNumber INTEGER NOT NULL,
                factType TEXT NOT NULL,
                factKey TEXT NOT NULL,
                factValue TEXT NOT NULL,
                unit TEXT,
                clinicalDate DATETIME,
                confidence REAL DEFAULT 1.0,
                provenance TEXT NOT NULL,
                version INTEGER DEFAULT 1,
                parentFactId INTEGER,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cur.execute("""
            CREATE TABLE DocumentApproval (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                documentId TEXT NOT NULL,
                approvedByUserId INTEGER NOT NULL,
                approvedVersion INTEGER DEFAULT 1,
                action TEXT NOT NULL,
                comments TEXT,
                approvedAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cur.execute("""
            CREATE TABLE RAGIngestionJob (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                jobId TEXT UNIQUE NOT NULL,
                documentId TEXT NOT NULL,
                patientUid TEXT NOT NULL,
                chunkCount INTEGER DEFAULT 0,
                status TEXT DEFAULT 'queued',
                errorDetails TEXT,
                startedAt DATETIME,
                completedAt DATETIME
            )
        """)
        con.commit()
        con.close()

    # 1. Canonical patient UUID validation
    def test_01_canonical_patient_uuid_validation(self):
        valid = validate_patient_uid("e4d909c2-9092-4f36-a142-b13c1264c8a2")
        self.assertEqual(valid, "e4d909c2-9092-4f36-a142-b13c1264c8a2")

        with self.assertRaises(ValueError) as ctx:
            validate_patient_uid("invalid-uuid-format")
        self.assertIn("SECURITY_VIOLATION", str(ctx.exception))

    # 2. Path traversal rejection
    def test_02_path_traversal_rejection(self):
        traversal_attempts = [
            "../../../etc/passwd",
            "..\\..\\windows\\system32",
            "e4d909c2-9092-4f36-a142-b13c1264c8a2/../evil",
            "e4d909c2-9092-4f36-a142-b13c1264c8a2\0nullbyte",
        ]
        for bad_uid in traversal_attempts:
            with self.assertRaises(ValueError) as ctx:
                validate_patient_uid(bad_uid)
            self.assertIn("SECURITY_VIOLATION", str(ctx.exception))

    # 3. Patient-isolated directory creation
    def test_03_patient_isolated_directory_creation(self):
        p_dir = self.store.get_patient_dir(TEST_PATIENT_A)
        self.assertTrue(p_dir.endswith(TEST_PATIENT_A))
        self.assertEqual(os.path.dirname(p_dir), self.store.base_dir)

    # 4. Patient metadata mismatch rejection
    def test_04_patient_metadata_mismatch_rejection(self):
        # Create chunk with patient B
        chunk_b = ClinicalChunk(
            chunk_id="doc1::v1::p1::chunk_0",
            patient_uid=TEST_PATIENT_B,
            document_id="doc1",
            page_number=1,
            document_version=1,
            approval_version=1,
            source_text="Some text",
            provenance="DOCUMENT_EXTRACTED",
        )
        # Attempting to ingest chunk B into Patient A index must raise SECURITY_VIOLATION
        with self.assertRaises(ValueError) as ctx:
            self.store.ingest_chunks(TEST_PATIENT_A, [chunk_b], "doc1", 1)
        self.assertIn("SECURITY_VIOLATION", str(ctx.exception))

    # 5. Embedding dimension = 384
    def test_05_embedding_dimension(self):
        vecs = self.store._embed_texts(["Patient presented with mild chest pain."])
        self.assertEqual(vecs.shape, (1, EXPECTED_EMBEDDING_DIM))

    # 6. Normalized embedding / IndexFlatIP compatibility
    def test_06_normalized_embedding(self):
        vecs = self.store._embed_texts(["Normal sinus rhythm"])
        norm = np.linalg.norm(vecs[0])
        self.assertAlmostEqual(norm, 1.0, places=5)

    # 7. Deterministic chunk metadata & temporal headers
    def test_07_deterministic_chunk_metadata(self):
        h1 = build_temporal_header(TEST_PATIENT_A, "2023-05-12", 2023)
        self.assertEqual(h1, f"[{TEST_PATIENT_A} | Date: 2023-05-12 | Year: 2023]")

        h2 = build_temporal_header(TEST_PATIENT_A, None, None)
        self.assertEqual(h2, f"[{TEST_PATIENT_A} | Date: Unknown]")

    # 8. ClinicalDate / uploadDate separation
    def test_08_clinical_date_uploaddate_separation(self):
        doc_meta = {
            "documentId": "doc_test_8",
            "patientUid": TEST_PATIENT_A,
            "derivativeVersion": 1,
            "approvalVersion": 1,
            "clinicalDate": "2021-08-20",
            "uploadDate": "2024-01-01",
            "documentType": "discharge_summary",
        }
        page = {"pageNumber": 1, "extractedText": "Patient was discharged in good health."}
        chunks = chunk_document_page(doc_meta, page)
        self.assertEqual(chunks[0].clinical_date, "2021-08-20")
        self.assertEqual(chunks[0].upload_date, "2024-01-01")
        self.assertEqual(chunks[0].year, 2021)

    # 9. RAG eligibility: only approved current-version documents
    def test_09_rag_eligibility_logic(self):
        # Case A: pending_review -> not eligible
        doc_pending = {"status": "pending_review", "derivativeVersion": 1}
        appr_valid = {"action": "APPROVED", "approvedVersion": 1}
        eligible, reason = check_rag_eligibility(doc_pending, appr_valid)
        self.assertFalse(eligible)
        self.assertIn("DOCUMENT_NOT_APPROVED", reason)

        # Case B: approved but stale version -> not eligible
        doc_stale = {"status": "approved", "derivativeVersion": 2}
        appr_stale = {"action": "APPROVED", "approvedVersion": 1}
        eligible, reason = check_rag_eligibility(doc_stale, appr_stale)
        self.assertFalse(eligible)
        self.assertIn("STALE_VERSION", reason)

        # Case C: approved matching version -> eligible!
        doc_approved = {"status": "approved", "derivativeVersion": 2}
        appr_match = {"action": "APPROVED", "approvedVersion": 2}
        eligible, reason = check_rag_eligibility(doc_approved, appr_match)
        self.assertTrue(eligible)
        self.assertEqual(reason, "ELIGIBLE")

    # 10. Ingest approved document & verify search isolation
    def test_10_isolated_ingestion_and_search(self):
        con = sqlite3.connect(self.test_db_path)
        cur = con.cursor()
        # Seed Patient A doc
        cur.execute("""
            INSERT OR REPLACE INTO Document (documentId, patientUid, fileName, filePath, fileSize, mimeType, documentType, clinicalDate, status, derivativeVersion)
            VALUES ('DOC-A1', ?, 'cardiology.pdf', '/data/a1.pdf', 1024, 'application/pdf', 'cardiology', '2022-03-10', 'approved', 1)
        """, (TEST_PATIENT_A,))
        cur.execute("""
            INSERT OR REPLACE INTO DocumentPage (documentId, pageNumber, extractedText, version)
            VALUES ('DOC-A1', 1, 'Patient diagnosed with Stage 2 Essential Hypertension and prescribed Telmisartan 40mg.', 1)
        """)
        cur.execute("""
            INSERT OR REPLACE INTO DocumentClinicalFact (documentId, patientUid, pageNumber, factType, factKey, factValue, unit, clinicalDate, provenance, version)
            VALUES ('DOC-A1', ?, 1, 'diagnosis', 'Hypertension', 'Stage 2 Essential', NULL, '2022-03-10', 'DOCUMENT_EXTRACTED', 1)
        """, (TEST_PATIENT_A,))
        cur.execute("""
            INSERT OR REPLACE INTO DocumentApproval (documentId, approvedByUserId, approvedVersion, action)
            VALUES ('DOC-A1', 1, 1, 'APPROVED')
        """)
        con.commit()
        con.close()

        res = ingest_document("DOC-A1", db_path=self.test_db_path, store=self.store)
        self.assertTrue(res["success"])
        self.assertEqual(res["patientUid"], TEST_PATIENT_A)

        # Search Patient A
        results_a = self.store.search(TEST_PATIENT_A, "hypertension telmisartan", top_k=3)
        self.assertGreater(len(results_a), 0)
        self.assertIn("DOC-A1", results_a[0]["chunk"]["document_id"])

        # Patient B searching MUST return 0 results (physical isolation)
        results_b = self.store.search(TEST_PATIENT_B, "hypertension telmisartan", top_k=3)
        self.assertEqual(len(results_b), 0)

    # 11. Idempotency test: repeated ingestion of same version
    def test_11_ingestion_idempotency(self):
        res1 = ingest_document("DOC-A1", db_path=self.test_db_path, store=self.store)
        self.assertTrue(res1["alreadyIndexed"])

    # 12. Version replacement: v2 replaces v1
    def test_12_version_replacement(self):
        con = sqlite3.connect(self.test_db_path)
        cur = con.cursor()
        # Upgrade DOC-A1 to derivativeVersion = 2
        cur.execute("UPDATE Document SET derivativeVersion = 2, status = 'approved' WHERE documentId = 'DOC-A1'")
        cur.execute("""
            INSERT INTO DocumentPage (documentId, pageNumber, extractedText, version)
            VALUES ('DOC-A1', 1, 'Corrected: Patient diagnosed with Mild Secondary Hypertension and prescribed Amlodipine 5mg.', 2)
        """)
        cur.execute("""
            INSERT INTO DocumentClinicalFact (documentId, patientUid, pageNumber, factType, factKey, factValue, unit, clinicalDate, provenance, version)
            VALUES ('DOC-A1', ?, 1, 'medication', 'Amlodipine', '5mg', 'mg', '2022-03-10', 'DOCTOR_ENTERED', 2)
        """, (TEST_PATIENT_A,))
        cur.execute("""
            INSERT INTO DocumentApproval (documentId, approvedByUserId, approvedVersion, action)
            VALUES ('DOC-A1', 1, 2, 'APPROVED')
        """)
        con.commit()
        con.close()

        res2 = ingest_document("DOC-A1", db_path=self.test_db_path, store=self.store)
        self.assertFalse(res2["alreadyIndexed"])
        self.assertEqual(res2["version"], 2)
        self.assertGreater(res2["staleChunksRemoved"], 0)

        # Verify index now reflects v2 content
        results = self.store.search(TEST_PATIENT_A, "Amlodipine", top_k=3)
        self.assertGreater(len(results), 0)
        self.assertEqual(results[0]["chunk"]["document_version"], 2)

    # 13. Rebuild patient index consumes strictly RAG-eligible documents
    def test_13_rebuild_patient_index(self):
        rebuild_res = rebuild_patient_index_from_db(TEST_PATIENT_A, db_path=self.test_db_path, store=self.store)
        self.assertTrue(rebuild_res["success"])
        self.assertEqual(rebuild_res["eligibleDocumentsCount"], 1)

    # 14. Unapproved document cannot be queued
    def test_14_unapproved_cannot_be_queued(self):
        con = sqlite3.connect(self.test_db_path)
        cur = con.cursor()
        cur.execute("""
            INSERT OR REPLACE INTO Document (documentId, patientUid, fileName, filePath, fileSize, mimeType, documentType, status, derivativeVersion)
            VALUES ('DOC-UNAPPROVED', ?, 'scan.pdf', '/data/unapproved.pdf', 500, 'application/pdf', 'lab', 'pending_review', 1)
        """, (TEST_PATIENT_A,))
        con.commit()
        con.close()

        with self.assertRaises(ValueError) as ctx:
            queue_rag_ingestion("DOC-UNAPPROVED", db_path=self.test_db_path)
        self.assertIn("CANNOT_QUEUE_UNAPPROVED_DOCUMENT", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
