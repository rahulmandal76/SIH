# AuraHealth Longitudinal RAG Pipeline Specification

## 1. Longitudinal Temporal Retrieval Engine

The RAG pipeline preserves chronological coherence across multi-year patient records using a 4-mode query routing strategy:

| Retrieval Strategy | Query Triggers | Target Retrieval Mechanism |
| :--- | :--- | :--- |
| **`TIMELINE_SUMMARY`** | "timeline", "chronological summary", "complete history", "overview" | Broad top-k semantic search across all years, prioritized by annual clinical summaries. |
| **`SPECIFIC_YEAR`** | Single 4-digit year extracted (e.g. "in 2018") | Filtered vector retrieval targeted strictly at chunks where `year == target_year`. |
| **`LONGITUDINAL_TREND`**| "trend", "change", "progression", "over time", multiple years | Wide-pool multi-year retrieval ensuring representation across historical milestones. |
| **`STANDARD_SEMANTIC`** | General clinical query (e.g. "diabetic foot care instructions") | Direct inner product dense similarity retrieval across active index. |

---

## 2. Multi-Patient Scope & Process Locking

1. **Storage Partitioning**:
   - FAISS indices and chunk pickles are saved at `vector_index/{patientUid}/`.
   - The RAG engine requires an explicit `patientUid` (UUID) for all indexing, querying, and stats operations.
2. **Concurrency Safeguards**:
   - Ingestion and rebuild operations acquire a process lock: `FileLock("vector_index/{patientUid}/.lock")`.
   - Index and chunks are written atomically using `.tmp` files and renamed (`os.replace`) to prevent read corruption during write cycles.

---

## 3. Truthful Absence Handling (Zero History Patients)

If a patient has no historical documents in `vector_index/{patientUid}/`:
- The system **NEVER** fabricates a historical narrative.
- It grounds responses strictly on the currently available MedSync intake summary and current encounter records.
- It explicitly prefixes answers with:
  > *"No historical records are available in the system for this patient. Based strictly on the current MedSync intake data from today's visit..."*
