import React, { useState, useEffect, useCallback } from "react";
import {
  FileText,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Sparkles,
  Search,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Eye,
  RefreshCw,
  Send,
  HelpCircle,
  Stethoscope,
  Building2,
  Calendar,
  Layers,
  ArrowLeft,
  ShieldAlert,
  SlidersHorizontal,
  XCircle,
  ExternalLink
} from "lucide-react";

export const PatientCasePage = ({ caseHandle, onNavigate }) => {
  const [caseData, setCaseData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [activeTab, setActiveTab] = useState("summary"); // "summary" | "intake" | "documents" | "history" | "rag"

  // Document workspace state
  const [selectedDocIndex, setSelectedDocIndex] = useState(0);
  const [activePage, setActivePage] = useState(1);
  const [approving, setApproving] = useState(false);
  const [approvalStatus, setApprovalStatus] = useState(null);
  const [retracting, setRetracting] = useState(false);

  // RAG Studio state
  const [ragQuery, setRagQuery] = useState("");
  const [ragLoading, setRagLoading] = useState(false);
  const [ragHistory, setRagHistory] = useState([]);
  const [ragError, setRagError] = useState("");

  const navigateTo = (path) => {
    if (onNavigate) {
      onNavigate(path);
    } else {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  const fetchCaseDossier = useCallback(async () => {
    if (!caseHandle) return;
    setIsLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch(`/api/doctor/case/${caseHandle}`, {
        credentials: "include",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      });

      if (res.status === 401) {
        navigateTo("/doctor/login");
        return;
      }

      if (res.status === 404) {
        setErrorMsg("Patient case not found or inaccessible under your clinician credentials.");
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || `Failed to load case (${res.status})`);
      }

      const data = await res.json();
      setCaseData(data.case || data);
    } catch (err) {
      setErrorMsg(err.message || "Failed to connect to case service.");
    } finally {
      setIsLoading(false);
    }
  }, [caseHandle]);

  useEffect(() => {
    fetchCaseDossier();
  }, [fetchCaseDossier]);

  // Document Approval Action
  const handleApproveDocument = async (docHandle, currentVersion) => {
    setApproving(true);
    setApprovalStatus(null);
    try {
      const res = await fetch(`/api/documents/${docHandle}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "include",
        body: JSON.stringify({
          expectedVersion: currentVersion,
          action: "APPROVED"
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || "Failed to approve document.");
      }

      setApprovalStatus({ success: true, message: "Document and extracted clinical facts successfully approved!" });
      fetchCaseDossier();
    } catch (err) {
      setApprovalStatus({ success: false, message: err.message });
    } finally {
      setApproving(false);
    }
  };

  // Document Retract Action
  const handleRetractDocument = async (docHandle) => {
    const reason = window.prompt("Enter clinical retraction reason (e.g. Scanned wrong patient record):");
    if (!reason) return;

    setRetracting(true);
    try {
      const res = await fetch(`/api/documents/${docHandle}/retract`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "include",
        body: JSON.stringify({ reason })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || "Failed to retract document.");
      }

      alert("Document clinically retracted.");
      fetchCaseDossier();
    } catch (err) {
      alert(err.message || "Failed to retract document.");
    } finally {
      setRetracting(false);
    }
  };

  // Submit RAG Query
  const handleRagSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!ragQuery.trim() || ragLoading) return;

    const queryText = ragQuery.trim();
    setRagLoading(true);
    setRagError("");

    try {
      const res = await fetch("/api/rag/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "include",
        body: JSON.stringify({
          caseHandle,
          query: queryText
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || `RAG service error (${res.status})`);
      }

      const result = await res.json();
      setRagHistory((prev) => [
        {
          id: Date.now(),
          query: queryText,
          answer: result.answer,
          citations: result.citations || [],
          confidence: result.confidence,
          strategy: result.strategy,
          retrievalPath: result.retrievalPath,
          isNoHistory: result.isNoHistory || !result.historyAvailable
        },
        ...prev
      ]);
      setRagQuery("");
    } catch (err) {
      setRagError(err.message || "Failed to execute clinical RAG query.");
    } finally {
      setRagLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto py-20 px-4 text-center space-y-4">
        <RefreshCw size={36} className="animate-spin text-indigo-600 mx-auto" />
        <h2 className="text-base font-bold text-slate-700">Loading Clinical Case Dossier...</h2>
        <p className="text-xs text-slate-400">Authenticating clinician session and aggregating 5 clinical workspaces.</p>
      </div>
    );
  }

  if (errorMsg || !caseData) {
    return (
      <div className="max-w-3xl mx-auto py-20 px-4 text-center space-y-4">
        <div className="w-14 h-14 bg-red-100 text-red-600 rounded-2xl flex items-center justify-center mx-auto">
          <ShieldAlert size={28} />
        </div>
        <h2 className="text-lg font-black text-slate-900">Access Denied or Case Unavailable</h2>
        <p className="text-xs text-slate-500 max-w-md mx-auto">{errorMsg || "Unable to locate patient record."}</p>
        <button
          onClick={() => navigateTo("/doctor/queue")}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-5 py-2.5 rounded-xl text-xs inline-flex items-center gap-2 cursor-pointer shadow-sm"
        >
          <ArrowLeft size={14} /> Back to Doctor Queue
        </button>
      </div>
    );
  }

  const caseObj = caseData.case || caseData;
  const patient = caseObj.patient || {};
  const encounter = caseObj.encounter || caseObj;
  const intake = caseObj.intake || {};
  const documents = caseObj.documents || [];
  const currentDoc = documents[selectedDocIndex] || null;

  return (
    <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8 space-y-6">
      {/* Patient Dossier Top Banner */}
      <div className="bg-white rounded-3xl border border-slate-200/90 shadow-xs p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigateTo("/doctor/queue")}
            className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer"
            title="Return to Queue"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-black text-slate-900">
                {patient.fullName || patient.name || "Anonymous Patient"}
              </h1>
              <span className="bg-indigo-100 text-indigo-900 text-xs font-black px-2.5 py-0.5 rounded-md border border-indigo-200">
                Token #{encounter.tokenNumber || "N/A"}
              </span>
              <span className="text-xs font-bold text-slate-400">
                {patient.age ? `${patient.age} Yrs` : "Age N/A"} • {patient.gender || "Gender N/A"}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 flex items-center gap-2">
              <span>Chief Complaint: <strong className="text-slate-800">{encounter.chiefComplaint || "Routine consultation"}</strong></span>
              <span className="text-slate-300">•</span>
              <span>ABHA: <strong className="text-slate-700 font-mono">{patient.abhaNumber || "Unlinked"}</strong></span>
            </p>
          </div>
        </div>

        {/* 5 Clinical Workspace Switcher Tabs */}
        <div className="flex items-center bg-slate-100 p-1 rounded-2xl border border-slate-200 text-xs font-black">
          <button
            onClick={() => setActiveTab("summary")}
            className={`px-3 py-2 rounded-xl transition cursor-pointer ${
              activeTab === "summary" ? "bg-white text-indigo-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            1. Clinical Summary
          </button>
          <button
            onClick={() => setActiveTab("intake")}
            className={`px-3 py-2 rounded-xl transition cursor-pointer ${
              activeTab === "intake" ? "bg-white text-indigo-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            2. Intake Review
          </button>
          <button
            onClick={() => setActiveTab("documents")}
            className={`px-3 py-2 rounded-xl transition cursor-pointer flex items-center gap-1 ${
              activeTab === "documents" ? "bg-white text-indigo-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>3. Documents & Scans</span>
            {documents.length > 0 && (
              <span className="bg-indigo-200 text-indigo-900 text-[10px] px-1.5 py-0.2 rounded-full font-black">
                {documents.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`px-3 py-2 rounded-xl transition cursor-pointer ${
              activeTab === "history" ? "bg-white text-indigo-700 shadow-xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            4. Longitudinal History
          </button>
          <button
            onClick={() => setActiveTab("rag")}
            className={`px-3 py-2 rounded-xl transition cursor-pointer flex items-center gap-1.5 ${
              activeTab === "rag" ? "bg-indigo-600 text-white shadow-xs" : "text-indigo-700 hover:bg-indigo-50"
            }`}
          >
            <Sparkles size={13} />
            <span>5. RAG Studio</span>
          </button>
        </div>
      </div>

      {/* =========================================================================
          WORKSPACE 1: CLINICAL SUMMARY
         ========================================================================= */}
      {activeTab === "summary" && (
        <div className="space-y-6">
          {/* Mandatory AI Warning Banner */}
          <div className="bg-amber-50 border border-amber-300 text-amber-900 px-4 py-3 rounded-2xl flex items-center gap-3 shadow-2xs">
            <AlertTriangle size={20} className="text-amber-600 shrink-0" />
            <p className="text-xs font-bold leading-relaxed">
              ⚠️ <strong>AI Clinical Synthesis Advisory</strong>: This clinical overview synthesizes self-reported kiosk responses and unverified document extractions. It is not an official medical diagnosis. Attending physician verification required before clinical action.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Chief Impression Card */}
            <div className="md:col-span-2 bg-white rounded-3xl border border-slate-200 p-6 space-y-4 shadow-xs">
              <h3 className="text-sm font-black uppercase text-slate-400 tracking-wider">
                Clinical Overview & Synthesis
              </h3>
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 text-xs space-y-2 text-slate-800 leading-relaxed font-medium">
                <p>
                  <strong>Presenting Symptom:</strong> {encounter.chiefComplaint || "No acute complaint specified."}
                </p>
                <p>
                  <strong>HPI Narrative:</strong> {intake.hpi || "Patient completed basic kiosk registration without extended AI dialogue."}
                </p>
                <p>
                  <strong>Provisional Triage:</strong> {encounter.triagePriority || "ROUTINE"} priority — {encounter.triageReason || "Standard OPD intake queue."}
                </p>
              </div>

              {/* Reported Medications from Intake */}
              <div>
                <h4 className="text-xs font-black text-slate-700 uppercase tracking-wide mb-2">
                  Active Medications Reported at Kiosk
                </h4>
                {intake.currentMeds && intake.currentMeds.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {intake.currentMeds.map((med, i) => (
                      <span key={i} className="bg-blue-50 text-blue-800 border border-blue-200 text-xs font-bold px-3 py-1 rounded-xl">
                        {med}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 italic">No current medications reported during intake.</p>
                )}
              </div>
            </div>

            {/* Quick Metrics & Vitals */}
            <div className="bg-white rounded-3xl border border-slate-200 p-6 space-y-4 shadow-xs">
              <h3 className="text-sm font-black uppercase text-slate-400 tracking-wider">
                Vitals & Clinical Status
              </h3>
              <div className="space-y-3">
                <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-500">Wait Duration:</span>
                  <span className="text-xs font-black text-slate-900">{encounter.waitTime || "5 mins"}</span>
                </div>
                <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-500">Scanned Documents:</span>
                  <span className="text-xs font-black text-blue-700">{documents.length} File(s)</span>
                </div>
                <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-500">Consultation Status:</span>
                  <span className="text-xs font-black uppercase text-indigo-700">{encounter.consultationStatus || "Waiting"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          WORKSPACE 2: KIOSK INTAKE REVIEW
         ========================================================================= */}
      {activeTab === "intake" && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 space-y-6 shadow-xs">
          <div>
            <h2 className="text-lg font-black text-slate-900">Patient Kiosk Self-Reported Intake</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Responses transcribed during patient interaction with the bilingual AI kiosk terminal.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
                <span className="text-[11px] font-black uppercase text-slate-400 tracking-wider block">
                  Chief Complaint (मुख्य समस्या)
                </span>
                <p className="text-sm font-bold text-slate-900">
                  {encounter.chiefComplaint || "Routine OPD Consultation"}
                </p>
              </div>

              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
                <span className="text-[11px] font-black uppercase text-slate-400 tracking-wider block">
                  History of Present Illness (तकलीफ का विवरण)
                </span>
                <p className="text-xs text-slate-800 leading-relaxed font-medium">
                  {intake.hpi || "No extended narrative captured."}
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
                <span className="text-[11px] font-black uppercase text-slate-400 tracking-wider block">
                  Past Medical History
                </span>
                <p className="text-xs text-slate-800 leading-relaxed font-medium">
                  {intake.pastHistory || "Nil reported."}
                </p>
              </div>

              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
                <span className="text-[11px] font-black uppercase text-slate-400 tracking-wider block">
                  Reported Allergies
                </span>
                <p className="text-xs text-slate-800 font-medium">
                  {intake.allergies && intake.allergies.length > 0 ? intake.allergies.join(", ") : "NKDA (No Known Drug Allergies)"}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          WORKSPACE 3: DOCUMENTS & SCANS VIEWER (SIDE-BY-SIDE)
         ========================================================================= */}
      {activeTab === "documents" && (
        <div className="space-y-6">
          {documents.length === 0 ? (
            <div className="bg-white rounded-3xl border border-slate-200 p-16 text-center space-y-3 shadow-xs">
              <FileText size={36} className="text-slate-300 mx-auto" />
              <h3 className="text-base font-extrabold text-slate-700">No Documents Uploaded</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                No physical prescriptions or lab reports were scanned for this encounter.
              </p>
            </div>
          ) : (
            <>
              {/* Document Switcher & Approval Bar */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-500">Select Document:</span>
                  <select
                    value={selectedDocIndex}
                    onChange={(e) => {
                      setSelectedDocIndex(Number(e.target.value));
                      setActivePage(1);
                      setApprovalStatus(null);
                    }}
                    className="text-xs font-bold bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-slate-900 focus:outline-none"
                  >
                    {documents.map((doc, idx) => (
                      <option key={doc.documentHandle || idx} value={idx}>
                        {doc.fileName || `Document #${idx + 1}`} ({doc.status})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  {currentDoc?.status === "approved" ? (
                    <span className="inline-flex items-center gap-1.5 bg-emerald-100 text-emerald-800 text-xs font-black px-3 py-1.5 rounded-xl border border-emerald-300">
                      <CheckCircle2 size={14} /> Approved by Clinician (v{currentDoc.version || 1})
                    </span>
                  ) : currentDoc?.status === "retracted" ? (
                    <span className="inline-flex items-center gap-1.5 bg-red-100 text-red-800 text-xs font-black px-3 py-1.5 rounded-xl border border-red-300">
                      <XCircle size={14} /> Clinically Retracted
                    </span>
                  ) : (
                    <button
                      onClick={() => handleApproveDocument(currentDoc.documentHandle, currentDoc.version || 1)}
                      disabled={approving}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs px-4 py-2 rounded-xl flex items-center gap-1.5 shadow-sm transition cursor-pointer disabled:opacity-50"
                    >
                      <CheckCircle2 size={14} />
                      <span>{approving ? "Approving..." : "Approve All Facts (हस्ताक्षर करें)"}</span>
                    </button>
                  )}

                  {currentDoc?.status !== "retracted" && (
                    <button
                      onClick={() => handleRetractDocument(currentDoc.documentHandle)}
                      disabled={retracting}
                      className="bg-slate-100 hover:bg-red-50 hover:text-red-700 text-slate-600 font-bold text-xs px-3 py-2 rounded-xl border border-slate-200 transition cursor-pointer"
                    >
                      Retract
                    </button>
                  )}
                </div>
              </div>

              {approvalStatus && (
                <div
                  className={`p-3 rounded-xl border text-xs font-bold ${
                    approvalStatus.success
                      ? "bg-emerald-50 border-emerald-300 text-emerald-900"
                      : "bg-red-50 border-red-300 text-red-900"
                  }`}
                >
                  {approvalStatus.message}
                </div>
              )}

              {/* Side-by-Side: Binary Viewer vs Extracted Facts */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Left: Secure Binary Stream Viewer */}
                <div className="bg-white rounded-3xl border border-slate-200 p-6 space-y-4 shadow-xs">
                  <div className="flex justify-between items-center">
                    <div>
                      <h3 className="text-sm font-black text-slate-900">Original Document Binary</h3>
                      <p className="text-[11px] text-slate-400">Streamed securely via /api/documents/:handle/pages/:pageNum</p>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                      <button
                        onClick={() => setActivePage((p) => Math.max(1, p - 1))}
                        disabled={activePage <= 1}
                        className="p-1 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span>Page {activePage} of {currentDoc?.pageCount || 1}</span>
                      <button
                        onClick={() => setActivePage((p) => Math.min(currentDoc?.pageCount || 1, p + 1))}
                        disabled={activePage >= (currentDoc?.pageCount || 1)}
                        className="p-1 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>

                  <div className="bg-slate-950 rounded-2xl overflow-hidden min-h-[420px] max-h-[540px] flex items-center justify-center p-2 relative">
                    <img
                      src={`/api/documents/${currentDoc?.documentHandle}/pages/${activePage}`}
                      alt="Scanned clinical page"
                      className="max-h-[500px] w-auto object-contain rounded-lg"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        const fallbackEl = document.getElementById(`doc-stream-fallback-${currentDoc?.documentHandle}`);
                        if (fallbackEl) fallbackEl.style.display = "flex";
                      }}
                    />
                    <div
                      id={`doc-stream-fallback-${currentDoc?.documentHandle}`}
                      style={{ display: "none" }}
                      className="flex-col items-center justify-center text-slate-400 space-y-3 p-6 text-center"
                    >
                      <FileText size={48} className="text-slate-600 mx-auto" />
                      <p className="text-xs font-bold">Document preview binary currently unavailable or PDF document.</p>
                      <button
                        onClick={() => {
                          const img = document.querySelector(`img[src*="${currentDoc?.documentHandle}"]`);
                          if (img) {
                            img.style.display = "block";
                            img.src = `/api/documents/${currentDoc?.documentHandle}/pages/${activePage}?t=${Date.now()}`;
                          }
                        }}
                        className="bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold px-3 py-1.5 rounded-xl border border-slate-700 cursor-pointer"
                      >
                        Retry Scan Load
                      </button>
                    </div>
                  </div>
                </div>

                {/* Right: Extracted Facts & Evidence Verification */}
                <div className="bg-white rounded-3xl border border-slate-200 p-6 space-y-4 shadow-xs">
                  <div className="flex justify-between items-center">
                    <div>
                      <h3 className="text-sm font-black text-slate-900">Extracted Clinical Entities</h3>
                      <p className="text-[11px] text-slate-400">Gemini 2.5 Flash + Dual-Path Evidence Verification</p>
                    </div>
                    <span className="text-xs font-extrabold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-200">
                      {currentDoc?.facts?.length || 0} Facts
                    </span>
                  </div>

                  <div className="space-y-3 max-h-[480px] overflow-y-auto pr-1">
                    {currentDoc?.facts && currentDoc.facts.length > 0 ? (
                      currentDoc.facts.map((fact, idx) => {
                        const isVerified = fact.evidenceStatus === "VERIFIED";
                        const isUnverified = fact.evidenceStatus === "UNVERIFIED_EVIDENCE";

                        return (
                          <div
                            key={fact.id || idx}
                            className="p-3.5 bg-slate-50 hover:bg-slate-100/80 rounded-2xl border border-slate-200 space-y-2 transition"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-md bg-slate-200 text-slate-700 font-mono">
                                {fact.factType || "clinical_fact"}
                              </span>
                              {isVerified ? (
                                <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 text-[10px] font-black px-2 py-0.5 rounded-full border border-emerald-300">
                                  <CheckCircle2 size={11} /> VERIFIED
                                </span>
                              ) : isUnverified ? (
                                <span className="inline-flex items-center gap-1 bg-red-100 text-red-800 text-[10px] font-black px-2 py-0.5 rounded-full border border-red-300">
                                  <AlertTriangle size={11} /> UNVERIFIED
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-800 text-[10px] font-black px-2 py-0.5 rounded-full border border-amber-300">
                                  <AlertTriangle size={11} /> NEEDS_REVIEW
                                </span>
                              )}
                            </div>

                            <div className="text-xs font-extrabold text-slate-900">
                              {fact.factKey}: <span className="text-indigo-700">{fact.factValue}</span>
                            </div>

                            {fact.sourceSnippet && (
                              <div className="text-[11px] font-mono text-slate-500 bg-white p-2 rounded-xl border border-slate-200/80 truncate">
                                Source: "{fact.sourceSnippet}"
                              </div>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <div className="p-8 text-center text-slate-400 space-y-2">
                        <FileText size={24} className="mx-auto text-slate-300" />
                        <p className="text-xs font-medium">No structured facts extracted for this document yet.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* =========================================================================
          WORKSPACE 4: LONGITUDINAL HISTORY
         ========================================================================= */}
      {activeTab === "history" && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 space-y-6 shadow-xs">
          <div>
            <h2 className="text-lg font-black text-slate-900">Longitudinal Medical History Timeline</h2>
            <p className="text-xs text-slate-500 mt-0.5">Chronological record of past visits, diagnoses, and treatments.</p>
          </div>

          <div className="space-y-4">
            <div className="relative pl-6 border-l-2 border-indigo-200 space-y-6">
              {/* Current Encounter Node */}
              <div className="relative">
                <span className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-indigo-600 border-4 border-white shadow-xs"></span>
                <div className="p-4 bg-indigo-50/60 rounded-2xl border border-indigo-200 space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-black text-indigo-900">Current Visit (Active OPD)</span>
                    <span className="text-[11px] font-bold text-indigo-600">Today</span>
                  </div>
                  <p className="text-xs text-slate-700 font-medium">
                    Complaint: {encounter.chiefComplaint || "Routine consultation"}
                  </p>
                </div>
              </div>

              {/* Past History from Case Dossier */}
              {caseData.history && caseData.history.length > 0 ? (
                caseData.history.map((h, i) => (
                  <div key={i} className="relative">
                    <span className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-slate-300 border-4 border-white"></span>
                    <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-1">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-black text-slate-800">{h.encounterType || "Past OPD Visit"}</span>
                        <span className="text-[11px] text-slate-400 font-bold">{h.date || "Past"}</span>
                      </div>
                      <p className="text-xs text-slate-600">{h.summary || h.chiefComplaint}</p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="relative">
                  <span className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-slate-300 border-4 border-white"></span>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200">
                    <p className="text-xs text-slate-500 italic">No prior encounter records found in this hospital's database.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          WORKSPACE 5: LONGITUDINAL RAG STUDIO
         ========================================================================= */}
      {activeTab === "rag" && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 space-y-6 shadow-xs">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles size={20} className="text-indigo-600" />
              <h2 className="text-lg font-black text-slate-900">Longitudinal Clinical RAG Studio</h2>
              <span className="bg-indigo-50 text-indigo-700 text-[10px] font-black px-2 py-0.5 rounded-full border border-indigo-200">
                Grounded Retrieval
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Ask questions about this patient's medical history. Answers are grounded exclusively in verified patient documents and clinical facts.
            </p>
          </div>

          {/* Quick Query Prompts */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-extrabold uppercase text-slate-400 tracking-wider">Example Clinical Prompts:</span>
            <div className="flex flex-wrap gap-2">
              {[
                "What medications was the patient taking last year?",
                "Are there any documented drug allergies?",
                "Summarize past blood glucose and HbA1c test trends",
                "What was the clinical advice given on the previous visit?"
              ].map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => setRagQuery(prompt)}
                  className="text-xs font-semibold bg-slate-50 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 px-3 py-1.5 rounded-xl border border-slate-200 hover:border-indigo-300 transition cursor-pointer"
                >
                  "{prompt}"
                </button>
              ))}
            </div>
          </div>

          {/* Query Form */}
          <form onSubmit={handleRagSubmit} className="flex gap-2">
            <input
              type="text"
              placeholder="Ask a clinical question about this patient's records..."
              value={ragQuery}
              onChange={(e) => setRagQuery(e.target.value)}
              className="flex-1 px-4 py-3 text-xs font-medium rounded-2xl border border-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 shadow-2xs"
            />
            <button
              type="submit"
              disabled={ragLoading || !ragQuery.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black text-xs px-6 py-3 rounded-2xl flex items-center gap-2 shadow-md shadow-indigo-500/20 transition cursor-pointer"
            >
              {ragLoading ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
              <span>Query RAG</span>
            </button>
          </form>

          {ragError && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-2xl text-xs font-bold text-red-800 flex items-center gap-2">
              <ShieldAlert size={16} className="text-red-600 shrink-0" />
              <span>{ragError}</span>
            </div>
          )}

          {/* RAG Answers Stream */}
          <div className="space-y-4 pt-2">
            {ragHistory.map((item) => (
              <div key={item.id} className="p-5 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                <div className="text-xs font-black text-slate-900 flex items-center gap-2">
                  <span className="text-indigo-600 font-bold">Q:</span>
                  <span>{item.query}</span>
                </div>

                <div className="p-4 bg-white rounded-xl border border-slate-200 text-xs text-slate-800 leading-relaxed font-medium">
                  {item.answer}
                </div>

                {/* Citations & Evidence Grounding */}
                {item.citations && item.citations.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">
                      Retrieved Citations & Evidence Provenance:
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {item.citations.map((cite, cIdx) => (
                        <div key={cIdx} className="p-2.5 bg-white rounded-xl border border-slate-200 text-[11px] space-y-1">
                          <div className="font-extrabold text-slate-900 flex justify-between">
                            <span>{cite.documentTitle || cite.fileName || "Medical Record"}</span>
                            <span className="text-slate-400">{cite.clinicalDate || cite.year || ""}</span>
                          </div>
                          {cite.snippet && (
                            <p className="text-slate-600 italic truncate" title={cite.snippet}>
                              "{cite.snippet}"
                            </p>
                          )}
                          {cite.unapproved && (
                            <span className="text-[9px] font-black text-amber-700 bg-amber-50 px-1.5 py-0.2 rounded border border-amber-200">
                              [UNAPPROVED - Pending Review]
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PatientCasePage;
