"""
FastAPI Longitudinal RAG Service — Phase 5E
services/rag_service/main.py

Internal service only:
  - Binds to 127.0.0.1:8000
  - CORS disabled (no browser origins)
  - Constant-time X-Internal-Secret header validation
  - UUID path validation on every patient-scoped operation
  - Dual-path retrieval: Path A (FAISS semantic) + Path B (temporal clinical facts)
  - Grounded chronological LLM generation (Groq primary, Gemini fallback)
  - 8000ms asyncio timeout enforcement
  - 2 MB request body limit

Endpoints:
  POST /api/internal/rag/query   — Longitudinal query
  POST /api/internal/rag/ingest  — Direct-payload document ingestion
  GET  /api/internal/health      — Liveness probe
"""

import asyncio
import logging
import os
import secrets
import sys
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator

# Ensure the repo root is importable when running as a module
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.rag_service.generator import ClinicalGenerator, extract_citations
from services.rag_service.retriever import analyze_query, dual_path_retrieve
from services.rag_service.vectorstore import PatientVectorStore, validate_patient_uid

# ─── Configuration ─────────────────────────────────────────────────────────────
_INTERNAL_SECRET = os.environ.get("RAG_SERVICE_INTERNAL_TOKEN", "")
_RAG_TIMEOUT_MS = int(os.environ.get("RAG_TIMEOUT_MS", "8000"))
_RAG_TIMEOUT_S = _RAG_TIMEOUT_MS / 1000.0
_MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MB
_VECTOR_BASE_DIR = os.environ.get(
    "VECTOR_INDEX_ROOT",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "storage", "vector_index"))
)
os.makedirs(_VECTOR_BASE_DIR, exist_ok=True)

from services.rag_service.database import get_database_client, parse_database_config

_db_config = parse_database_config()
_DB_PATH = _db_config.get("sqlite_path")
_DB_URL = _db_config.get("url")

_DEFAULT_TOP_K = 6
_MAX_TOP_K = 20

# ─── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("RAGService")

if not _INTERNAL_SECRET:
    logger.warning(
        "RAG_SERVICE_INTERNAL_TOKEN is not set. "
        "All /api/internal/* requests will be rejected with 401."
    )

# ─── Singleton Services ────────────────────────────────────────────────────────
_store: Optional[PatientVectorStore] = None
_generator: Optional[ClinicalGenerator] = None


def get_store() -> PatientVectorStore:
    global _store
    if _store is None:
        _store = PatientVectorStore(base_dir=_VECTOR_BASE_DIR)
    return _store


def get_generator() -> ClinicalGenerator:
    global _generator
    if _generator is None:
        _generator = ClinicalGenerator()
    return _generator


# ─── App ─────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="MedSync Internal RAG Service",
    version="1.0.0-phase5e",
    docs_url=None,     # Disable Swagger UI (internal-only)
    redoc_url=None,
    openapi_url=None,
)

# CORS: explicitly no origins permitted (internal service only)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=False,
    allow_methods=[],
    allow_headers=[],
)


# ─── 2 MB Body Size Limiter ───────────────────────────────────────────────────
@app.middleware("http")
async def enforce_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > _MAX_BODY_BYTES:
        return JSONResponse(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            content={
                "success": False,
                "error": {
                    "code": "PAYLOAD_TOO_LARGE",
                    "message": "Request body exceeds the 2 MB internal limit.",
                },
            },
        )
    return await call_next(request)


# ─── Auth Helper ─────────────────────────────────────────────────────────────
def verify_internal_secret(request: Request) -> None:
    """Constant-time validation of X-Internal-Secret header."""
    if not _INTERNAL_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "INTERNAL_SECRET_NOT_CONFIGURED",
                "message": "Service is not configured with an internal secret.",
            },
        )
    provided = request.headers.get("X-Internal-Secret", "")
    if not secrets.compare_digest(provided, _INTERNAL_SECRET):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "INVALID_INTERNAL_SECRET",
                "message": "X-Internal-Secret header is missing or invalid.",
            },
        )


# ─── Request / Response Models ────────────────────────────────────────────────
class EncounterContext(BaseModel):
    tokenNumber: Optional[str] = None
    chiefComplaint: Optional[str] = None
    intakeSummary: Optional[str] = None


class QueryRequest(BaseModel):
    patientUid: str = Field(..., min_length=1, max_length=100)
    query: str = Field(..., min_length=1, max_length=2000)
    currentEncounterContext: Optional[EncounterContext] = None
    topK: Optional[int] = Field(default=_DEFAULT_TOP_K, ge=1, le=_MAX_TOP_K)
    year: Optional[int] = Field(default=None, ge=1900, le=2100)
    retrievalPath: Optional[str] = Field(default="auto")
    useHistory: Optional[bool] = True

    @validator("patientUid")
    def validate_uid(cls, v):
        try:
            validate_patient_uid(v)
        except ValueError as exc:
            raise ValueError(str(exc))
        return v.strip().lower()

    @validator("retrievalPath")
    def validate_path(cls, v):
        allowed = ("auto", "semantic", "temporal")
        if v and v.lower() not in allowed:
            raise ValueError(f"retrievalPath must be one of {allowed}, got '{v}'")
        return (v or "auto").lower()


class IngestPage(BaseModel):
    pageNumber: int = Field(..., ge=1)
    text: str = Field(..., min_length=0, max_length=100_000)
    provenance: Optional[str] = "DOCUMENT_EXTRACTED"


class IngestRequest(BaseModel):
    documentId: str = Field(..., min_length=1, max_length=200)
    patientUid: Optional[str] = None
    dbPath: Optional[str] = None
    documentName: Optional[str] = None
    documentVersion: Optional[int] = Field(default=1, ge=1)
    clinicalYear: Optional[int] = None
    pages: Optional[List[IngestPage]] = None

    @validator("patientUid")
    def validate_uid(cls, v):
        if v is not None:
            try:
                validate_patient_uid(v)
            except ValueError as exc:
                raise ValueError(str(exc))
            return v.strip().lower()
        return v


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/api/internal/health")
async def health():
    """Liveness probe — no auth required."""
    return {
        "status": "ok",
        "service": "MedSync RAG Engine",
        "version": "1.0.0-phase5e",
    }


@app.get("/api/internal/rag/stats/{patientUid}")
async def rag_stats(request: Request, patientUid: str):
    """
    GET /api/internal/rag/stats/{patientUid}

    Internal statistics for a patient's FAISS index.
    Requires X-Internal-Secret. Strict UUID isolation.
    """
    verify_internal_secret(request)
    try:
        valid_uid = validate_patient_uid(patientUid)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_PATIENT_UID", "message": str(exc)},
        )

    store = get_store()
    patient_dir = store.get_patient_dir(valid_uid)
    manifest_file = os.path.join(patient_dir, "manifest.json")
    chunks_file = os.path.join(patient_dir, "chunks.json")

    if not os.path.isfile(manifest_file) or not os.path.isfile(chunks_file):
        return {
            "success": True,
            "patientUid": valid_uid,
            "chunkCount": 0,
            "documentCount": 0,
            "sourceDocuments": [],
            "sourceVersions": {},
            "years": [],
            "embeddingModel": store.model_name,
            "embeddingDimension": store.dim,
            "indexGeneration": 0,
            "historyAvailable": False,
        }

    try:
        import json
        with open(manifest_file, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        if manifest.get("patientUid") != valid_uid:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={"code": "METADATA_MISMATCH", "message": "Manifest patientUid does not match requested index."},
            )

        with open(chunks_file, "r", encoding="utf-8") as f:
            chunks_raw = json.load(f)

        years = sorted(list({c.get("year") for c in chunks_raw if c.get("year") is not None}))
        source_versions = manifest.get("sourceVersions", {})
        source_docs = manifest.get("sourceDocumentIds", sorted(list(source_versions.keys())))

        return {
            "success": True,
            "patientUid": valid_uid,
            "chunkCount": int(manifest.get("chunkCount", len(chunks_raw))),
            "documentCount": len(source_docs),
            "sourceDocuments": source_docs,
            "sourceVersions": source_versions,
            "years": years,
            "embeddingModel": manifest.get("embeddingModel", store.model_name),
            "embeddingDimension": int(manifest.get("embeddingDimension", store.dim)),
            "indexGeneration": int(manifest.get("indexGeneration", 1)),
            "historyAvailable": len(chunks_raw) > 0,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Error reading stats for patient {valid_uid[:8]}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "INDEX_ERROR", "message": str(exc)},
        )


@app.post("/api/internal/rag/query")
async def rag_query(request: Request, body: QueryRequest):
    """
    POST /api/internal/rag/query

    Executes dual-path longitudinal retrieval and grounded generation.
    Internal service only; called via Node gateway.
    """
    verify_internal_secret(request)

    patient_uid = body.patientUid
    query = body.query
    top_k = body.topK or _DEFAULT_TOP_K
    encounter_ctx = body.currentEncounterContext.dict() if body.currentEncounterContext else None
    retrieval_path_req = body.retrievalPath or "auto"
    requested_year = body.year

    start_ms = time.monotonic()

    try:
        async with asyncio.timeout(_RAG_TIMEOUT_S):
            store = get_store()
            generator = get_generator()

            merged, strategy, retrieval_path = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: dual_path_retrieve(
                    store,
                    patient_uid,
                    query,
                    top_k=top_k,
                    db_path=_DB_PATH if (_DB_PATH and os.path.isfile(_DB_PATH)) else _DB_URL,
                    retrieval_path=retrieval_path_req,
                    year=requested_year,
                ),
            )

            gen_result = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: generator.generate(
                    query=query,
                    retrieved=merged,
                    encounter_context=encounter_ctx,
                ),
            )

    except asyncio.TimeoutError:
        logger.error(
            f"RAG query timed out after {_RAG_TIMEOUT_MS}ms for patient "
            f"(uid_prefix={patient_uid[:8]})"
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={
                "code": "RAG_TIMEOUT",
                "message": f"RAG query execution exceeded {_RAG_TIMEOUT_MS}ms timeout.",
            },
        )
    except ValueError as exc:
        logger.warning(f"Validation error in rag_query: {exc}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "SECURITY_VIOLATION", "message": str(exc)},
        )
    except Exception as exc:
        logger.error(f"Unexpected RAG query error: {exc}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "RAG_SERVICE_ERROR", "message": str(exc)},
        )

    elapsed_ms = round((time.monotonic() - start_ms) * 1000)

    is_no_history = gen_result.get("is_no_history", False) or (len(merged) == 0)
    history_available = not is_no_history

    # Confidence calculation
    top_score = max((s for _, s in merged), default=0.0) if merged else 0.0
    if is_no_history or not merged:
        confidence = "insufficient_evidence"
    elif top_score >= 0.50:
        confidence = "high"
    elif top_score >= 0.30:
        confidence = "medium"
    else:
        confidence = "low"

    years_covered = sorted(
        list({chunk.year for chunk, _ in merged if chunk.year is not None})
    )
    citations = extract_citations(merged)

    logger.info(
        f"RAG query completed: uid_prefix={patient_uid[:8]}, "
        f"strategy={strategy}, path={retrieval_path}, "
        f"chunks={len(merged)}, elapsed={elapsed_ms}ms, confidence={confidence}"
    )

    return {
        "success": True,
        "historyAvailable": history_available,
        "retrievalPath": retrieval_path,
        "strategy": strategy,
        "answer": gen_result.get("answer", ""),
        "confidence": confidence,
        "citations": citations,
        "retrievedChunks": len(merged),
        "latencyMs": elapsed_ms,
        "timeTakenMs": elapsed_ms,
        "yearsCovered": years_covered,
        "isNoHistory": is_no_history,
    }


@app.post("/api/internal/rag/ingest")
async def rag_ingest(request: Request, body: IngestRequest):
    """
    POST /api/internal/rag/ingest

    Document ingestion into the FAISS vector store.
    Supports either database-backed ingestion (validating RAG eligibility)
    or direct-payload page ingestion.
    """
    verify_internal_secret(request)

    document_id = body.documentId

    try:
        async with asyncio.timeout(_RAG_TIMEOUT_S):
            store = get_store()

            # Mode 1: Direct-payload page ingestion
            if body.pages is not None:
                patient_uid = body.patientUid
                if not patient_uid:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail={"code": "MISSING_PATIENT_UID", "message": "patientUid is required for direct page ingestion."},
                    )
                from services.rag_service.chunker import chunk_document_bundle

                doc_dict: Dict[str, Any] = {
                    "documentId": document_id,
                    "patientUid": patient_uid,
                    "documentName": body.documentName or document_id,
                    "derivativeVersion": body.documentVersion,
                    "clinicalDate": (
                        f"{body.clinicalYear}-01-01" if body.clinicalYear else None
                    ),
                    "documentType": "CLINICAL_RECORD",
                    "status": "approved",
                }
                pages_list = [
                    {
                        "pageNumber": p.pageNumber,
                        "extractedText": p.text,
                        "ocrText": p.text,
                        "ocrStatus": "ocr_processed",
                        "provenance": p.provenance or "DOCUMENT_EXTRACTED",
                        "version": body.documentVersion,
                    }
                    for p in body.pages
                ]
                approval_dict: Dict[str, Any] = {
                    "action": "APPROVED",
                    "approvedVersion": body.documentVersion,
                }

                chunks = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: chunk_document_bundle(doc_dict, pages_list, [], approval_dict),
                )

                result = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: store.upsert_document_chunks(patient_uid, document_id, chunks),
                )

                return {
                    "success": True,
                    "documentId": document_id,
                    "patientUid": patient_uid,
                    "version": body.documentVersion,
                    "chunksCreated": len(chunks),
                    "totalPatientChunks": result.get("chunkCount", len(chunks)),
                    "indexPath": f"vector_index/{patient_uid}",
                    "status": "INGESTED",
                }

            # Mode 2: Database-backed ingestion via Phase 5D ingestion engine
            else:
                from services.rag_service.ingestion import ingest_document

                db_path = body.dbPath or _DB_PATH
                result = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: ingest_document(document_id, db_path=db_path, store=store),
                )

                return {
                    "success": True,
                    "documentId": document_id,
                    "patientUid": result.get("patientUid"),
                    "version": result.get("version"),
                    "chunksCreated": result.get("newChunksIndexed", result.get("chunkCount", 0)),
                    "totalPatientChunks": result.get("chunkCount", 0),
                    "status": "INGESTED",
                }

    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={"code": "RAG_TIMEOUT", "message": "Ingestion exceeded timeout."},
        )
    except ValueError as exc:
        msg = str(exc)
        code = "DOCUMENT_NOT_ELIGIBLE"
        if "DOCUMENT_NOT_FOUND" in msg:
            code = "DOCUMENT_NOT_FOUND"
        elif "DOCUMENT_NOT_APPROVED" in msg:
            code = "DOCUMENT_NOT_APPROVED"
        elif "STALE_VERSION" in msg:
            code = "STALE_VERSION"
        elif "CANNOT_QUEUE_UNAPPROVED_DOCUMENT" in msg:
            code = "DOCUMENT_NOT_APPROVED"
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": code, "message": msg},
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Ingest error for doc {document_id}: {exc}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "INGEST_ERROR", "message": str(exc)},
        )


# ─── Entry Point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("RAG_SERVICE_PORT", "8000"))
    logger.info(f"Starting MedSync RAG Service on 127.0.0.1:{port}")
    uvicorn.run(
        "services.rag_service.main:app",
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=True,
    )
