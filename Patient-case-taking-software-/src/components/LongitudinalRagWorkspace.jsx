import React, { useState, useEffect, useMemo } from "react";
import {
  Sparkles,
  Clock,
  Search,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Calendar,
  TrendingUp,
  Activity,
  Layers,
  ExternalLink,
  RefreshCw,
  X,
  RotateCcw,
  Sliders,
  User,
  Maximize2,
  Minimize2,
  Info,
  ShieldCheck,
  Send,
  ChevronRight,
  Database
} from "lucide-react";
import { queryLongitudinalRAG, CLINICAL_QUICK_PROMPTS } from "../utils/ragClient";
export { CLINICAL_QUICK_PROMPTS };

/**
 * LongitudinalRagWorkspace
 *
 * Production-quality, doctor-facing longitudinal RAG workspace.
 * Operating boundary:
 *   - Calls POST /api/rag/query exclusively via queryLongitudinalRAG()
 *   - NEVER exposes or transmits patientUid or patientId to browser
 *   - Enforces transient in-memory query history (cleared on context switch)
 *   - Strictly displays grounded citations and explicit no-history warnings
 */
export const LongitudinalRagWorkspace = ({
  selectedPatient = null,
  onInspectDocument = null,
  mode = "full", // "full" or "compact"
  onToggleMode = null,
  activeQueue = [],
  onSelectPatient = null
}) => {
  // Query Input State
  const [queryText, setQueryText] = useState("");
  const [retrievalPath, setRetrievalPath] = useState("auto"); // "auto", "temporal", "semantic"
  const [topK, setTopK] = useState(6);
  const [yearFilter, setYearFilter] = useState("");
  const [showControls, setShowControls] = useState(false);

  // Execution State
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [lastErrorCode, setLastErrorCode] = useState(null);
  const [ragResult, setRagResult] = useState(null);

  // Transient In-Memory Consultation Query History (NEVER saved to storage)
  const [sessionHistory, setSessionHistory] = useState([]);
  const [activeHistoryIndex, setActiveHistoryIndex] = useState(-1);

  // Safe Patient Display Context (No internal UID/DB ID displayed)
  const safePatientContext = useMemo(() => {
    if (!selectedPatient) return null;
    return {
      token: selectedPatient.token || "—",
      name: selectedPatient.name || "Anonymous Patient",
      age: selectedPatient.age ? `${selectedPatient.age}Y` : "Age N/A",
      gender: selectedPatient.gender || "Sex N/A",
      chamber: selectedPatient.chamber ? `Chamber ${selectedPatient.chamber}` : "OPD Room",
      priority: selectedPatient.priority || "Standard",
      chiefComplaint: selectedPatient.chiefComplaint || "Routine consultation",
      encounterId: selectedPatient.encounterId || selectedPatient.id || (selectedPatient.token ? `ENC-${selectedPatient.token}` : null)
    };
  }, [selectedPatient]);

  // Context Switch Guard: Clear all RAG results & transient history when patient changes
  useEffect(() => {
    setQueryText("");
    setRetrievalPath("auto");
    setTopK(6);
    setYearFilter("");
    setRagResult(null);
    setErrorMessage(null);
    setLastErrorCode(null);
    setLoading(false);
    setSessionHistory([]);
    setActiveHistoryIndex(-1);
  }, [safePatientContext?.encounterId, safePatientContext?.token]);

  // Execute Longitudinal Query
  const handleExecuteQuery = async (queryOverride = null, pathOverride = null) => {
    if (loading) return; // Block duplicate submissions while query is pending

    const queryToRun = (queryOverride !== null ? queryOverride : queryText).trim();
    if (!queryToRun) {
      setErrorMessage("Please enter a clinical question before querying.");
      setLastErrorCode("EMPTY_QUERY");
      return;
    }

    if (!safePatientContext?.encounterId) {
      setErrorMessage("No active clinical encounter found. Please select a patient with an active encounter.");
      setLastErrorCode("MISSING_CONTEXT");
      return;
    }

    const pathToUse = pathOverride || retrievalPath;
    const yearToUse = yearFilter && !isNaN(Number(yearFilter)) ? Number(yearFilter) : null;

    setLoading(true);
    setErrorMessage(null);
    setLastErrorCode(null);

    try {
      // Direct call through verified client boundary — NEVER includes patientUid
      const data = await queryLongitudinalRAG({
        encounterId: safePatientContext.encounterId,
        query: queryToRun,
        retrievalPath: pathToUse,
        topK: Number(topK) || 6,
        year: yearToUse
      });

      setRagResult(data);

      // Append to transient session history
      const historyItem = {
        id: Date.now(),
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        query: queryToRun,
        retrievalPath: pathToUse,
        year: yearToUse,
        result: data
      };

      setSessionHistory((prev) => [historyItem, ...prev.slice(0, 9)]); // Keep last 10 queries
      setActiveHistoryIndex(0);
    } catch (err) {
      setErrorMessage(err.userFriendlyMessage || err.message || "Failed to retrieve longitudinal record.");
      setLastErrorCode(err.code || "UNKNOWN_ERROR");
    } finally {
      setLoading(false);
    }
  };

  // Keyboard Submission: Ctrl+Enter or Enter without Shift
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleExecuteQuery();
    }
  };

  // Quick Prompt Click
  const handleSelectQuickPrompt = (prompt) => {
    setQueryText(prompt.query);
    setRetrievalPath(prompt.path || "auto");
    handleExecuteQuery(prompt.query, prompt.path || "auto");
  };

  // Replay from Transient Session History
  const handleSelectHistoryItem = (index) => {
    const item = sessionHistory[index];
    if (item) {
      setActiveHistoryIndex(index);
      setQueryText(item.query);
      setRetrievalPath(item.retrievalPath || "auto");
      if (item.year) setYearFilter(String(item.year));
      setRagResult(item.result);
      setErrorMessage(null);
    }
  };

  // Clear query composer
  const handleClear = () => {
    setQueryText("");
    setErrorMessage(null);
  };

  const isCompact = mode === "compact";

  return (
    <div className={`flex flex-col h-full bg-white rounded-3xl border border-slate-200/90 shadow-sm overflow-hidden transition-all duration-200 ${
      isCompact ? "p-3 space-y-3" : "p-5 space-y-4"
    }`}>
      {/* ─── 1. Header & Patient Clinical Context ──────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-700 via-indigo-600 to-blue-500 text-white flex items-center justify-center shadow-md shadow-blue-500/20 shrink-0">
            <Sparkles size={20} className="animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-black text-slate-900 tracking-tight">
                Longitudinal Clinical Intelligence
              </h2>
              <span className="text-[10px] font-black uppercase tracking-wider bg-blue-50 text-blue-700 px-2 py-0.5 rounded-md border border-blue-200/60">
                AuraHealth CDS
              </span>
            </div>
            <p className="text-[11px] text-slate-500 font-medium">
              Multi-year historical synthesis & timeline analysis
            </p>
          </div>
        </div>

        {/* Selected Clinical Context Display */}
        {safePatientContext ? (
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/80 rounded-2xl px-3 py-1.5 text-xs">
            <div className="flex items-center gap-1.5 font-mono font-bold text-slate-900">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
              <span>#{safePatientContext.token}</span>
            </div>
            <span className="text-slate-300">|</span>
            <span className="font-extrabold text-slate-800">{safePatientContext.name}</span>
            <span className="text-slate-400">({safePatientContext.age} / {safePatientContext.gender})</span>
            <span className="text-slate-300">|</span>
            <span className="text-slate-600 font-medium">{safePatientContext.chamber}</span>

            {/* Context Switcher if active queue provided */}
            {activeQueue && activeQueue.length > 1 && onSelectPatient && (
              <select
                aria-label="Switch patient context"
                value={safePatientContext.token}
                onChange={(e) => {
                  const target = activeQueue.find((p) => String(p.token) === e.target.value);
                  if (target) onSelectPatient(target);
                }}
                className="bg-white border border-slate-300 rounded-lg px-2 py-0.5 text-[11px] font-semibold text-slate-700 cursor-pointer ml-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {activeQueue.map((p) => (
                  <option key={p.token} value={p.token}>
                    #{p.token} — {p.name}
                  </option>
                ))}
              </select>
            )}

            {onToggleMode && (
              <button
                onClick={() => onToggleMode(isCompact ? "full" : "compact")}
                title={isCompact ? "Expand to Full Workspace" : "Compact Consultation View"}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition cursor-pointer ml-1"
              >
                {isCompact ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
              </button>
            )}
          </div>
        ) : (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-1 font-semibold flex items-center gap-1.5">
            <AlertTriangle size={14} />
            <span>No patient selected. Please select a patient from the queue.</span>
          </div>
        )}
      </div>

      {/* ─── 2. Clinical Decision Support (CDS) Safety Banner ──────────────── */}
      <div className="bg-amber-50/70 border border-amber-200/80 rounded-2xl px-3.5 py-2 flex items-center justify-between gap-3 text-xs text-amber-900">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-amber-600 shrink-0" />
          <span className="text-[11px] leading-tight">
            <strong className="font-bold">Clinical Decision Support:</strong> AI synthesis is generated from verified historical records. It assists clinical review but does not replace physician judgment. Verify all critical metrics against source citations.
          </span>
        </div>
        <span className="text-[10px] font-bold text-amber-700 shrink-0 bg-white/70 px-2 py-0.5 rounded border border-amber-200">
          Grounded Ingest
        </span>
      </div>

      {/* ─── 3. Query Composer & Controls ──────────────────────────────────── */}
      <div className="space-y-2.5">
        <div className="relative">
          <textarea
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading || !safePatientContext}
            placeholder={
              safePatientContext
                ? "Ask a longitudinal clinical question (e.g., 'What major conditions has this patient had?', 'Medication timeline', 'HbA1c trend over the years')..."
                : "Select an active patient encounter to enable longitudinal queries..."
            }
            rows={isCompact ? 2 : 3}
            maxLength={2000}
            className="w-full bg-slate-50/70 border border-slate-300/90 rounded-2xl p-3 pr-24 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition disabled:opacity-60 resize-none font-medium leading-relaxed"
          />

          {/* Character counter & submit button inside box */}
          <div className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5">
            {queryText && (
              <button
                type="button"
                onClick={handleClear}
                disabled={loading}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition cursor-pointer"
                title="Clear question"
              >
                <X size={14} />
              </button>
            )}

            <button
              type="button"
              onClick={() => handleExecuteQuery()}
              disabled={loading || !queryText.trim() || !safePatientContext}
              className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 text-white font-extrabold px-3 py-1.5 rounded-xl flex items-center gap-1.5 text-xs shadow-sm shadow-blue-500/20 cursor-pointer transition"
            >
              {loading ? (
                <>
                  <RefreshCw size={13} className="animate-spin" />
                  <span>Analyzing...</span>
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  <span>Query</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Controls Bar & Quick Prompts Row */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          {/* Left: Quick Prompts Carousel/Pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1 mr-0.5">
              <Search size={11} /> Suggested:
            </span>
            {CLINICAL_QUICK_PROMPTS.slice(0, isCompact ? 3 : 5).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectQuickPrompt(p)}
                disabled={loading || !safePatientContext}
                className="bg-slate-100/90 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300 text-slate-600 border border-slate-200/80 rounded-lg px-2 py-0.5 text-[11px] font-semibold transition cursor-pointer disabled:opacity-50"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Right: Retrieval Strategy Controls Toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowControls(!showControls)}
              className={`flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-lg border transition cursor-pointer ${
                showControls
                  ? "bg-blue-50 border-blue-300 text-blue-700"
                  : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
              }`}
            >
              <Sliders size={12} />
              <span>Controls</span>
            </button>

            {sessionHistory.length > 0 && (
              <span className="text-[10px] font-bold text-slate-400">
                Session: {sessionHistory.length} {sessionHistory.length === 1 ? "query" : "queries"}
              </span>
            )}
          </div>
        </div>

        {/* Collapsible Retrieval Parameter Controls */}
        {showControls && (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs animate-fade-in">
            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">
                Retrieval Strategy
              </label>
              <select
                aria-label="Retrieval Strategy"
                value={retrievalPath}
                onChange={(e) => setRetrievalPath(e.target.value)}
                disabled={loading}
                className="w-full bg-white border border-slate-300 rounded-xl px-2.5 py-1 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="auto">Intelligent Routing (Auto)</option>
                <option value="temporal">Timeline & Trend Focus (Temporal)</option>
                <option value="semantic">Semantic Topic Search (Dense)</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">
                Search Breadth (Top-K: {topK})
              </label>
              <input
                type="range"
                min="1"
                max="20"
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
                disabled={loading}
                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
              <div className="flex justify-between text-[9px] text-slate-400 font-mono mt-0.5">
                <span>1 (Focused)</span>
                <span>6 (Standard)</span>
                <span>20 (Broad)</span>
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">
                Year Filter (Optional)
              </label>
              <input
                type="number"
                min="1900"
                max="2100"
                placeholder="e.g. 2021"
                value={yearFilter}
                onChange={(e) => setYearFilter(e.target.value)}
                disabled={loading}
                className="w-full bg-white border border-slate-300 rounded-xl px-2.5 py-1 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
        )}

        {/* Transient Session Query Tabs */}
        {sessionHistory.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
            <span className="text-[10px] font-bold text-slate-400 shrink-0">Inquiry History:</span>
            {sessionHistory.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectHistoryItem(idx)}
                className={`px-2 py-0.5 rounded-md text-[10px] font-bold truncate max-w-[160px] transition cursor-pointer border ${
                  activeHistoryIndex === idx
                    ? "bg-blue-600 text-white border-blue-600 shadow-2xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 border-slate-200"
                }`}
                title={item.query}
              >
                {item.query}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ─── 4. Error Banners ──────────────────────────────────────────────── */}
      {errorMessage && (
        <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded-2xl text-xs flex items-start justify-between gap-2 animate-fade-in">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-extrabold flex items-center gap-1.5">
                <span>Inquiry Issue</span>
                {lastErrorCode && (
                  <span className="font-mono text-[10px] bg-red-100 text-red-700 px-1.5 py-0.2 rounded">
                    {lastErrorCode}
                  </span>
                )}
              </div>
              <p className="text-red-700 mt-0.5 leading-relaxed">{errorMessage}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleExecuteQuery()}
            disabled={loading}
            className="bg-red-100 hover:bg-red-200 text-red-800 font-bold px-2 py-1 rounded-lg text-[10px] flex items-center gap-1 transition cursor-pointer shrink-0"
          >
            <RotateCcw size={11} /> Retry
          </button>
        </div>
      )}

      {/* ─── 5. Results & Grounding Display ────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto space-y-3 min-h-[160px]">
        {loading ? (
          /* Loading State */
          <div className="p-8 text-center bg-slate-50/70 border border-slate-200/80 rounded-2xl space-y-3 animate-pulse">
            <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mx-auto">
              <RefreshCw size={20} className="animate-spin" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-slate-800">Analyzing Longitudinal Patient Record</h4>
              <p className="text-[11px] text-slate-500 mt-1 max-w-md mx-auto">
                Retrieving isolated clinical document embeddings, verifying chronological facts, and synthesizing grounded answer...
              </p>
            </div>
            <div className="inline-flex items-center gap-2 text-[10px] font-mono text-slate-400 bg-white px-3 py-1 rounded-full border border-slate-200">
              <Database size={11} />
              <span>Strategy: {retrievalPath.toUpperCase()} • Top-K: {topK}</span>
            </div>
          </div>
        ) : ragResult ? (
          /* Active Results State */
          <div className="space-y-3">
            {/* No-History Explicit Warning */}
            {(!ragResult.historyAvailable || ragResult.retrievalPath === "NO_HISTORY") && (
              <div className="bg-amber-50 border border-amber-300 text-amber-900 p-3 rounded-2xl text-xs flex items-start gap-2">
                <Info size={16} className="text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <strong className="font-extrabold block">No Longitudinal Document History</strong>
                  <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                    Longitudinal history is unavailable for this patient. This answer is based only on currently available clinical information.
                  </p>
                </div>
              </div>
            )}

            {/* Generated Clinical Synthesis Card */}
            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3">
              {/* Metadata Badges Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-100">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-black uppercase tracking-wider bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md border border-slate-200">
                    {ragResult.strategy || "LONGITUDINAL_SYNTHESIS"}
                  </span>
                  <span className="text-[10px] font-bold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-md border border-blue-200">
                    Path: {ragResult.retrievalPath}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {/* Confidence Pill */}
                  <span
                    className={`text-[10px] font-black px-2.5 py-0.5 rounded-full inline-flex items-center gap-1 ${
                      ragResult.confidence === "high"
                        ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                        : ragResult.confidence === "medium"
                        ? "bg-blue-100 text-blue-800 border border-blue-300"
                        : "bg-amber-100 text-amber-800 border border-amber-300"
                    }`}
                  >
                    <CheckCircle2 size={11} />
                    Confidence: {ragResult.confidence === "insufficient_evidence" ? "Insufficient Evidence" : ragResult.confidence}
                  </span>
                </div>
              </div>

              {/* Chronological Milestones / Years Covered */}
              {ragResult.yearsCovered && ragResult.yearsCovered.length > 0 && (
                <div className="flex items-center gap-2 py-1 px-2.5 bg-slate-50 rounded-xl border border-slate-100 text-xs">
                  <Calendar size={13} className="text-slate-400 shrink-0" />
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider shrink-0">
                    Years Documented:
                  </span>
                  <div className="flex flex-wrap items-center gap-1">
                    {ragResult.yearsCovered.map((yr) => (
                      <span
                        key={yr}
                        className="text-[10px] font-mono font-bold bg-white text-indigo-700 border border-indigo-200 px-2 py-0.2 rounded-md shadow-2xs"
                      >
                        {yr}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Clinical Answer Content */}
              <div className="text-slate-800 text-xs font-medium leading-relaxed space-y-2">
                {ragResult.answer.split("\n\n").map((para, idx) => (
                  <p key={idx} className="whitespace-pre-line">
                    {para}
                  </p>
                ))}
              </div>
            </div>

            {/* Citations & Evidence Panel */}
            {ragResult.citations && ragResult.citations.length > 0 && (
              <div className="bg-slate-50/80 border border-slate-200/90 rounded-2xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <FileText size={14} className="text-blue-600" />
                    <span className="text-xs font-extrabold text-slate-800">
                      Grounded Evidence Citations ({ragResult.citations.length})
                    </span>
                  </div>
                  <span className="text-[10px] font-semibold text-slate-400">
                    Source Verified
                  </span>
                </div>

                <div className="space-y-2">
                  {ragResult.citations.map((c, i) => (
                    <div
                      key={i}
                      className="bg-white p-2.5 rounded-xl border border-slate-200 text-xs space-y-1.5 shadow-2xs hover:border-blue-300 transition"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold text-slate-800 font-mono text-[11px]">
                            Doc #{c.documentId}
                          </span>
                          <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded">
                            p. {c.pageNumber} (v{c.documentVersion || 1})
                          </span>
                          {c.approvalVersion && (
                            <span className="text-[9px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200">
                              Approved v{c.approvalVersion}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold text-slate-500 flex items-center gap-1">
                            <Calendar size={10} />
                            {c.clinicalDate || (c.clinicalYear ? `Year ${c.clinicalYear}` : "Date N/A")}
                          </span>

                          {onInspectDocument && c.documentId && (
                            <button
                              type="button"
                              onClick={() => onInspectDocument(c)}
                              className="text-[10px] font-bold text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-0.5 cursor-pointer ml-1"
                            >
                              <span>Inspect</span>
                              <ExternalLink size={10} />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Excerpt Snippet (Strictly Bounded) */}
                      {c.snippet && (
                        <p className="text-[11px] text-slate-600 italic bg-slate-50 p-2 rounded-lg border-l-2 border-l-blue-500 leading-snug">
                          "{c.snippet}"
                        </p>
                      )}

                      <div className="flex items-center justify-between text-[9px] text-slate-400 font-mono pt-0.5">
                        <span>Provenance: {c.provenance || "DOCUMENT_EXTRACTED"}</span>
                        {typeof c.relevanceScore === "number" && c.relevanceScore > 0 && (
                          <span>Relevance: {(c.relevanceScore * 100).toFixed(1)}%</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Empty State (Before first query) */
          <div className="text-center py-8 px-4 bg-slate-50/50 border border-dashed border-slate-200 rounded-2xl space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto shadow-2xs">
              <Sparkles size={22} />
            </div>
            <div>
              <h4 className="text-xs font-bold text-slate-800">
                Longitudinal Medical Record Intelligence
              </h4>
              <p className="text-[11px] text-slate-500 mt-1 max-w-md mx-auto leading-relaxed">
                Query multi-year historical consultations, medication timelines, chronic conditions, and lab trends for {safePatientContext?.name || "the active patient"}.
              </p>
            </div>

            <div className="pt-2 flex flex-wrap justify-center gap-2 max-w-lg mx-auto">
              {CLINICAL_QUICK_PROMPTS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelectQuickPrompt(p)}
                  disabled={!safePatientContext}
                  className="bg-white hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300 text-slate-700 border border-slate-200 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1.5 transition shadow-2xs cursor-pointer disabled:opacity-50"
                >
                  <span>{p.label}</span>
                  <ChevronRight size={11} className="text-slate-400" />
                </button>
              ))}
            </div>

            <div className="text-[10px] text-slate-400 pt-2 flex items-center justify-center gap-1">
              <ShieldCheck size={12} className="text-emerald-500" />
              <span>Grounded in cryptographically verified records. Zero client-side identity leakage.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
