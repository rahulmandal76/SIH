"""
Production RAG Internal IPC Bridge & Worker
services/rag_service/worker.py

Provides a high-performance, internal, non-HTTP stdio bridge and CLI interface.
Maintains persistent in-memory model to avoid cold-start overhead.
Strictly internal: no HTTP listener, no browser access.
"""

import json
import logging
import os
import shutil
import sys
import traceback
from typing import Any, Dict

from services.rag_service.chunker import (
    ClinicalChunk,
    build_temporal_header,
    chunk_clinical_fact,
    chunk_document_bundle,
    chunk_document_page,
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
    validate_patient_uid,
)

# Configure logging to stderr so stdout is strictly pure JSON responses
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s - [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("RAGWorker")


def handle_command(cmd_data: Dict[str, Any]) -> Dict[str, Any]:
    cmd = cmd_data.get("command")
    if not cmd:
        return {"success": False, "error": "MISSING_COMMAND"}

    base_dir = cmd_data.get("baseDir", "vector_index")
    db_path = cmd_data.get("dbPath")

    try:
        if cmd == "ping":
            return {"success": True, "pong": True, "pid": os.getpid()}

        elif cmd == "validate_uuid":
            uid = cmd_data.get("patientUid")
            cleaned = validate_patient_uid(uid)
            return {"success": True, "patientUid": cleaned}

        elif cmd == "check_eligibility":
            doc = cmd_data.get("doc")
            approval = cmd_data.get("approval")
            eligible, reason = check_rag_eligibility(doc, approval)
            return {"success": True, "eligible": eligible, "reason": reason}

        elif cmd == "chunk_bundle":
            doc = cmd_data.get("doc")
            pages = cmd_data.get("pages", [])
            facts = cmd_data.get("facts", [])
            approval = cmd_data.get("approval")
            chunks = chunk_document_bundle(doc, pages, facts, approval)
            return {
                "success": True,
                "chunks": [c.to_dict() for c in chunks],
                "chunkCount": len(chunks),
            }

        elif cmd == "ingest_document":
            document_id = cmd_data.get("documentId")
            job_id = cmd_data.get("jobId")
            store = PatientVectorStore(base_dir=base_dir)
            result = ingest_document(
                document_id=document_id,
                db_path=db_path,
                store=store,
                job_id=job_id,
            )
            return result

        elif cmd == "queue_job":
            document_id = cmd_data.get("documentId")
            result = queue_rag_ingestion(document_id=document_id, db_path=db_path)
            return result

        elif cmd == "rebuild_patient":
            patient_uid = cmd_data.get("patientUid")
            store = PatientVectorStore(base_dir=base_dir)
            result = rebuild_patient_index_from_db(
                patient_uid=patient_uid,
                db_path=db_path,
                store=store,
            )
            return result

        elif cmd == "search":
            patient_uid = cmd_data.get("patientUid")
            query = cmd_data.get("query", "")
            top_k = int(cmd_data.get("topK", 5))
            year = cmd_data.get("year")
            if year is not None:
                year = int(year)
            store = PatientVectorStore(base_dir=base_dir)
            results = store.search(
                patient_uid=patient_uid,
                query=query,
                top_k=top_k,
                year=year,
            )
            return {"success": True, "results": results, "count": len(results)}

        elif cmd == "get_manifest":
            patient_uid = cmd_data.get("patientUid")
            store = PatientVectorStore(base_dir=base_dir)
            _, _, manifest = store.load_patient_index(patient_uid)
            return {"success": True, "manifest": manifest}

        elif cmd == "cleanup_patient_dir":
            patient_uid = cmd_data.get("patientUid")
            store = PatientVectorStore(base_dir=base_dir)
            patient_dir = store.get_patient_dir(patient_uid)
            if os.path.isdir(patient_dir):
                shutil.rmtree(patient_dir, ignore_errors=True)
            return {"success": True, "cleaned": patient_dir}

        elif cmd == "inspect_benchmark":
            # Read-only benchmark inspection
            benchmark_path = os.path.abspath(
                os.path.join(
                    os.path.dirname(__file__),
                    "..",
                    "..",
                    "aiml-crash-yash-verma-Aurahealth_final_project (1)",
                    "aiml-crash-yash-verma-Aurahealth_final_project",
                    "vector_index",
                    "SYN-PAT-001",
                )
            )
            exists = os.path.isdir(benchmark_path)
            index_path = os.path.join(benchmark_path, "index.faiss")
            chunks_path = os.path.join(benchmark_path, "chunks.pkl")
            return {
                "success": True,
                "exists": exists,
                "indexExists": os.path.isfile(index_path),
                "chunksExists": os.path.isfile(chunks_path),
                "expectedDim": EXPECTED_EMBEDDING_DIM,
                "expectedModel": EXPECTED_EMBEDDING_MODEL,
            }

        else:
            return {"success": False, "error": f"UNKNOWN_COMMAND: '{cmd}'"}

    except Exception as e:
        logger.error(f"Error executing command '{cmd}': {e}\n{traceback.format_exc()}")
        return {"success": False, "error": str(e), "errorType": type(e).__name__}


def run_stdio_loop():
    """Run persistent JSON lines stdio server."""
    # Warm up model once at worker boot
    logger.info("Initializing RAG worker bridge...")
    try:
        from services.rag_service.vectorstore import get_embedding_model
        get_embedding_model()
    except Exception as e:
        logger.warning(f"Embedding model pre-warm delayed: {e}")

    # Send ready signal to stdout
    sys.stdout.write(json.dumps({"status": "READY", "pid": os.getpid()}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd_data = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stdout.write(json.dumps({"success": False, "error": f"INVALID_JSON: {e}"}) + "\n")
            sys.stdout.flush()
            continue

        response = handle_command(cmd_data)
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--cli":
        if len(sys.argv) > 2:
            payload = json.loads(sys.argv[2])
            res = handle_command(payload)
            print(json.dumps(res, indent=2))
        else:
            print("Usage: python -m services.rag_service.worker --cli '<json_payload>'")
    else:
        run_stdio_loop()
