"""
Production Dual-Path Retrieval Router
services/rag_service/retriever.py

Implements the two-path longitudinal retrieval architecture:

  Path A — Semantic Dense Retrieval (MiniLM FAISS cosine similarity)
  Path B — Temporal-Trend Retrieval (chronological aggregation of clinical facts)

Mirrors the query-analysis + retrieval logic of the AuraHealth reference
(rag_pipeline.py) while supporting multi-tenant ClinicalChunk objects and
an optional SQLite database path for Path B fact lookups.
"""

import logging
import re
import sqlite3
from typing import Any, Dict, List, Optional, Set, Tuple

from services.rag_service.chunker import ClinicalChunk
from services.rag_service.vectorstore import PatientVectorStore

logger = logging.getLogger(__name__)

# ─── Query Analysis ───────────────────────────────────────────────────────────

TIMELINE_KEYWORDS = [
    "chronological summary",
    "timeline",
    "complete history",
    "entire history",
    "all years",
    "major medical events",
    "full history",
    "overview of history",
    "trajectory",
]

TREND_KEYWORDS = [
    "trend",
    "change",
    "progression",
    "over time",
    "over the years",
    "highest",
    "lowest",
    "first documented",
    "first treated",
    "first diagnosed",
    "first",
    "earliest",
    "initial",
    "when was",
    "when did",
    "last",
    "most recent",
    "latest",
    "started",
    "initiated",
    "evolution",
    "increased",
    "decreased",
    "dropped",
    "rose",
    "fell",
    "before",
    "after",
    "since",
    "between",
    "from 20",
    "to 20",
    "between 20",
    "ever crossed",
    "threshold",
    "nadir",
    "peak",
    "added over time",
    "below",
    "above",
    "greater than",
    "less than",
    ">=",
    "<=",
    ">",
    "<",
]


def analyze_query(query: str, requested_year: Optional[int] = None) -> Dict[str, Any]:
    """
    Classify query intent for retrieval routing.

    Returns:
        {
          "strategy": "TIMELINE_SUMMARY" | "LONGITUDINAL_TREND"
                      | "SPECIFIC_YEAR" | "STANDARD_SEMANTIC",
          "years": List[int],
          "is_timeline": bool,
          "is_trend": bool,
          "is_temporal": bool,   # True for LONGITUDINAL_TREND, SPECIFIC_YEAR, or TIMELINE_SUMMARY
        }
    """
    lower_q = query.lower()
    extracted_years = [int(y) for y in re.findall(r"\b(20\d\d|19\d\d)\b", query)]
    if requested_year and requested_year not in extracted_years:
        extracted_years.append(requested_year)

    is_timeline = any(kw in lower_q for kw in TIMELINE_KEYWORDS)
    is_trend = (
        is_timeline
        or any(kw in lower_q for kw in TREND_KEYWORDS)
        or len(extracted_years) > 1
    )
    is_single_year = (len(extracted_years) == 1 and not is_trend) or (requested_year is not None and not is_trend)

    if is_timeline:
        strategy = "TIMELINE_SUMMARY"
    elif is_single_year:
        strategy = "SPECIFIC_YEAR"
    elif is_trend:
        strategy = "LONGITUDINAL_TREND"
    else:
        strategy = "STANDARD_SEMANTIC"

    return {
        "strategy": strategy,
        "years": extracted_years,
        "is_timeline": is_timeline,
        "is_trend": is_trend,
        "is_temporal": strategy in ("LONGITUDINAL_TREND", "SPECIFIC_YEAR", "TIMELINE_SUMMARY"),
    }


# ─── Path A: Semantic Dense Retrieval ─────────────────────────────────────────

def retrieve_semantic(
    store: PatientVectorStore,
    patient_uid: str,
    query: str,
    analysis: Dict[str, Any],
    top_k: int = 6,
) -> List[Tuple[ClinicalChunk, float]]:
    """
    Path A: FAISS dense retrieval adapted from AuraHealth RAGPipeline._retrieve_longitudinal_chunks.
    Returns deduplicated, chronologically sorted list of (ClinicalChunk, score).
    """
    strategy = analysis["strategy"]
    years = analysis["years"]
    seen_ids: Set[str] = set()
    retrieved: List[Tuple[ClinicalChunk, float]] = []

    def _add(results: List[Dict[str, Any]], score_multiplier: float = 1.0):
        for r in results:
            c_dict = r.get("chunk") if isinstance(r.get("chunk"), dict) else r
            chunk_id = c_dict.get("chunk_id", "")
            if not chunk_id or chunk_id in seen_ids:
                continue
            seen_ids.add(chunk_id)

            if isinstance(r.get("chunk"), dict):
                chunk = ClinicalChunk.from_dict(r["chunk"])
            else:
                chunk = ClinicalChunk(
                    chunk_id=chunk_id,
                    patient_uid=c_dict.get("patient_uid") or c_dict.get("patient_id", patient_uid),
                    document_id=c_dict.get("document_id", ""),
                    page_number=int(c_dict.get("page_number", 0)),
                    document_version=int(c_dict.get("document_version", 1)),
                    approval_version=int(c_dict.get("approval_version", 1)),
                    source_text=c_dict.get("source_text", ""),
                    provenance=c_dict.get("provenance", "DOCUMENT_EXTRACTED"),
                    clinical_date=c_dict.get("clinical_date"),
                    upload_date=c_dict.get("upload_date"),
                    year=c_dict.get("year"),
                    chunk_index=int(c_dict.get("chunk_index", 0)),
                    document_type=c_dict.get("document_type"),
                    is_clinical_fact=bool(c_dict.get("is_clinical_fact", False)),
                    fact_type=c_dict.get("fact_type"),
                    fact_key=c_dict.get("fact_key"),
                    fact_value=c_dict.get("fact_value"),
                    unit=c_dict.get("unit"),
                )
            score = float(r.get("score", 0.0)) * score_multiplier
            retrieved.append((chunk, score))

    try:
        if strategy == "TIMELINE_SUMMARY":
            results = store.search(patient_uid, query, top_k=max(top_k * 3, 15))
            _add(results)
            # Also retrieve broad summary chunks
            summary_q = (
                "Annual clinical summary longitudinal assessment medical events "
                "diagnosis medication"
            )
            sum_results = store.search(patient_uid, summary_q, top_k=15)
            _add(sum_results, score_multiplier=0.95)

        elif strategy == "SPECIFIC_YEAR" and years:
            yr_results = store.search(patient_uid, query, top_k=top_k, year=years[0])
            _add(yr_results)
            gen_results = store.search(patient_uid, query, top_k=top_k)
            for r in gen_results:
                if len(retrieved) >= top_k + 2:
                    break
                _add([r])

        elif strategy == "LONGITUDINAL_TREND":
            fetch_k = max(top_k * 2, 10)
            results = store.search(patient_uid, query, top_k=fetch_k)
            _add(results)
            for yr in years:
                yr_results = store.search(patient_uid, query, top_k=2, year=yr)
                _add(yr_results)

        else:  # STANDARD_SEMANTIC
            results = store.search(patient_uid, query, top_k=top_k)
            _add(results)

    except Exception as exc:
        logger.warning(f"Path A semantic retrieval error for patient (truncated UID): {exc}")

    # Chronological sort (ascending year)
    retrieved.sort(key=lambda item: (item[0].year if item[0].year is not None else 9999))
    return retrieved


# ─── Path B: Temporal / Structured Fact Retrieval ────────────────────────────

from services.rag_service.database import get_database_client


def retrieve_temporal_facts(
    patient_uid: str,
    query: str,
    analysis: Dict[str, Any],
    db_path: Optional[str] = None,
) -> List[Tuple[ClinicalChunk, float]]:
    """
    Path B: Query DocumentClinicalFact table for structured temporal facts.
    Returns pseudo-chunks constructed from fact rows (score = confidence).
    Only executed when strategy is LONGITUDINAL_TREND or SPECIFIC_YEAR.
    Supports SQLite and PostgreSQL via the DatabaseClient abstraction.
    """
    if not analysis["is_temporal"]:
        return []

    client = get_database_client(url_override=db_path)
    if not client.is_available():
        logger.debug("Path B skipped: database backend unavailable.")
        return []

    try:
        # Extract candidate fact keywords from query (basic keyword match)
        lower_q = query.lower()
        rows = client.fetch_temporal_facts(patient_uid)
    except Exception as exc:
        logger.warning(f"Path B DB query failed: {exc}")
        return []

    retrieved: List[Tuple[ClinicalChunk, float]] = []

    for row in rows:
        fact_key = (row["factKey"] or "").lower()
        fact_type = (row["factType"] or "").lower()
        fact_value = row["factValue"] or ""
        unit = row["unit"] or ""

        # Simple relevance gate: check if any token from factKey or factType
        # appears in the query, or the query mentions the fact type category
        relevant = (
            fact_key in lower_q
            or fact_type in lower_q
            or any(tok in lower_q for tok in fact_key.split())
        )
        if not relevant:
            continue

        clinical_date_str = row["clinicalDate"] or row["docClinicalDate"]
        year: Optional[int] = None
        if clinical_date_str:
            try:
                year = int(str(clinical_date_str)[:4])
            except (ValueError, TypeError):
                pass

        # If SPECIFIC_YEAR, further filter to requested year
        if analysis["strategy"] == "SPECIFIC_YEAR" and analysis["years"]:
            if year not in analysis["years"]:
                continue

        source_text = (
            f"{row['factKey']}: {fact_value}"
            + (f" {unit}" if unit else "")
            + (f" [{row['factType']}]" if row["factType"] else "")
        )
        chunk = ClinicalChunk(
            chunk_id=f"fact_{row['id']}",
            patient_uid=patient_uid,
            document_id=row["documentId"],
            page_number=int(row["pageNumber"] or 0),
            document_version=int(row["derivativeVersion"] or 1),
            approval_version=int(row["derivativeVersion"] or 1),
            source_text=source_text,
            provenance=row["provenance"] or "DOCUMENT_EXTRACTED",
            clinical_date=clinical_date_str,
            year=year,
            is_clinical_fact=True,
            fact_type=row["factType"],
            fact_key=row["factKey"],
            fact_value=fact_value,
            unit=unit,
        )
        score = float(row["confidence"] or 1.0)
        retrieved.append((chunk, score))

    # Chronological sort
    retrieved.sort(key=lambda item: (item[0].year if item[0].year is not None else 9999))
    return retrieved


# ─── Dual-Path Router ─────────────────────────────────────────────────────────

def dual_path_retrieve(
    store: PatientVectorStore,
    patient_uid: str,
    query: str,
    top_k: int = 6,
    db_path: Optional[str] = None,
    retrieval_path: str = "auto",
    year: Optional[int] = None,
) -> Tuple[List[Tuple[ClinicalChunk, float]], str, str]:
    """
    Execute dual-path retrieval and merge results.

    Returns:
        (merged_results, strategy, retrieval_path)

    retrieval_path values:
        "SEMANTIC_ONLY"              — Path A only
        "TEMPORAL_TREND_AND_SEMANTIC"— Both paths merged
        "TEMPORAL_TREND_ONLY"        — Path B only
        "NO_HISTORY"                 — Empty index
    """
    analysis = analyze_query(query, requested_year=year)
    strategy = analysis["strategy"]

    path_mode = (retrieval_path or "auto").lower()

    path_a_results: List[Tuple[ClinicalChunk, float]] = []
    path_b_results: List[Tuple[ClinicalChunk, float]] = []

    if path_mode == "semantic":
        # Force semantic path only
        path_a_results = retrieve_semantic(store, patient_uid, query, analysis, top_k)
    elif path_mode == "temporal":
        # Force temporal path if DB available, fallback to semantic if no facts found
        path_b_results = retrieve_temporal_facts(patient_uid, query, analysis, db_path)
        if not path_b_results:
            path_a_results = retrieve_semantic(store, patient_uid, query, analysis, top_k)
    else:  # "auto"
        # Path A: Semantic dense retrieval
        path_a_results = retrieve_semantic(store, patient_uid, query, analysis, top_k)

        # Path B: Temporal structured facts (for temporal strategies)
        # DatabaseClient manages SQLite/PostgreSQL connections based on environment or override
        if analysis["is_temporal"]:
            path_b_results = retrieve_temporal_facts(patient_uid, query, analysis, db_path)

    # Merge, deduplicating by chunk_id
    seen_ids: Set[str] = set()
    merged: List[Tuple[ClinicalChunk, float]] = []

    for chunk, score in path_a_results:
        if chunk.chunk_id not in seen_ids:
            seen_ids.add(chunk.chunk_id)
            merged.append((chunk, score))

    for chunk, score in path_b_results:
        if chunk.chunk_id not in seen_ids:
            seen_ids.add(chunk.chunk_id)
            merged.append((chunk, score))

    # Re-sort merged results chronologically
    merged.sort(key=lambda item: (item[0].year if item[0].year is not None else 9999))

    if not merged:
        resolved_path = "NO_HISTORY"
    elif path_b_results and path_a_results:
        resolved_path = "TEMPORAL_TREND_AND_SEMANTIC"
    elif path_b_results:
        resolved_path = "TEMPORAL_TREND_ONLY"
    else:
        resolved_path = "SEMANTIC_ONLY"

    return merged, strategy, resolved_path
