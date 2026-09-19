"""
Production RAG Ingestion Engine
services/rag_service/ingestion.py

Orchestrates:
- Strict Phase 5C RAG eligibility gate
- Single coherent approved snapshot selection (DocumentPage.version == N, DocumentClinicalFact.version == N)
- Integration with database RAGIngestionJob lifecycle (queued -> indexing -> completed / failed)
- Deterministic idempotency and stale version replacement
- Complete patient index rebuild from database source-of-truth
"""

import logging
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from services.rag_service.chunker import ClinicalChunk, chunk_document_bundle
from services.rag_service.database import get_default_sqlite_path, parse_database_config
from services.rag_service.vectorstore import PatientVectorStore, validate_patient_uid

logger = logging.getLogger(__name__)


def get_db_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    """Open SQLite connection with row factory enabled using environment-driven config."""
    cfg = parse_database_config(url_override=db_path)
    target_path = cfg.get("sqlite_path") or get_default_sqlite_path()
    if not target_path or not os.path.isfile(target_path):
        raise FileNotFoundError(f"Database file not found at: {target_path}")
    con = sqlite3.connect(target_path)
    con.row_factory = sqlite3.Row
    return con


def check_rag_eligibility(
    doc: Optional[Dict[str, Any]],
    latest_approval: Optional[Dict[str, Any]],
) -> Tuple[bool, str]:
    """
    Authoritative Phase 5C RAG eligibility evaluation:
    Eligible iff:
    - doc is not None
    - doc.status == "approved"
    - latest_approval is not None
    - latest_approval.action == "APPROVED"
    - latest_approval.approvedVersion == doc.derivativeVersion
    """
    if not doc:
        return False, "DOCUMENT_NOT_FOUND"

    status = doc.get("status")
    if status != "approved":
        return False, f"DOCUMENT_NOT_APPROVED: Current status is '{status}', expected 'approved'"

    if not latest_approval:
        return False, "NO_APPROVAL_RECORD: Document lacks any clinician approval record"

    action = latest_approval.get("action")
    if action != "APPROVED":
        return False, f"APPROVAL_ACTION_NOT_APPROVED: Latest approval action is '{action}', expected 'APPROVED'"

    doc_version = int(doc.get("derivativeVersion", 1))
    approved_version = int(latest_approval.get("approvedVersion", 0))
    if doc_version != approved_version:
        return False, f"STALE_VERSION: Document current version is {doc_version}, but approved version is {approved_version}"

    return True, "ELIGIBLE"


def fetch_latest_approval(con: sqlite3.Connection, document_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve the latest DocumentApproval record for a document."""
    cur = con.cursor()
    cur.execute(
        """
        SELECT * FROM DocumentApproval
        WHERE documentId = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (document_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def fetch_document_bundle_from_db(
    con: sqlite3.Connection, document_id: str
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """
    Fetch document metadata, current-version pages, current-version facts, and latest approval.
    Enforces that only records matching doc.derivativeVersion are returned.
    """
    cur = con.cursor()

    # 1. Fetch Document
    cur.execute("SELECT * FROM Document WHERE documentId = ?", (document_id,))
    doc_row = cur.fetchone()
    if not doc_row:
        raise ValueError(f"DOCUMENT_NOT_FOUND: Document '{document_id}' not found in database")
    doc_meta = dict(doc_row)
    current_version = int(doc_meta.get("derivativeVersion", 1))

    # 2. Fetch Latest Approval
    approval = fetch_latest_approval(con, document_id)

    # 3. Fetch current-version Pages ONLY
    cur.execute(
        """
        SELECT * FROM DocumentPage
        WHERE documentId = ? AND version = ?
        ORDER BY pageNumber ASC
        """,
        (document_id, current_version),
    )
    pages = [dict(r) for r in cur.fetchall()]

    # 4. Fetch current-version Clinical Facts ONLY
    cur.execute(
        """
        SELECT * FROM DocumentClinicalFact
        WHERE documentId = ? AND version = ?
        ORDER BY pageNumber ASC, id ASC
        """,
        (document_id, current_version),
    )
    facts = [dict(r) for r in cur.fetchall()]

    return doc_meta, pages, facts, approval


def create_or_update_rag_job(
    con: sqlite3.Connection,
    document_id: str,
    patient_uid: str,
    status: str = "queued",
    chunk_count: int = 0,
    error_details: Optional[str] = None,
    job_id: Optional[str] = None,
) -> str:
    """Create or update RAGIngestionJob row."""
    now_iso = datetime.now(timezone.utc).isoformat()
    cur = con.cursor()

    if not job_id:
        assigned_job_id = f"ragjob_{uuid.uuid4().hex[:12]}"
        cur.execute(
            """
            INSERT INTO RAGIngestionJob (jobId, documentId, patientUid, chunkCount, status, errorDetails, startedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (assigned_job_id, document_id, patient_uid, chunk_count, status, error_details, now_iso),
        )
        con.commit()
        return assigned_job_id
    else:
        completed_at = now_iso if status in ("completed", "failed") else None
        cur.execute(
            """
            UPDATE RAGIngestionJob
            SET status = ?, chunkCount = ?, errorDetails = ?, completedAt = COALESCE(?, completedAt)
            WHERE jobId = ?
            """,
            (status, chunk_count, error_details, completed_at, job_id),
        )
        con.commit()
        return job_id


def queue_rag_ingestion(
    document_id: str,
    db_path: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Queue a RAGIngestionJob for an approved document.
    Rejects unapproved or stale documents with DOCUMENT_NOT_RAG_ELIGIBLE.
    """
    con = get_db_connection(db_path)
    try:
        doc_meta, pages, facts, approval = fetch_document_bundle_from_db(con, document_id)
        is_eligible, reason = check_rag_eligibility(doc_meta, approval)
        if not is_eligible:
            raise ValueError(f"CANNOT_QUEUE_UNAPPROVED_DOCUMENT: {reason}")

        job_id = create_or_update_rag_job(
            con,
            document_id=doc_meta["documentId"],
            patient_uid=doc_meta["patientUid"],
            status="queued",
        )
        return {
            "success": True,
            "jobId": job_id,
            "documentId": doc_meta["documentId"],
            "patientUid": doc_meta["patientUid"],
            "status": "queued",
        }
    finally:
        con.close()


def ingest_document(
    document_id: str,
    db_path: Optional[str] = None,
    store: Optional[PatientVectorStore] = None,
    job_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute vector ingestion for a document.
    - Verifies RAG eligibility
    - Segments pages & clinical facts of current derivativeVersion
    - Updates RAGIngestionJob
    - Commits vectors via atomic swap
    """
    con = get_db_connection(db_path)
    vector_store = store or PatientVectorStore()
    active_job_id = job_id

    try:
        # 1. Fetch snapshot from DB
        doc_meta, pages, facts, approval = fetch_document_bundle_from_db(con, document_id)
        patient_uid = validate_patient_uid(doc_meta["patientUid"])

        # 2. Strict RAG Eligibility Check
        is_eligible, reason = check_rag_eligibility(doc_meta, approval)
        if not is_eligible:
            raise ValueError(f"DOCUMENT_NOT_RAG_ELIGIBLE: {reason}")

        # 3. Create or advance RAGIngestionJob
        if not active_job_id:
            active_job_id = create_or_update_rag_job(
                con,
                document_id=doc_meta["documentId"],
                patient_uid=patient_uid,
                status="indexing",
            )
        else:
            create_or_update_rag_job(
                con,
                document_id=doc_meta["documentId"],
                patient_uid=patient_uid,
                status="indexing",
                job_id=active_job_id,
            )

        # 4. Chunk approved pages and clinical facts
        chunks = chunk_document_bundle(
            doc_meta=doc_meta,
            pages=pages,
            facts=facts,
            approval=approval,
        )

        # 5. Ingest into isolated patient index
        doc_version = int(doc_meta.get("derivativeVersion", 1))
        ingest_result = vector_store.ingest_chunks(
            patient_uid=patient_uid,
            new_chunks=chunks,
            document_id=doc_meta["documentId"],
            document_version=doc_version,
        )

        # 6. Mark RAGIngestionJob completed
        create_or_update_rag_job(
            con,
            document_id=doc_meta["documentId"],
            patient_uid=patient_uid,
            status="completed",
            chunk_count=len(chunks),
            job_id=active_job_id,
        )

        return {
            "success": True,
            "jobId": active_job_id,
            "patientUid": patient_uid,
            "documentId": doc_meta["documentId"],
            "version": doc_version,
            "chunkCount": len(chunks),
            "alreadyIndexed": ingest_result.get("alreadyIndexed", False),
            "staleChunksRemoved": ingest_result.get("staleChunksRemoved", 0),
            "generation": ingest_result.get("generation", 1),
        }

    except Exception as e:
        logger.error(f"Failed RAG ingestion for document {document_id}: {e}")
        if active_job_id:
            try:
                create_or_update_rag_job(
                    con,
                    document_id=document_id,
                    patient_uid=doc_meta.get("patientUid", "unknown"),
                    status="failed",
                    error_details=str(e),
                    job_id=active_job_id,
                )
            except Exception:
                pass
        raise
    finally:
        con.close()


def rebuild_patient_index_from_db(
    patient_uid: str,
    db_path: Optional[str] = None,
    store: Optional[PatientVectorStore] = None,
) -> Dict[str, Any]:
    """
    Completely rebuild a patient's FAISS index consuming ONLY currently RAG-eligible documents.
    Stale versions and unapproved documents are completely ignored.
    """
    valid_uid = validate_patient_uid(patient_uid)
    con = get_db_connection(db_path)
    vector_store = store or PatientVectorStore()

    try:
        cur = con.cursor()
        # Find all approved documents for this patient
        cur.execute(
            """
            SELECT documentId FROM Document
            WHERE patientUid = ? AND status = 'approved'
            ORDER BY clinicalDate ASC, uploadDate ASC
            """,
            (valid_uid,),
        )
        doc_ids = [r["documentId"] for r in cur.fetchall()]

        all_eligible_chunks: List[ClinicalChunk] = []
        source_versions: Dict[str, int] = {}

        for doc_id in doc_ids:
            doc_meta, pages, facts, approval = fetch_document_bundle_from_db(con, doc_id)
            is_eligible, _ = check_rag_eligibility(doc_meta, approval)
            if not is_eligible:
                continue

            doc_version = int(doc_meta.get("derivativeVersion", 1))
            chunks = chunk_document_bundle(doc_meta, pages, facts, approval)
            all_eligible_chunks.extend(chunks)
            source_versions[doc_id] = doc_version

        # Perform atomic rebuild
        rebuild_result = vector_store.rebuild_patient_index(
            patient_uid=valid_uid,
            all_chunks=all_eligible_chunks,
            source_versions=source_versions,
        )

        return {
            "success": True,
            "patientUid": valid_uid,
            "eligibleDocumentsCount": len(source_versions),
            "totalChunks": len(all_eligible_chunks),
            "generation": rebuild_result.get("generation", 1),
        }
    finally:
        con.close()
