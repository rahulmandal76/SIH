"""
Production RAG Service Package
services/rag_service/__init__.py
"""

from services.rag_service.chunker import (
    ClinicalChunk,
    chunk_document_bundle,
    chunk_document_page,
    chunk_clinical_fact,
    build_temporal_header,
)
from services.rag_service.vectorstore import (
    PatientVectorStore,
    validate_patient_uid,
    normalize_vectors,
)
from services.rag_service.generator import (
    ClinicalGenerator,
    extract_citations,
    format_clinical_context,
)
from services.rag_service.retriever import (
    analyze_query,
    dual_path_retrieve,
    retrieve_semantic,
    retrieve_temporal_facts,
)

__all__ = [
    # Chunker
    "ClinicalChunk",
    "chunk_document_bundle",
    "chunk_document_page",
    "chunk_clinical_fact",
    "build_temporal_header",
    # Vectorstore
    "PatientVectorStore",
    "validate_patient_uid",
    "normalize_vectors",
    # Generator (Phase 5E)
    "ClinicalGenerator",
    "extract_citations",
    "format_clinical_context",
    # Retriever (Phase 5E)
    "analyze_query",
    "dual_path_retrieve",
    "retrieve_semantic",
    "retrieve_temporal_facts",
]
