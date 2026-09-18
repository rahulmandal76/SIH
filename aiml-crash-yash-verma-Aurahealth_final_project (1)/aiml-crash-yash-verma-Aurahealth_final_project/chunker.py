import logging
import re
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional

from loader import Document

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


@dataclass
class Chunk:
    id: str
    source: str
    text: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    patient_id: Optional[str] = None
    year: Optional[int] = None
    document_type: Optional[str] = None

    def __post_init__(self):
        # Sync metadata dict with explicit attributes
        if self.patient_id and "patient_id" not in self.metadata:
            self.metadata["patient_id"] = self.patient_id
        elif not self.patient_id and "patient_id" in self.metadata:
            self.patient_id = self.metadata["patient_id"]

        if self.year is not None and "year" not in self.metadata:
            self.metadata["year"] = self.year
        elif self.year is None and "year" in self.metadata:
            self.year = self.metadata["year"]

        if self.document_type and "document_type" not in self.metadata:
            self.metadata["document_type"] = self.document_type
        elif not self.document_type and "document_type" in self.metadata:
            self.document_type = self.metadata["document_type"]

        if self.source and "source" not in self.metadata:
            self.metadata["source"] = self.source


def _split_long_text(text: str, chunk_size: int, chunk_overlap: int) -> List[str]:
    """Fallback sliding window split for paragraphs exceeding chunk_size."""
    pieces = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + chunk_size, n)
        # Try to break at a newline or sentence end if possible
        if end < n:
            split_pos = text.rfind("\n", start + chunk_size // 2, end)
            if split_pos == -1:
                split_pos = text.rfind(". ", start + chunk_size // 2, end)
            if split_pos != -1 and split_pos > start:
                end = split_pos + 1
        pieces.append(text[start:end].strip())
        if end >= n:
            break
        start = max(start + 1, end - chunk_overlap)
    return [p for p in pieces if p]


def chunk_document(
    doc: Document, chunk_size: int = 800, chunk_overlap: int = 120
) -> List[Chunk]:
    """
    Split a clinical Document into semantically meaningful chunks while preserving
    clinical coherence (labs, assessments, medications, dates) and temporal metadata.
    """
    # Identify patient ID and Year from document metadata
    patient_id = doc.patient_id or doc.metadata.get("patient_id", "SYN-PAT-001")
    year = doc.year if doc.year is not None else doc.metadata.get("year")
    doc_type = doc.document_type or doc.metadata.get("document_type", "yearly_medical_history")

    # Split text primarily by section headers or double newlines
    # Patterns like === SECTION === or double newlines
    paragraphs = [p.strip() for p in doc.text.split("\n\n") if p.strip()]

    raw_chunks: List[str] = []
    current_chunk = ""

    for para in paragraphs:
        # Check if adding this paragraph exceeds chunk_size
        if len(para) > chunk_size:
            if current_chunk:
                raw_chunks.append(current_chunk)
                current_chunk = ""
            raw_chunks.extend(_split_long_text(para, chunk_size, chunk_overlap))
            continue

        candidate = f"{current_chunk}\n\n{para}" if current_chunk else para
        if len(candidate) <= chunk_size:
            current_chunk = candidate
        else:
            if current_chunk:
                raw_chunks.append(current_chunk)
            # Add small overlap from previous context
            overlap_prefix = ""
            if chunk_overlap > 0 and current_chunk:
                lines = current_chunk.split("\n")
                overlap_prefix = lines[-1] if len(lines[-1]) <= chunk_overlap else current_chunk[-chunk_overlap:]
            current_chunk = f"{overlap_prefix}\n{para}".strip() if overlap_prefix else para

    if current_chunk:
        raw_chunks.append(current_chunk)

    # Build Chunk objects with contextual headers and metadata
    chunks: List[Chunk] = []
    for i, raw_text in enumerate(raw_chunks):
        chunk_id = f"{doc.source}::chunk_{i}"
        
        # Ensure chunk text carries patient & year context for standalone retrieval
        header_tag = ""
        if year is not None and f"YEAR: {year}" not in raw_text and f"[{year}]" not in raw_text:
            header_tag = f"[{patient_id} | Year: {year}]\n"
        
        annotated_text = f"{header_tag}{raw_text}".strip()

        chunk_meta = dict(doc.metadata)
        chunk_meta.update({
            "chunk_id": chunk_id,
            "chunk_index": i,
            "patient_id": patient_id,
            "year": year,
            "source": doc.source,
            "document_type": doc_type,
        })

        chunks.append(
            Chunk(
                id=chunk_id,
                source=doc.source,
                text=annotated_text,
                metadata=chunk_meta,
                patient_id=patient_id,
                year=year,
                document_type=doc_type,
            )
        )

    return chunks


def chunk_documents(
    docs: List[Document], chunk_size: int = 800, chunk_overlap: int = 120
) -> List[Chunk]:
    """Chunk all provided Document objects."""
    all_chunks: List[Chunk] = []
    for doc in docs:
        all_chunks.extend(chunk_document(doc, chunk_size=chunk_size, chunk_overlap=chunk_overlap))
    return all_chunks


if __name__ == "__main__":
    from loader import load_documents

    docs = load_documents("SYN-PAT-001_15yr_RAG_medical_history")
    chunks = chunk_documents(docs)
    print(f"Total chunks generated: {len(chunks)}")
    for c in chunks[:5]:
        print(f"--- Chunk ID: {c.id} | Year: {c.year} | Patient: {c.patient_id} ---")
        print(c.text[:220])
        print()
