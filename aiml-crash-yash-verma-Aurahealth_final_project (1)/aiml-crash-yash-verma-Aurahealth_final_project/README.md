# AuraHealth Nexus — Longitudinal Medical History RAG

A specialized Retrieval-Augmented Generation (RAG) system built for **single-patient longitudinal medical history QA** over a 15-year synthetic dataset (`SYN-PAT-001`, covering annual medical records from 2010 through 2024).

> **Important Safety Note**: The patient data is completely synthetic and fictional (`SYN-PAT-001`, Arjun Mehta). It is strictly created for AI/RAG research and development testing and must not be used for actual clinical decision-making.

---

## Key Features

- **Longitudinal Temporal Retrieval**: Understands multi-year progression, lab trajectories, and medication additions over time.
- **Chronological Evidence Ordering**: Context chunks are dynamically identified, retrieved across timeline years, and passed to the generator in ascending chronological order (2010 → 2024).
- **Patient-Aware Metadata Propagation**: Every document and chunk retains structured metadata:
  ```json
  {
    "patient_id": "SYN-PAT-001",
    "year": 2019,
    "source": "2019_SYN-PAT-001.txt",
    "document_type": "yearly_medical_history",
    "data_type": "synthetic"
  }
  ```
- **Isolated Patient Vector Store**: Embeddings are cleanly separated into `vector_index/SYN-PAT-001/` to prevent contamination with legacy indices.
- **Strict Clinical Grounding & Citations**: The LLM adheres to strict grounding rules, citing the exact document years (e.g., `(2019 record)`) and explicitly stating when findings are undocumented.
- **Interactive Dark-Themed UI**: Built with Streamlit, displaying patient metrics, timeline span, confidence scores, strategy badges, and expandable source evidence inspection.

---

## Architecture Flow

```
SYN-PAT-001_15yr_RAG_medical_history/ (2010_SYN-PAT-001.txt ... 2024_SYN-PAT-001.txt)
                     │
                     ▼  loader.py (Automatic Year & Patient ID Extraction)
Document(source, text, metadata={patient_id, year, document_type, data_type})
                     │
                     ▼  chunker.py (Clinical Section-Aware Chunking)
Chunk(id, text, patient_id, year, source, document_type, metadata)
                     │
                     ▼  vectorstore.py (SentenceTransformer: all-MiniLM-L6-v2)
FAISS IndexFlatIP (Saved in vector_index/SYN-PAT-001/)
                     │
                     ▼  rag_pipeline.py (Longitudinal Query Analysis & Chronological Retrieval)
Temporal Routing (Timeline Summary / Longitudinal Trend / Specific Year / Current State)
Chronologically Ordered Context (2010 ───────> 2024)
                     │
                     ▼  generator.py (Patient-Aware LLM Grounding & Year Citations)
Groq Llama-3.1 API (or configurable LLM)
                     │
                     ▼
Streamlit Web UI (app.py) & Evaluation Benchmark (evaluate.py)
```

---

## System-to-System Transfer Guide

Follow these instructions whenever you want to transfer this project to another computer, laptop, USB drive, or GitHub repository.

### 1. What You Can Safely Delete Before Transfer

To keep the transfer lightweight, clean, and error-free:

| Item | Status | Reason |
| :--- | :--- | :--- |
| `synthetic_data/` | **DELETE** | Legacy corporate handbook dataset; no longer used by the application. |
| `.venv/` or `venv/` | **DELETE** | Virtual environment contains machine-specific paths and binaries. Never transfer `.venv`. Always recreate it on the target system. |
| `__pycache__/` | **DELETE** | Temporary compiled Python bytecode files. |
| `.env` | **DO NOT SHARE PUBLICLY** | Contains private API keys. Create a fresh `.env` on the new system. |
| `vector_index/` | **OPTIONAL TO DELETE** | Can be rebuilt in 5 seconds on the new machine with one command. |

---

### 2. What Files To Keep & Transfer

Ensure the following project core files are transferred:
```
aiml-crash-yash-verma-Aurahealth_final_project/
├── SYN-PAT-001_15yr_RAG_medical_history/    # 15 yearly patient TXT files + README
│   ├── 2010_SYN-PAT-001.txt
│   ├── ...
│   └── 2024_SYN-PAT-001.txt
├── app.py                                   # Streamlit Web Application
├── loader.py                                # Patient document loader & metadata parser
├── chunker.py                               # Clinical chunking logic
├── vectorstore.py                           # FAISS vector store
├── rag_pipeline.py                          # Longitudinal RAG pipeline
├── generator.py                             # Groq LLM integration & grounding
├── evaluate.py                              # Evaluation benchmark script
├── requirements.txt                         # Dependencies list
└── README.md                                # Project documentation
```

---

### 3. Step-by-Step Setup on the New System

#### Step A: Open Terminal in Project Folder
Open PowerShell (Windows) or Terminal (macOS/Linux) and navigate to the project directory:
```bash
cd path/to/aiml-crash-yash-verma-Aurahealth_final_project
```

#### Step B: Create a Fresh Virtual Environment
Recommended Python: **Python 3.10** or **Python 3.11** (64-bit).

- **Windows**:
  ```bash
  python -m venv .venv
  .\.venv\Scripts\activate
  ```
- **macOS / Linux**:
  ```bash
  python3 -m venv .venv
  source .venv/bin/activate
  ```

#### Step C: Install Dependencies
```bash
pip install --upgrade pip
pip install -r requirements.txt
```

#### Step D: Create `.env` Configuration File
Create a file named `.env` in the root folder with your Groq API key:
```env
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-20b
GROQ_API_BASE_URL=https://api.groq.com/openai/v1
```

#### Step E: Build the Patient Vector Index
Run this command to build the clean FAISS vector database from `SYN-PAT-001_15yr_RAG_medical_history/`:
```bash
python -c "from rag_pipeline import RAGPipeline; p = RAGPipeline(); p.index(force_rebuild=True)"
```

#### Step F: Run the Application
Start the Streamlit web dashboard:
```bash
streamlit run app.py
```
Open your browser at `http://localhost:8501`.

#### Step G: (Optional) Run Evaluation Benchmark
```bash
python evaluate.py
```

---

## Example Longitudinal Queries

1. **Longitudinal Lab Trajectory**:
   > *"How did the patient's kidney function (eGFR) change from baseline in 2010 to 2024?"*
2. **Medication Addition & History**:
   > *"When was Losartan added and what medications were documented in 2024?"*
3. **Disease Progression**:
   > *"When was type 2 diabetes first documented and what was the progression from prediabetes?"*
4. **Metabolic Changes**:
   > *"What were the major metabolic changes between 2010 and 2024?"*
5. **Full Chronological Timeline**:
   > *"Give a chronological summary of the patient's major medical events from 2010 to 2024."*

---

## Multi-Patient Extensibility

The pipeline is designed with multi-patient extensibility:
- Metadata attaches `patient_id` to every document and chunk.
- Vector indices are scoped by directory (`vector_index/<PATIENT_ID>/`).
- `VectorStore.search` and `RAGPipeline` accept `patient_id` parameter to filter retrieval across multiple synthetic patients.
