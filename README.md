# SIH - Smart India Hackathon Project

This repository hosts the integrated healthcare solution comprising two primary modules:

1. **[Patient Case Taking Software (`Patient-case-taking-software-`)](./Patient-case-taking-software-/)**
   - Interactive MediKiosk Clinical Interviewer and EHR recording system.
   - Built with React, Vite, Node.js / Express backend.

2. **[AuraHealth AI/ML Engine (`aiml-crash-yash-verma-Aurahealth_final_project (1)`)](./aiml-crash-yash-verma-Aurahealth_final_project%20(1)/aiml-crash-yash-verma-Aurahealth_final_project/)**
   - AI-driven medical history retrieval and analysis using RAG (Retrieval-Augmented Generation) & Groq LLM.
   - Built with Python, Streamlit, FAISS vector index, and LangChain/Groq.

---

## Getting Started

### 1. Patient Case Taking Software
```bash
cd Patient-case-taking-software-
npm install
# Set up .env using .env.example
npm run dev
# In another terminal:
node server.js
```

### 2. AuraHealth AI/ML Engine
```bash
cd "aiml-crash-yash-verma-Aurahealth_final_project (1)/aiml-crash-yash-verma-Aurahealth_final_project"
python -m venv .venv
# Activate venv: .venv\Scripts\activate
pip install -r requirements.txt
# Set up .env using .env.example
streamlit run app.py
```