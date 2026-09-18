SYNTHETIC SINGLE-PATIENT LONGITUDINAL DATASET
===============================================

Patient ID: SYN-PAT-001
Patient name: Arjun Mehta (fictional)
Span: 2010–2024 (15 yearly files)
Purpose: RAG retrieval, longitudinal medical-history QA, timeline reasoning, citation/evidence testing.

Every yearly file is intentionally self-contained enough to be retrieved independently,
while retaining the same patient ID so a RAG pipeline can associate all documents.

Suggested retrieval metadata:
- patient_id: SYN-PAT-001
- year: YYYY
- document_type: yearly_medical_history
- source_type: synthetic
- data_sensitivity: fictional
- clinical_domains: primary_care, hypertension, diabetes, dyslipidemia, renal_monitoring

Suggested RAG test questions:
1. When was hypertension first treated?
2. When did prediabetes become type 2 diabetes?
3. What medication was added in 2022 and why?
4. How did eGFR change from baseline to 2024?
5. Which medications was the patient taking in 2024?
6. What was the highest recorded HbA1c?
7. Which years show evidence of worsening metabolic risk?
8. Did the patient ever have documented diabetic retinopathy?
9. How did LDL change after statin initiation?
10. Summarize the patient's medical history chronologically.

This dataset is entirely synthetic and must not be treated as clinical evidence.
