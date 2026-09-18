import logging
import os
import pickle
from typing import List, Tuple, Optional

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

from chunker import Chunk

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


class VectorStore:
    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        self.model_name = model_name
        self.model = SentenceTransformer(model_name)
        self.index: Optional[faiss.IndexFlatIP] = None
        self.chunks: List[Chunk] = []

    def _normalize(self, matrix: np.ndarray) -> np.ndarray:
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return (matrix / norms).astype("float32")

    def _embed(self, texts: List[str]) -> np.ndarray:
        """Generate sentence-transformer embeddings for a list of texts."""
        if not texts:
            return np.empty((0, 384), dtype=np.float32)
        embeddings = self.model.encode(texts, convert_to_numpy=True, normalize_embeddings=False)
        return np.asarray(embeddings, dtype=np.float32)

    def build(self, chunks: List[Chunk]) -> None:
        """Generate embeddings for all chunks and build the FAISS index."""
        self.chunks = list(chunks)
        if not chunks:
            self.index = None
            logger.warning("Empty chunk list provided to VectorStore.build().")
            return

        texts = [c.text for c in chunks]
        vectors = self._embed(texts)
        vectors = self._normalize(vectors)

        dim = vectors.shape[1]
        self.index = faiss.IndexFlatIP(dim)
        self.index.add(vectors)
        logger.info(f"Built FAISS IndexFlatIP with {len(chunks)} vectors of dimension {dim}.")

    def add_chunks(self, chunks: List[Chunk]) -> None:
        """Add new chunks to the existing FAISS index without rebuilding."""
        if not chunks:
            return

        if self.index is None:
            self.build(chunks)
            return

        texts = [c.text for c in chunks]
        vectors = self._embed(texts)
        vectors = self._normalize(vectors)

        self.index.add(vectors)
        self.chunks.extend(chunks)
        logger.info(f"Added {len(chunks)} chunks to vector index. Total chunks: {len(self.chunks)}.")

    def search(
        self,
        query: str,
        top_k: int = 5,
        patient_id: Optional[str] = None,
        year: Optional[int] = None,
        years: Optional[List[int]] = None,
    ) -> List[Tuple[Chunk, float]]:
        """
        Retrieve the most semantically similar chunks for a query with optional patient & year filtering.
        """
        if self.index is None or self.index.ntotal == 0 or not self.chunks:
            return []

        query_vec = self._embed([query])
        query_vec = self._normalize(query_vec)

        # Retrieve a wider pool if filtering is applied
        has_filter = patient_id is not None or year is not None or (years is not None and len(years) > 0)
        fetch_k = min(len(self.chunks), top_k * 6 if has_filter else top_k)
        if fetch_k <= 0:
            return []

        scores, indices = self.index.search(query_vec, fetch_k)

        results: List[Tuple[Chunk, float]] = []
        for score, idx in zip(scores[0], indices[0]):
            if idx == -1 or idx >= len(self.chunks):
                continue
            chunk = self.chunks[idx]

            # Apply patient_id filter if provided
            if patient_id and chunk.patient_id and chunk.patient_id.upper() != patient_id.upper():
                continue

            # Apply single year filter
            if year is not None and chunk.year is not None and chunk.year != year:
                continue

            # Apply multi-year filter list
            if years and chunk.year is not None and chunk.year not in years:
                continue

            results.append((chunk, float(score)))
            if len(results) >= top_k:
                break

        return results

    def get_all_chunks(self, patient_id: Optional[str] = None) -> List[Chunk]:
        """Return all indexed chunks, optionally filtered by patient ID."""
        if not patient_id:
            return list(self.chunks)
        return [c for c in self.chunks if (c.patient_id or "").upper() == patient_id.upper()]

    def get_chunks_by_year(self, year: int, patient_id: Optional[str] = None) -> List[Chunk]:
        """Return all chunks for a specific year and optional patient ID."""
        return [
            c
            for c in self.chunks
            if c.year == year and (patient_id is None or (c.patient_id or "").upper() == patient_id.upper())
        ]

    def save(self, path: str) -> None:
        """Save the FAISS index and chunk metadata to a directory."""
        if self.index is None:
            logger.warning(f"No FAISS index to save at '{path}'.")
            return
        os.makedirs(path, exist_ok=True)
        faiss.write_index(self.index, os.path.join(path, "index.faiss"))

        with open(os.path.join(path, "chunks.pkl"), "wb") as f:
            pickle.dump(self.chunks, f)
        logger.info(f"Saved FAISS index and {len(self.chunks)} chunk metadata to '{path}'.")

    def load(self, path: str) -> bool:
        """Load the FAISS index and chunk metadata from a directory."""
        index_file = os.path.join(path, "index.faiss")
        chunks_file = os.path.join(path, "chunks.pkl")

        if not os.path.exists(index_file) or not os.path.exists(chunks_file):
            logger.warning(f"Vector index files not found in '{path}'.")
            return False

        try:
            self.index = faiss.read_index(index_file)
            with open(chunks_file, "rb") as f:
                self.chunks = pickle.load(f)
            logger.info(f"Loaded FAISS index ({self.index.ntotal} vectors) and {len(self.chunks)} chunks from '{path}'.")
            return True
        except Exception as e:
            logger.error(f"Failed to load vector index from '{path}': {e}")
            return False


if __name__ == "__main__":
    from loader import load_documents
    from chunker import chunk_documents

    data_dir = "SYN-PAT-001_15yr_RAG_medical_history"
    save_path = os.path.join("vector_index", "SYN-PAT-001")

    docs = load_documents(data_dir)
    chunks = chunk_documents(docs)

    store = VectorStore()
    store.build(chunks)
    store.save(save_path)
    print(f"Indexed {len(chunks)} chunks into '{save_path}'.")

    results = store.search("When was type 2 diabetes diagnosed?", top_k=3)
    for c, score in results:
        print(f"[{score:.3f} | Year: {c.year} | Source: {c.source}] {c.text[:180]}\n")