"""
Production Multi-Patient VectorStore
services/rag_service/vectorstore.py

Implements:
- Physical filesystem isolation by canonical patient UUID: vector_index/{patientUid}/
- Strict UUID validation rejecting traversal (.., /, \\, null bytes)
- Metadata integrity: verifies patientUid on every loaded chunk
- Normalized dense embeddings (dim=384) with FAISS IndexFlatIP
- Patient-specific concurrency locking via .lock (filelock)
- Atomic multi-file swap via .tmp and os.replace
- Manifest integrity validation (embeddingModel, embeddingDimension, sourceVersions)
- Idempotent document version ingestion
- Document version replacement (superseding stale versions)
- Complete index rebuild from database RAG-eligible source records
- Read-only preservation of SYN-PAT-001 reference fixture
"""

import json
import logging
import os
import re
import shutil
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import faiss
import filelock
import numpy as np
from sentence_transformers import SentenceTransformer

from services.rag_service.chunker import ClinicalChunk

logger = logging.getLogger(__name__)

# Strict canonical UUID regex (RFC 4122 v4 / standard 8-4-4-4-12 hex)
UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# Benchmark fixture that MUST NEVER be modified, moved, or deleted
FROZEN_BENCHMARK_PATIENT_ID = "SYN-PAT-001"

# Embedding configuration
EXPECTED_EMBEDDING_MODEL = "all-MiniLM-L6-v2"
EXPECTED_EMBEDDING_DIM = 384
DEFAULT_INDEX_TYPE = "IndexFlatIP"

# Process-level model cache
_cached_model: Optional[SentenceTransformer] = None


def get_embedding_model(model_name: str = EXPECTED_EMBEDDING_MODEL) -> SentenceTransformer:
    """Singleton getter for SentenceTransformer to eliminate redundant cold-starts."""
    global _cached_model
    if _cached_model is None:
        logger.info(f"Loading SentenceTransformer embedding model: {model_name}")
        _cached_model = SentenceTransformer(model_name)
    return _cached_model


def validate_patient_uid(patient_uid: Any) -> str:
    """
    Validate that patient_uid is a canonical UUID.
    Rejects path traversal, null bytes, non-string, or non-UUID inputs.
    Raises ValueError with SECURITY_VIOLATION code on failure.
    """
    if not patient_uid or not isinstance(patient_uid, str):
        raise ValueError("SECURITY_VIOLATION: Invalid canonical patient UUID. Must be non-empty string.")

    cleaned = patient_uid.strip().lower()

    # Defense in depth: reject any path separator or traversal string
    if ".." in cleaned or "/" in cleaned or "\\" in cleaned or "\0" in cleaned:
        raise ValueError(f"SECURITY_VIOLATION: Path traversal detected in patient UID: '{patient_uid}'")

    if not UUID_REGEX.match(cleaned):
        raise ValueError(
            f"SECURITY_VIOLATION: Invalid canonical patient UUID format: '{patient_uid}'. Expected standard 8-4-4-4-12 hex format."
        )

    return cleaned


def normalize_vectors(matrix: np.ndarray) -> np.ndarray:
    """L2-normalize matrix rows for cosine similarity search in FAISS IndexFlatIP."""
    if matrix.size == 0:
        return matrix.astype("float32")
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (matrix / norms).astype("float32")


def safe_replace(src: str, dst: str):
    """Safely replace a file atomically, handling Windows PermissionError / file locks."""
    try:
        os.replace(src, dst)
    except PermissionError:
        import time
        for _ in range(5):
            time.sleep(0.05)
            try:
                if os.path.exists(dst):
                    os.remove(dst)
                os.replace(src, dst)
                return
            except PermissionError:
                pass
        if os.path.exists(dst):
            os.remove(dst)
        os.replace(src, dst)


class PatientVectorStore:
    def __init__(
        self,
        base_dir: str = "vector_index",
        model_name: str = EXPECTED_EMBEDDING_MODEL,
    ):
        self.base_dir = os.path.abspath(base_dir)
        self.model_name = model_name
        self.dim = EXPECTED_EMBEDDING_DIM
        self._model = None

    @property
    def model(self) -> SentenceTransformer:
        if self._model is None:
            self._model = get_embedding_model(self.model_name)
        return self._model

    def get_patient_dir(self, patient_uid: str) -> str:
        """Resolve and validate the isolated filesystem directory for a patient."""
        valid_uid = validate_patient_uid(patient_uid)
        patient_dir = os.path.join(self.base_dir, valid_uid)

        # Enforce boundary: patient_dir must be an immediate child of base_dir
        parent = os.path.abspath(os.path.dirname(patient_dir))
        if parent != self.base_dir:
            raise ValueError(f"SECURITY_VIOLATION: Patient directory escaped base directory: '{patient_dir}'")

        return patient_dir

    def _get_lock(self, patient_dir: str) -> filelock.FileLock:
        """Acquire a patient-specific process lock."""
        os.makedirs(patient_dir, exist_ok=True)
        lock_path = os.path.join(patient_dir, ".lock")
        return filelock.FileLock(lock_path, timeout=15.0, preserve_lock_file=True)

    def _embed_texts(self, texts: List[str]) -> np.ndarray:
        """Compute normalized dense embeddings for a list of texts."""
        if not texts:
            return np.empty((0, self.dim), dtype=np.float32)
        embeddings = self.model.encode(
            texts,
            convert_to_numpy=True,
            normalize_embeddings=False,
            show_progress_bar=False,
        )
        matrix = np.asarray(embeddings, dtype=np.float32)
        return normalize_vectors(matrix)

    def has_index(self, patient_uid: str) -> bool:
        """Check if an active vector index exists for this patient."""
        try:
            patient_dir = self.get_patient_dir(patient_uid)
            index_file = os.path.join(patient_dir, "index.faiss")
            manifest_file = os.path.join(patient_dir, "manifest.json")
            return os.path.isfile(index_file) and os.path.isfile(manifest_file)
        except Exception:
            return False

    def load_patient_index(
        self, patient_uid: str
    ) -> Tuple[Optional[faiss.IndexFlatIP], List[ClinicalChunk], Dict[str, Any]]:
        """
        Load FAISS index, chunks, and manifest for a specific patient.
        Strictly verifies:
        1. patient_uid format
        2. Manifest patientUid matches requested patient_uid
        3. Every chunk's patient_uid matches requested patient_uid
        4. Manifest embedding model and dimension match configuration
        """
        valid_uid = validate_patient_uid(patient_uid)
        patient_dir = self.get_patient_dir(valid_uid)

        index_file = os.path.join(patient_dir, "index.faiss")
        chunks_file = os.path.join(patient_dir, "chunks.json")
        manifest_file = os.path.join(patient_dir, "manifest.json")

        if not os.path.isfile(index_file) or not os.path.isfile(chunks_file) or not os.path.isfile(manifest_file):
            return None, [], {}

        # 1. Load and validate manifest
        with open(manifest_file, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        if manifest.get("patientUid") != valid_uid:
            raise ValueError(
                f"METADATA_MISMATCH: Manifest patientUid '{manifest.get('patientUid')}' does not match requested '{valid_uid}'"
            )

        if manifest.get("embeddingModel") != self.model_name:
            raise ValueError(
                f"MODEL_MISMATCH: Index built with '{manifest.get('embeddingModel')}', current model is '{self.model_name}'"
            )

        if int(manifest.get("embeddingDimension", 0)) != self.dim:
            raise ValueError(
                f"DIMENSION_MISMATCH: Index dimension {manifest.get('embeddingDimension')} != expected {self.dim}"
            )

        # 2. Load and validate chunks
        with open(chunks_file, "r", encoding="utf-8") as f:
            chunks_raw = json.load(f)

        chunks: List[ClinicalChunk] = []
        for c_dict in chunks_raw:
            chunk = ClinicalChunk.from_dict(c_dict)
            if chunk.patient_uid != valid_uid:
                raise ValueError(
                    f"METADATA_MISMATCH: Cross-patient data detected. Chunk {chunk.chunk_id} belongs to '{chunk.patient_uid}', expected '{valid_uid}'"
                )
            chunks.append(chunk)

        # 3. Load FAISS index
        index = faiss.read_index(index_file)

        if index.ntotal != len(chunks):
            raise ValueError(
                f"INDEX_CORRUPTION: FAISS vector count ({index.ntotal}) does not match chunk count ({len(chunks)})"
            )

        return index, chunks, manifest

    def _write_atomic_snapshot(
        self,
        patient_dir: str,
        valid_uid: str,
        index: faiss.IndexFlatIP,
        chunks: List[ClinicalChunk],
        source_versions: Dict[str, int],
        generation: int,
    ) -> Dict[str, Any]:
        """
        Atomically write index.faiss, chunks.json, metadata.json, and manifest.json
        via temporary files and os.replace under lock.
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        manifest_path = os.path.join(patient_dir, "manifest.json")
        created_at = now_iso

        if os.path.isfile(manifest_path):
            try:
                with open(manifest_path, "r", encoding="utf-8") as f:
                    old_manifest = json.load(f)
                    created_at = old_manifest.get("createdAt", now_iso)
            except Exception:
                pass

        manifest_data = {
            "patientUid": valid_uid,
            "embeddingModel": self.model_name,
            "embeddingDimension": self.dim,
            "indexType": DEFAULT_INDEX_TYPE,
            "chunkCount": len(chunks),
            "sourceDocumentIds": sorted(list(source_versions.keys())),
            "sourceVersions": source_versions,
            "createdAt": created_at,
            "updatedAt": now_iso,
            "indexGeneration": generation,
        }

        chunks_data = [c.to_dict() for c in chunks]
        metadata_data = [
            {
                "chunk_id": c.chunk_id,
                "document_id": c.document_id,
                "page_number": c.page_number,
                "clinical_date": c.clinical_date,
                "upload_date": c.upload_date,
                "provenance": c.provenance,
                "document_version": c.document_version,
                "approval_version": c.approval_version,
                "is_clinical_fact": c.is_clinical_fact,
                "fact_type": c.fact_type,
                "fact_key": c.fact_key,
                "fact_value": c.fact_value,
                "unit": c.unit,
            }
            for c in chunks
        ]

        # Temp paths in same directory for guaranteed atomic rename on POSIX & Windows
        tmp_index = os.path.join(patient_dir, "index.faiss.tmp")
        tmp_chunks = os.path.join(patient_dir, "chunks.json.tmp")
        tmp_meta = os.path.join(patient_dir, "metadata.json.tmp")
        tmp_manifest = os.path.join(patient_dir, "manifest.json.tmp")

        target_index = os.path.join(patient_dir, "index.faiss")
        target_chunks = os.path.join(patient_dir, "chunks.json")
        target_meta = os.path.join(patient_dir, "metadata.json")
        target_manifest = os.path.join(patient_dir, "manifest.json")

        try:
            # 1. Write FAISS index to tmp
            faiss.write_index(index, tmp_index)

            # 2. Write chunks.json to tmp
            with open(tmp_chunks, "w", encoding="utf-8") as f:
                json.dump(chunks_data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())

            # 3. Write metadata.json to tmp
            with open(tmp_meta, "w", encoding="utf-8") as f:
                json.dump(metadata_data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())

            # 4. Write manifest.json to tmp
            with open(tmp_manifest, "w", encoding="utf-8") as f:
                json.dump(manifest_data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())

            # 5. Atomically replace target files
            safe_replace(tmp_index, target_index)
            safe_replace(tmp_chunks, target_chunks)
            safe_replace(tmp_meta, target_meta)
            safe_replace(tmp_manifest, target_manifest)

            logger.info(
                f"Successfully committed atomic vector snapshot for patient {valid_uid} "
                f"({len(chunks)} chunks, generation {generation})"
            )
            return manifest_data
        except Exception as e:
            # Clean up temporary files on failure
            for tmp in (tmp_index, tmp_chunks, tmp_meta, tmp_manifest):
                if os.path.isfile(tmp):
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
            logger.error(f"Failed to commit atomic snapshot for {valid_uid}: {e}")
            raise

    def ingest_chunks(
        self,
        patient_uid: str,
        new_chunks: List[ClinicalChunk],
        document_id: str,
        document_version: int,
    ) -> Dict[str, Any]:
        """
        Ingest chunks for an approved document version into the patient's isolated index.
        Features:
        - Patient file lock
        - Idempotency check: returns alreadyIndexed: True if same (doc, version) exists
        - Version replacement: replaces stale versions of document_id
        - Atomic swap
        """
        valid_uid = validate_patient_uid(patient_uid)
        patient_dir = self.get_patient_dir(valid_uid)

        # Ensure all incoming chunks belong to valid_uid
        for chunk in new_chunks:
            if chunk.patient_uid != valid_uid:
                raise ValueError(
                    f"SECURITY_VIOLATION: Chunk {chunk.chunk_id} has patient_uid '{chunk.patient_uid}', does not match target '{valid_uid}'"
                )

        lock = self._get_lock(patient_dir)
        with lock:
            # Load existing state if available
            existing_index, existing_chunks, existing_manifest = self.load_patient_index(valid_uid)

            source_versions: Dict[str, int] = {}
            generation = 1
            if existing_manifest:
                source_versions = dict(existing_manifest.get("sourceVersions", {}))
                generation = int(existing_manifest.get("indexGeneration", 0)) + 1

            # Idempotency Check: is this exact (document_id, document_version) already indexed?
            if source_versions.get(document_id) == document_version:
                logger.info(
                    f"Document {document_id} v{document_version} already indexed for patient {valid_uid}. Idempotent return."
                )
                return {
                    "alreadyIndexed": True,
                    "patientUid": valid_uid,
                    "documentId": document_id,
                    "version": document_version,
                    "chunkCount": len(existing_chunks),
                    "generation": generation - 1,
                }

            # Filter out stale chunks from older versions of this same documentId
            retained_chunks = [c for c in existing_chunks if c.document_id != document_id]
            stale_count = len(existing_chunks) - len(retained_chunks)
            if stale_count > 0:
                logger.info(
                    f"Superseding older version of document {document_id} for patient {valid_uid}. Removed {stale_count} stale chunks."
                )

            # Combine retained chunks + new chunks
            combined_chunks = retained_chunks + new_chunks
            source_versions[document_id] = document_version

            if not combined_chunks:
                # No chunks at all
                empty_index = faiss.IndexFlatIP(self.dim)
                manifest = self._write_atomic_snapshot(
                    patient_dir, valid_uid, empty_index, [], source_versions, generation
                )
                return {
                    "alreadyIndexed": False,
                    "patientUid": valid_uid,
                    "documentId": document_id,
                    "version": document_version,
                    "chunkCount": 0,
                    "generation": generation,
                }

            # Generate embeddings for combined chunks
            texts = [c.source_text for c in combined_chunks]
            vectors = self._embed_texts(texts)

            # Build new FAISS index
            new_index = faiss.IndexFlatIP(self.dim)
            new_index.add(vectors)

            # Atomically commit
            manifest = self._write_atomic_snapshot(
                patient_dir, valid_uid, new_index, combined_chunks, source_versions, generation
            )

            return {
                "alreadyIndexed": False,
                "patientUid": valid_uid,
                "documentId": document_id,
                "version": document_version,
                "chunkCount": len(combined_chunks),
                "newChunksIndexed": len(new_chunks),
                "staleChunksRemoved": stale_count,
                "generation": generation,
            }

    def rebuild_patient_index(
        self,
        patient_uid: str,
        all_chunks: List[ClinicalChunk],
        source_versions: Dict[str, int],
    ) -> Dict[str, Any]:
        """
        Completely rebuild the patient's FAISS index from supplied RAG-eligible chunks.
        Performs atomic swap under lock.
        """
        valid_uid = validate_patient_uid(patient_uid)
        patient_dir = self.get_patient_dir(valid_uid)

        for chunk in all_chunks:
            if chunk.patient_uid != valid_uid:
                raise ValueError(
                    f"SECURITY_VIOLATION: Cross-patient chunk detected during rebuild. Expected {valid_uid}, found {chunk.patient_uid}"
                )

        lock = self._get_lock(patient_dir)
        with lock:
            generation = 1
            if os.path.isfile(os.path.join(patient_dir, "manifest.json")):
                try:
                    with open(os.path.join(patient_dir, "manifest.json"), "r", encoding="utf-8") as f:
                        old_m = json.load(f)
                        generation = int(old_m.get("indexGeneration", 0)) + 1
                except Exception:
                    pass

            if not all_chunks:
                empty_index = faiss.IndexFlatIP(self.dim)
                self._write_atomic_snapshot(
                    patient_dir, valid_uid, empty_index, [], source_versions, generation
                )
                return {
                    "rebuilt": True,
                    "patientUid": valid_uid,
                    "chunkCount": 0,
                    "generation": generation,
                }

            texts = [c.source_text for c in all_chunks]
            vectors = self._embed_texts(texts)

            index = faiss.IndexFlatIP(self.dim)
            index.add(vectors)

            manifest = self._write_atomic_snapshot(
                patient_dir, valid_uid, index, all_chunks, source_versions, generation
            )

            return {
                "rebuilt": True,
                "patientUid": valid_uid,
                "chunkCount": len(all_chunks),
                "generation": generation,
            }

    def search(
        self,
        patient_uid: str,
        query: str,
        top_k: int = 5,
        year: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Search patient's isolated vector index for semantically similar chunks.
        Strictly enforces:
        1. Query cannot cross patients; only patient_uid's directory is accessed.
        2. Returns source citation metadata for future grounded synthesis.
        """
        valid_uid = validate_patient_uid(patient_uid)
        index, chunks, manifest = self.load_patient_index(valid_uid)

        if index is None or index.ntotal == 0 or not chunks:
            return []

        if not query or not query.strip():
            return []

        query_vec = self._embed_texts([query.strip()])
        fetch_k = min(len(chunks), top_k * 4 if year is not None else top_k)
        if fetch_k <= 0:
            return []

        scores, indices = index.search(query_vec, fetch_k)

        results: List[Dict[str, Any]] = []
        for score, idx in zip(scores[0], indices[0]):
            if idx == -1 or idx >= len(chunks):
                continue
            chunk = chunks[idx]

            # Optional year filter
            if year is not None and chunk.year is not None and chunk.year != year:
                continue

            results.append({
                "chunk": chunk.to_dict(),
                "score": float(score),
                "citation": {
                    "documentId": chunk.document_id,
                    "pageNumber": chunk.page_number,
                    "documentVersion": chunk.document_version,
                    "approvalVersion": chunk.approval_version,
                    "clinicalDate": chunk.clinical_date,
                    "uploadDate": chunk.upload_date,
                    "year": chunk.year,
                    "provenance": chunk.provenance,
                    "isClinicalFact": chunk.is_clinical_fact,
                    "factType": chunk.fact_type,
                    "factKey": chunk.fact_key,
                    "factValue": chunk.fact_value,
                }
            })

            if len(results) >= top_k:
                break

        return results
