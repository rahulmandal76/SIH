"""
Production Clinical Chunker
services/rag_service/chunker.py

Implements production-side temporal chunking preserving:
- AuraHealth clinical chunking semantics (800 char target, 120 char overlap)
- Canonical provenance taxonomy (DOCUMENT_EXTRACTED, OCR_EXTRACTED, DOCTOR_ENTERED, etc.)
- Deterministic chunk IDs
- Exact page attribution and document version binding
- Strict separation of clinicalDate vs uploadDate (no date fabrication)
- Structured clinical fact representation and linkage
"""

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class ClinicalChunk:
    chunk_id: str
    patient_uid: str
    document_id: str
    page_number: int
    document_version: int
    approval_version: int
    source_text: str
    provenance: str
    clinical_date: Optional[str] = None
    upload_date: Optional[str] = None
    year: Optional[int] = None
    chunk_index: int = 0
    document_type: Optional[str] = None
    is_clinical_fact: bool = False
    fact_type: Optional[str] = None
    fact_key: Optional[str] = None
    fact_value: Optional[str] = None
    unit: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        # Synchronize metadata dictionary
        self.metadata.update({
            "chunk_id": self.chunk_id,
            "patient_uid": self.patient_uid,
            "patient_id": self.patient_uid,  # AuraHealth compatibility
            "document_id": self.document_id,
            "page_number": self.page_number,
            "document_version": self.document_version,
            "approval_version": self.approval_version,
            "provenance": self.provenance,
            "clinical_date": self.clinical_date,
            "upload_date": self.upload_date,
            "year": self.year,
            "chunk_index": self.chunk_index,
            "document_type": self.document_type,
            "is_clinical_fact": self.is_clinical_fact,
            "fact_type": self.fact_type,
            "fact_key": self.fact_key,
            "fact_value": self.fact_value,
            "unit": self.unit,
        })

    def to_dict(self) -> Dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "patient_uid": self.patient_uid,
            "patient_id": self.patient_uid,
            "document_id": self.document_id,
            "page_number": self.page_number,
            "document_version": self.document_version,
            "approval_version": self.approval_version,
            "source_text": self.source_text,
            "provenance": self.provenance,
            "clinical_date": self.clinical_date,
            "upload_date": self.upload_date,
            "year": self.year,
            "chunk_index": self.chunk_index,
            "document_type": self.document_type,
            "is_clinical_fact": self.is_clinical_fact,
            "fact_type": self.fact_type,
            "fact_key": self.fact_key,
            "fact_value": self.fact_value,
            "unit": self.unit,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ClinicalChunk":
        meta = dict(data.get("metadata", {}))
        return cls(
            chunk_id=data["chunk_id"],
            patient_uid=data.get("patient_uid") or data.get("patient_id", ""),
            document_id=data["document_id"],
            page_number=int(data["page_number"]),
            document_version=int(data.get("document_version", 1)),
            approval_version=int(data.get("approval_version", 1)),
            source_text=data["source_text"],
            provenance=data.get("provenance", "DOCUMENT_EXTRACTED"),
            clinical_date=data.get("clinical_date"),
            upload_date=data.get("upload_date"),
            year=data.get("year"),
            chunk_index=int(data.get("chunk_index", 0)),
            document_type=data.get("document_type"),
            is_clinical_fact=bool(data.get("is_clinical_fact", False)),
            fact_type=data.get("fact_type"),
            fact_key=data.get("fact_key"),
            fact_value=data.get("fact_value"),
            unit=data.get("unit"),
            metadata=meta,
        )


def _extract_year_from_iso_date(date_val: Any) -> Optional[int]:
    """Safely extract integer year from date string or None if unparseable/null."""
    if not date_val:
        return None
    if isinstance(date_val, datetime):
        return date_val.year
    date_str = str(date_val).strip()
    match = re.search(r"(\d{4})", date_str)
    if match:
        try:
            year = int(match.group(1))
            if 1900 <= year <= 2100:
                return year
        except ValueError:
            pass
    return None


def _format_date_string(date_val: Any) -> Optional[str]:
    """Format date to ISO string without fabricating dates."""
    if not date_val:
        return None
    if isinstance(date_val, datetime):
        return date_val.strftime("%Y-%m-%d")
    date_str = str(date_val).strip()
    if not date_str or date_str.lower() in ("null", "none", "undefined"):
        return None
    # Truncate time if ISO timestamp e.g. 2024-03-15T00:00:00.000Z
    match = re.match(r"^(\d{4}-\d{2}-\d{2})", date_str)
    if match:
        return match.group(1)
    return date_str


def _split_long_text(text: str, chunk_size: int = 800, chunk_overlap: int = 120) -> List[str]:
    """Sliding window fallback split for long text blocks."""
    pieces = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + chunk_size, n)
        if end < n:
            split_pos = text.rfind("\n", start + chunk_size // 2, end)
            if split_pos == -1:
                split_pos = text.rfind(". ", start + chunk_size // 2, end)
            if split_pos != -1 and split_pos > start:
                end = split_pos + 1
        segment = text[start:end].strip()
        if segment:
            pieces.append(segment)
        if end >= n:
            break
        start = max(start + 1, end - chunk_overlap)
    return [p for p in pieces if p]


def split_into_paragraphs(text: str, chunk_size: int = 800, chunk_overlap: int = 120) -> List[str]:
    """
    Split text into coherent chunks honoring paragraphs and max chunk_size.
    AuraHealth reference chunking semantics.
    """
    if not text or not text.strip():
        return []

    # Clean redundant whitespace while preserving double newlines
    normalized = re.sub(r"\r\n", "\n", text.strip())
    paragraphs = [p.strip() for p in normalized.split("\n\n") if p.strip()]

    raw_chunks: List[str] = []
    current_chunk = ""

    for para in paragraphs:
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
            overlap_prefix = ""
            if chunk_overlap > 0 and current_chunk:
                lines = current_chunk.split("\n")
                overlap_prefix = lines[-1] if len(lines[-1]) <= chunk_overlap else current_chunk[-chunk_overlap:]
            current_chunk = f"{overlap_prefix}\n{para}".strip() if overlap_prefix else para

    if current_chunk:
        raw_chunks.append(current_chunk)

    return raw_chunks


def build_temporal_header(patient_uid: str, clinical_date_str: Optional[str], year: Optional[int] = None) -> str:
    """
    Construct temporal context header.
    Strictly distinguishes known clinical date from unknown.
    Never fabricates date from upload date.
    """
    if clinical_date_str and year is not None:
        return f"[{patient_uid} | Date: {clinical_date_str} | Year: {year}]"
    elif clinical_date_str:
        return f"[{patient_uid} | Date: {clinical_date_str}]"
    elif year is not None:
        return f"[{patient_uid} | Year: {year}]"
    else:
        return f"[{patient_uid} | Date: Unknown]"


def chunk_document_page(
    doc_meta: Dict[str, Any],
    page: Dict[str, Any],
    chunk_size: int = 800,
    chunk_overlap: int = 120,
) -> List[ClinicalChunk]:
    """
    Chunk an approved DocumentPage into ClinicalChunks with exact page attribution.
    """
    patient_uid = doc_meta["patientUid"]
    document_id = doc_meta["documentId"]
    doc_version = int(doc_meta.get("derivativeVersion", 1))
    approval_version = int(doc_meta.get("approvalVersion", doc_version))
    doc_type = doc_meta.get("documentType", "clinical_record")

    # Explicit date separation
    clinical_date_raw = doc_meta.get("clinicalDate")
    clinical_date_str = _format_date_string(clinical_date_raw)
    year = _extract_year_from_iso_date(clinical_date_raw)
    upload_date_str = _format_date_string(doc_meta.get("uploadDate"))

    page_number = int(page.get("pageNumber", 1))
    raw_text = page.get("extractedText", "")
    provenance = page.get("ocrStatus") == "ocr_processed" and "OCR_EXTRACTED" or doc_meta.get("provenance", "DOCUMENT_EXTRACTED")

    header_tag = build_temporal_header(patient_uid, clinical_date_str, year)
    text_segments = split_into_paragraphs(raw_text, chunk_size, chunk_overlap)

    chunks: List[ClinicalChunk] = []
    for idx, seg in enumerate(text_segments):
        chunk_id = f"{document_id}::v{doc_version}::p{page_number}::chunk_{idx}"
        annotated_text = f"{header_tag}\n{seg}".strip()

        chunks.append(
            ClinicalChunk(
                chunk_id=chunk_id,
                patient_uid=patient_uid,
                document_id=document_id,
                page_number=page_number,
                document_version=doc_version,
                approval_version=approval_version,
                source_text=annotated_text,
                provenance=provenance,
                clinical_date=clinical_date_str,
                upload_date=upload_date_str,
                year=year,
                chunk_index=idx,
                document_type=doc_type,
                is_clinical_fact=False,
            )
        )

    return chunks


def chunk_clinical_fact(
    doc_meta: Dict[str, Any],
    fact: Dict[str, Any],
    fact_index: int = 0,
) -> ClinicalChunk:
    """
    Represent a verified DocumentClinicalFact as a vectorizable chunk.
    Preserves exact provenance, source page attribution, and clinical key/value.
    """
    patient_uid = doc_meta["patientUid"]
    document_id = doc_meta["documentId"]
    doc_version = int(doc_meta.get("derivativeVersion", 1))
    approval_version = int(doc_meta.get("approvalVersion", doc_version))
    doc_type = doc_meta.get("documentType", "clinical_record")

    # Use fact's clinical date if present; fallback to document's clinical date
    fact_date_raw = fact.get("clinicalDate") or doc_meta.get("clinicalDate")
    clinical_date_str = _format_date_string(fact_date_raw)
    year = _extract_year_from_iso_date(fact_date_raw)
    upload_date_str = _format_date_string(doc_meta.get("uploadDate"))

    page_number = int(fact.get("pageNumber", 1))
    fact_id = fact.get("id", fact_index)
    fact_type = str(fact.get("factType", "symptom")).lower()
    fact_key = str(fact.get("factKey", ""))
    fact_value = str(fact.get("factValue", ""))
    unit = fact.get("unit")
    provenance = fact.get("provenance", doc_meta.get("provenance", "DOCUMENT_EXTRACTED"))

    chunk_id = f"{document_id}::v{doc_version}::p{page_number}::fact_{fact_id}"
    header_tag = build_temporal_header(patient_uid, clinical_date_str, year)

    unit_str = f" {unit}" if unit else ""
    fact_content = f"[CLINICAL FACT] {fact_type.upper()}: {fact_key} = {fact_value}{unit_str} (Source: Page {page_number}, Provenance: {provenance})"
    annotated_text = f"{header_tag}\n{fact_content}".strip()

    return ClinicalChunk(
        chunk_id=chunk_id,
        patient_uid=patient_uid,
        document_id=document_id,
        page_number=page_number,
        document_version=doc_version,
        approval_version=approval_version,
        source_text=annotated_text,
        provenance=provenance,
        clinical_date=clinical_date_str,
        upload_date=upload_date_str,
        year=year,
        chunk_index=fact_index,
        document_type=doc_type,
        is_clinical_fact=True,
        fact_type=fact_type,
        fact_key=fact_key,
        fact_value=fact_value,
        unit=unit,
    )


def chunk_document_bundle(
    doc_meta: Dict[str, Any],
    pages: List[Dict[str, Any]],
    facts: List[Dict[str, Any]],
    approval: Dict[str, Any],
    chunk_size: int = 800,
    chunk_overlap: int = 120,
) -> List[ClinicalChunk]:
    """
    Chunk an entire approved document snapshot (pages + clinical facts).
    Enforces snapshot consistency: all pages and facts must match doc_version.
    """
    doc_version = int(doc_meta.get("derivativeVersion", 1))
    approved_version = int(approval.get("approvedVersion", 1))
    action = approval.get("action", "")

    if doc_version != approved_version or action != "APPROVED":
        raise ValueError(
            f"Snapshot mismatch: document version {doc_version} does not match approval version {approved_version} (action: {action})"
        )

    # Attach approvalVersion to metadata bundle
    enriched_meta = dict(doc_meta)
    enriched_meta["approvalVersion"] = approved_version

    all_chunks: List[ClinicalChunk] = []

    # 1. Chunk pages of the current version
    matching_pages = [p for p in pages if int(p.get("version", 1)) == doc_version]
    for page in sorted(matching_pages, key=lambda p: int(p.get("pageNumber", 1))):
        page_chunks = chunk_document_page(enriched_meta, page, chunk_size, chunk_overlap)
        all_chunks.extend(page_chunks)

    # 2. Chunk facts of the current version
    matching_facts = [f for f in facts if int(f.get("version", 1)) == doc_version]
    for idx, fact in enumerate(matching_facts):
        fact_chunk = chunk_clinical_fact(enriched_meta, fact, fact_index=idx)
        all_chunks.append(fact_chunk)

    logger.info(
        f"Generated {len(all_chunks)} chunks ({len(all_chunks) - len(matching_facts)} page chunks, "
        f"{len(matching_facts)} fact chunks) for document {doc_meta.get('documentId')} v{doc_version}"
    )
    return all_chunks
