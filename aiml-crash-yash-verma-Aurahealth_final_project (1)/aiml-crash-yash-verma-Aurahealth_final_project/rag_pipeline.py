import logging
import os
import re
import sys
import time
from typing import List, Optional, Dict, Any, Tuple, Set

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

from loader import load_documents, Document
from chunker import chunk_documents, Chunk
from vectorstore import VectorStore
from generator import Generator

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

DEFAULT_DATA_DIR = os.path.join(os.path.dirname(__file__), "SYN-PAT-001_15yr_RAG_medical_history")
DEFAULT_INDEX_DIR = os.path.join(os.path.dirname(__file__), "vector_index", "SYN-PAT-001")
DEFAULT_PATIENT_ID = "SYN-PAT-001"


class RAGPipeline:
    def __init__(
        self,
        top_k: int = 6,
        history_limit: int = 6,
        model: Optional[str] = None,
        patient_id: str = DEFAULT_PATIENT_ID,
        data_dir: str = DEFAULT_DATA_DIR,
        index_dir: str = DEFAULT_INDEX_DIR,
    ):
        self.top_k = top_k
        self.history_limit = history_limit
        self.patient_id = patient_id
        self.data_dir = data_dir
        self.index_dir = index_dir
        self.store = VectorStore()
        self.generator = Generator(model=model) if model else Generator()
        self.history: List[dict] = []

    def index(
        self,
        data_dir: Optional[str] = None,
        force_rebuild: bool = False,
        save_path: Optional[str] = None,
    ):
        """Build or load an isolated FAISS vector index for the patient dataset."""
        data_dir = data_dir or self.data_dir
        save_path = save_path or self.index_dir

        loaded = False
        if not force_rebuild and os.path.isdir(save_path) and os.listdir(save_path):
            logger.info(f"Attempting to load existing vector index from '{save_path}'...")
            loaded = self.store.load(save_path)

        if not loaded:
            logger.info(f"Building clean vector index from patient records in '{data_dir}'...")
            docs = load_documents(data_dir, default_patient_id=self.patient_id)
            chunks = chunk_documents(docs)
            self.store.build(chunks)
            self.store.save(save_path)
            logger.info(f"Successfully indexed {len(chunks)} chunks and saved to '{save_path}'.")

    def add_documents(self, docs: List[Document], save_path: Optional[str] = None) -> int:
        """Incrementally chunk and index new Document objects for this patient."""
        if not docs:
            return 0
        save_path = save_path or self.index_dir
        chunks = chunk_documents(docs)
        self.store.add_chunks(chunks)
        self.store.save(save_path)
        logger.info(f"Dynamically added {len(chunks)} chunks to vector store.")
        return len(chunks)

    def reset_history(self):
        """Clear conversation history."""
        self.history = []
        logger.info("Chat history cleared.")

    def get_stats(self) -> Dict[str, Any]:
        """Return system stats for UI dashboard and sidebar."""
        if self.store.index is None:
            self.index()

        years: Set[int] = set()
        unique_docs: Set[str] = set()
        if self.store.chunks:
            for c in self.store.chunks:
                unique_docs.add(c.source)
                if c.year is not None:
                    years.add(c.year)

        years_span = f"{min(years)} – {max(years)}" if years else "None"

        return {
            "patient_id": self.patient_id,
            "years_span": years_span,
            "indexed_documents": len(unique_docs),
            "total_chunks": len(self.store.chunks) if self.store.chunks else 0,
            "embedding_model": "all-MiniLM-L6-v2 (384-dim)",
            "vector_store": f"FAISS IndexFlatIP ({self.patient_id})",
            "llm_model": self.generator.model,
        }

    def _analyze_query(self, query: str) -> Dict[str, Any]:
        """
        Analyze query for temporal intent, specific years, trend patterns, or full timeline summaries.
        """
        lower_q = query.lower()
        extracted_years = [int(y) for y in re.findall(r"\b(20\d\d)\b", query)]

        # 1. Check for Timeline / Chronological Summary request
        timeline_keywords = [
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
        is_timeline = any(kw in lower_q for kw in timeline_keywords)

        # 2. Check for Longitudinal Trend / Multi-Year Reasoning request
        trend_keywords = [
            "trend",
            "change",
            "progression",
            "over time",
            "over the years",
            "added over time",
            "highest",
            "lowest",
            "first documented",
            "first treated",
            "when was",
            "when did",
            "started",
            "initiate",
            "evolution",
            "from 20",
            "to 20",
            "between 20",
        ]
        is_trend = is_timeline or any(kw in lower_q for kw in trend_keywords) or len(extracted_years) > 1

        # 3. Check for specific single year target
        is_single_year = len(extracted_years) == 1 and not is_trend

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
        }

    def _retrieve_longitudinal_chunks(
        self, query: str, analysis: Dict[str, Any]
    ) -> List[Tuple[Chunk, float]]:
        """
        Execute temporal-aware retrieval ensuring multi-year representation and chronological sorting.
        """
        strategy = analysis["strategy"]
        years = analysis["years"]

        retrieved: List[Tuple[Chunk, float]] = []
        seen_chunk_ids: Set[str] = set()

        if strategy == "TIMELINE_SUMMARY":
            # Retrieve broad timeline: take top semantic matches with high top_k
            # and ensure summary sections from records are captured
            initial = self.store.search(query, top_k=max(self.top_k * 3, 15), patient_id=self.patient_id)
            for c, score in initial:
                if c.id not in seen_chunk_ids:
                    seen_chunk_ids.add(c.id)
                    retrieved.append((c, score))

            # Also ensure longitudinal summary / clinical summary chunks across available years are included
            summary_query = "Annual clinical summary longitudinal assessment medical events diagnosis medication"
            summary_matches = self.store.search(summary_query, top_k=15, patient_id=self.patient_id)
            for c, score in summary_matches:
                if c.id not in seen_chunk_ids:
                    seen_chunk_ids.add(c.id)
                    retrieved.append((c, score * 0.95))

        elif strategy == "SPECIFIC_YEAR" and years:
            target_year = years[0]
            # Primary search within specific year
            year_matches = self.store.search(
                query, top_k=self.top_k, patient_id=self.patient_id, year=target_year
            )
            for c, score in year_matches:
                if c.id not in seen_chunk_ids:
                    seen_chunk_ids.add(c.id)
                    retrieved.append((c, score))

            # Supplement with general search for context if needed
            general_matches = self.store.search(query, top_k=self.top_k, patient_id=self.patient_id)
            for c, score in general_matches:
                if c.id not in seen_chunk_ids and len(retrieved) < self.top_k + 2:
                    seen_chunk_ids.add(c.id)
                    retrieved.append((c, score))

        elif strategy == "LONGITUDINAL_TREND":
            # For longitudinal queries, retrieve a larger pool (top 10-12 chunks) across multiple years
            fetch_k = max(self.top_k * 2, 10)
            initial = self.store.search(query, top_k=fetch_k, patient_id=self.patient_id)
            for c, score in initial:
                if c.id not in seen_chunk_ids:
                    seen_chunk_ids.add(c.id)
                    retrieved.append((c, score))

            # If specific years were mentioned (e.g. 2015, 2019, 2024), ensure chunks from those years are retrieved
            for yr in years:
                yr_matches = self.store.search(query, top_k=2, patient_id=self.patient_id, year=yr)
                for c, score in yr_matches:
                    if c.id not in seen_chunk_ids:
                        seen_chunk_ids.add(c.id)
                        retrieved.append((c, score))

        else:
            # Standard semantic search
            initial = self.store.search(query, top_k=self.top_k, patient_id=self.patient_id)
            for c, score in initial:
                if c.id not in seen_chunk_ids:
                    seen_chunk_ids.add(c.id)
                    retrieved.append((c, score))

        # Sort chronologically by year (ascending)
        def sort_key(item: Tuple[Chunk, float]) -> int:
            chunk, _ = item
            return chunk.year if (chunk.year is not None) else 9999

        retrieved.sort(key=sort_key)
        return retrieved

    def ask(self, query: str, use_history: bool = True) -> str:
        """Execute RAG query and return answer string."""
        res = self.ask_with_metadata(query, use_history=use_history)
        return res["answer"]

    def ask_with_metadata(self, query: str, use_history: bool = True) -> Dict[str, Any]:
        """
        Execute longitudinal RAG query and return structured response with time taken,
        sources, years covered, retrieval confidence, and chronological evidence.
        """
        if self.store.index is None:
            logger.info("Vector store not loaded. Auto-initializing index before query...")
            self.index()

        start_time = time.time()
        history = self.history if use_history else None

        # Contextualize query if history exists
        search_query = self.generator.contextualize_query(query, history)

        # Analyze query for temporal intent
        analysis = self._analyze_query(search_query)

        # Perform longitudinal chronological retrieval
        retrieved = self._retrieve_longitudinal_chunks(search_query, analysis)

        # Generate response using generator
        gen_result = self.generator.generate_with_metadata(query, retrieved, history=history)
        answer = gen_result.get("text", "")
        usage = gen_result.get("usage") or {}

        elapsed_time = time.time() - start_time

        if use_history:
            self.history.append({"role": "user", "content": query})
            self.history.append({"role": "assistant", "content": answer})
            if len(self.history) > self.history_limit:
                self.history = self.history[-self.history_limit:]

        # Calculate retrieval confidence based on top similarity score
        top_score = max((score for _, score in retrieved), default=0.0) if retrieved else 0.0
        if top_score >= 0.50:
            confidence = "High"
        elif top_score >= 0.30:
            confidence = "Medium"
        else:
            confidence = "Low"

        unique_sources = list(dict.fromkeys(c.source for c, _ in retrieved))
        unique_years = sorted(list(set(c.year for c, _ in retrieved if c.year is not None)))

        return {
            "answer": answer,
            "retrieved": retrieved,
            "time_taken": elapsed_time,
            "search_query": search_query,
            "strategy": analysis.get("strategy", "STANDARD_SEMANTIC"),
            "confidence": confidence,
            "top_score": top_score,
            "sources": unique_sources,
            "years": unique_years,
            "patient_id": self.patient_id,
            "usage": usage,
            "total_tokens": usage.get("total_tokens", 0) if usage else None,
        }


if __name__ == "__main__":
    pipeline = RAGPipeline()
    pipeline.index()

    print("AuraHealth Nexus Longitudinal Medical RAG Assistant Ready.")
    print("Patient: SYN-PAT-001 | Years: 2010–2024\nType 'exit' to quit.\n")

    test_queries = [
        "When was type 2 diabetes first documented?",
        "How did kidney function (eGFR) change from 2010 to 2024?",
        "What medications was the patient taking in 2024?",
    ]

    for q in test_queries:
        print(f"Query: {q}")
        res = pipeline.ask_with_metadata(q, use_history=False)
        print(f"Strategy: {res['strategy']} | Years covered: {res['years']}")
        print(f"Top Sources: {res['sources']}")
        print(f"Answer:\n{res['answer']}\n{'-'*60}\n")
