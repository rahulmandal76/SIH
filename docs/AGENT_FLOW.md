# Clinical Intake Agent & Question Planner Flow

## 1. Complaint-First Adaptive Question Planning

The clinical intake agent avoids rigid, generic questionnaires by utilizing a clinical domain dependency graph centered around the patient's exact chief complaint:

```mermaid
graph TD
    Start["Patient Enters Chief Complaint"] --> Analyze["Analyze Complaint & Extract Clinical Domain"]
    Analyze --> Decision{"Is Domain Identified?"}
    
    Decision -->|Chest Pain / Dyspnea| Plan_Cardiac["Cardiac / Urgent Assessment Plan<br/>- Radiation to arm/jaw<br/>- Exertion vs Rest<br/>- Sweating / Palpitations"]
    Decision -->|Abdominal Pain / GI| Plan_GI["GI Assessment Plan<br/>- Upper / Lower / Navel location<br/>- Relation to food / meals<br/>- Vomiting / Bowel changes"]
    Decision -->|Respiratory / Cough| Plan_Resp["Respiratory Plan<br/>- Dry vs Sputum / Balgam<br/>- Fever / Chills<br/>- Shortness of breath"]
    Decision -->|General / Other| Plan_Gen["General OPD Plan<br/>- Duration & Onset<br/>- Severity (1-10)<br/>- Associated symptoms"]
    
    Plan_Cardiac --> Ask["Ask One Question Sequentially"]
    Plan_GI --> Ask
    Plan_Resp --> Ask
    Plan_Gen --> Ask

    Ask --> PatientResponse["Patient Answers / Skips / Says 'Pata Nahi'"]
    PatientResponse --> CheckSufficiency{"Is Clinical Info Sufficient?<br/>(Max 4-5 high-value questions)"}
    
    CheckSufficiency -->|No| Ask
    CheckSufficiency -->|Yes| Summary["Synthesize Structured Clinical Summary"]
    Summary --> Review["Patient Reviews & Edits Details"]
    Review --> Confirm["Confirm & Route to Doctor OPD Queue"]
```

---

## 2. Patient Controls & Provable Provenance
- **Controls**:
  - `Skip Question`: System marks field as `NOT_REPORTED` and advances to next high-value question.
  - `Pata Nahi / Don't Know`: System marks field as `UNKNOWN_TO_PATIENT` to prevent repeated clinical prompts.
  - `Edit Answer`: Patient can edit any previous answer before final case submission.
- **Provenance Tagging**:
  - Direct patient statements are tagged as `PATIENT_REPORTED`.
  - Normalized AI summaries are tagged as `AI_GENERATED_SUMMARY`.
  - The doctor sees both the synthesized summary and the raw interview conversation side-by-side in `DoctorDashboardPage.jsx`.
