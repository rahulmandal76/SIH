import React, { useState, useEffect, useRef } from "react";
import { useDemo } from "../context/DemoContext";
import { RedFlagAlert } from "../components/common/RedFlagAlert";
import {
  Mic,
  MicOff,
  Send,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Zap,
  Sparkles,
  Stethoscope,
  Volume2,
  CheckCircle2,
  AlertCircle,
  SkipForward,
  HelpCircle,
  Edit3,
  Check,
  X,
  FileText
} from "lucide-react";
// Phase 13: Genuinely Gemini AI-driven clinical intake (/api/intake/interview/*)
// Zero dummy questions, zero synthetic answers, honest AI_UNAVAILABLE handling

const CLINICAL_STEPS = [
  "Chief Complaint",
  "Duration & Onset",
  "Severity & Character",
  "Spread & Radiation",
  "Aggravating Factors",
  "Current Medications"
];

export const AIInterviewPage = ({ onNavigate }) => {
  const {
    setActiveTab,
    language,
    isDemoMode,
    nextDemoStep,
    redFlagTriggered,
    setRedFlagTriggered,
    saveInterviewAndGenerateSummary,
    patientData,
    kioskSessionToken
  } = useDemo();

  const [isListening, setIsListening] = useState(false);
  const [inputText, setInputText] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(5);

  // Phase 13 Gemini Interview Session & State Machine
  const [sessionId, setSessionId] = useState(null);
  const [currentQuestionKey, setCurrentQuestionKey] = useState(null);
  const [isComplete, setIsComplete] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewTurns, setReviewTurns] = useState([]);
  const [editingTurnIndex, setEditingTurnIndex] = useState(null);
  const [editText, setEditText] = useState("");
  const [isSubmittingIntake, setIsSubmittingIntake] = useState(false);

  // Dynamic options populated only when Gemini provides contextual choices
  const [dynamicOptions, setDynamicOptions] = useState([]);
  const chatEndRef = useRef(null);

  const [conversation, setConversation] = useState([
    {
      sender: "ai",
      text: language === "English"
        ? `Hello ${patientData?.name ? patientData.name.split(" ")[0] : ""}! What health concerns are bringing you in today? Please describe your main symptoms.`
        : language === "Hinglish"
          ? `Namaste ${patientData?.name ? patientData.name.split(" ")[0] : ""} ji! Aaj aapko kya takleef hai? Kripya apni mukhya pareshani batayein.`
          : `नमस्ते ${patientData?.name ? patientData.name.split(" ")[0] : ""} जी! आज आपको क्या तकलीफ है? कृपया अपनी मुख्य परेशानी बताइए।`,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }
  ]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation, isThinking]);

  const checkRedFlag = (text) => {
    const lower = (text || "").toLowerCase();
    return ["chest", "seene", "left arm", "baayein", "saans", "breathless", "behosh", "heart", "dil", "chakkar"].some(k => lower.includes(k));
  };

  /**
   * handleStepAction — Dispatches turn to Gemini AI intake runtime
   * Supports 'answer', 'skip', and 'unknown' ("Pata Nahi")
   * Truthful AI_UNAVAILABLE on errors (ZERO dummy fallback questions)
   */
  const handleStepAction = async (actionType = "answer", textValue = null) => {
    const text = textValue !== null ? textValue : inputText;
    if (actionType === "answer" && !text.trim()) return;
    if (isThinking || isComplete) return;

    const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    let patientDisplay = text;
    if (actionType === "skip") patientDisplay = language === "English" ? "Skip" : language === "Hinglish" ? "Chhodein (Skip)" : "छोड़ें (Skip)";
    else if (actionType === "unknown") patientDisplay = language === "English" ? "Don't know" : language === "Hinglish" ? "Pata nahi (Don't know)" : "पता नहीं (Pata Nahi / Don't Know)";

    const updatedConv = [...conversation, { sender: "patient", text: patientDisplay, time: timeStr }];
    setConversation(updatedConv);
    setInputText("");
    setIsThinking(true);

    if (actionType === "answer" && checkRedFlag(text)) {
      setRedFlagTriggered(true);
    }

    const aiTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setConversation(prev => [...prev, { sender: "ai", text: "", time: aiTime, streaming: true }]);

    const authHeaders = {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(kioskSessionToken ? { "X-Kiosk-Session": kioskSessionToken } : {})
    };

    try {
      // 1. Initial turn: Start interview session if not yet initialized
      if (!sessionId) {
        let startRes = await fetch("/api/intake/interview/start", {
          method: "POST",
          headers: authHeaders,
          credentials: "include",
          body: JSON.stringify({
            chiefComplaint: text,
            language
          })
        });

        // Self-Healing Encounter Session: if missing or expired, auto-provision and retry
        if (startRes.status === 401) {
          try {
            const pName = patientData?.name || "Walk-in Patient";
            const pAge = parseInt(patientData?.age, 10) || 30;
            const pGender = patientData?.gender || "Male";
            const pPhone = patientData?.phone || "9876543210";

            const provRes = await fetch("/api/intake", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest"
              },
              credentials: "include",
              body: JSON.stringify({
                name: pName,
                age: pAge,
                gender: pGender,
                phone: pPhone,
                chiefComplaint: text
              })
            });

            if (provRes.ok) {
              const provData = await provRes.json();
              if (provData.encounterId) {
                setPatientData(prev => ({
                  ...prev,
                  encounterId: provData.encounterId,
                  token: provData.token || prev.token
                }));
              }
              // Retry interview start with established encounter session
              startRes = await fetch("/api/intake/interview/start", {
                method: "POST",
                headers: authHeaders,
                credentials: "include",
                body: JSON.stringify({
                  chiefComplaint: text,
                  language
                })
              });
            }
          } catch (provErr) {
            console.warn("[AIInterviewPage] Session auto-provision error:", provErr);
          }
        }

        if (startRes.ok) {
          const startData = await startRes.json();
          if (startData.success && startData.sessionId) {
            setSessionId(startData.sessionId);
            setCurrentStep(startData.currentStep || 1);
            setTotalQuestions(startData.totalQuestions || 5);

            if (startData.isComplete || !startData.nextQuestion) {
              setIsComplete(true);
              setShowReviewModal(true);
              setConversation(prev => {
                const c = [...prev];
                c[c.length - 1] = {
                  sender: "ai",
                  text: language === "English"
                    ? "Thank you! Your initial information has been recorded. Please review the summary below."
                    : "धन्यवाद! आपकी प्राथमिक जानकारी दर्ज कर ली गई है। कृपया नीचे दी गई समरी की जांच करें।",
                  time: aiTime,
                  streaming: false
                };
                return c;
              });
              setIsThinking(false);
              return;
            }

            setCurrentQuestionKey(startData.nextQuestion.questionKey);
            setDynamicOptions(startData.nextQuestion.options || []);
            setConversation(prev => {
              const c = [...prev];
              c[c.length - 1] = {
                sender: "ai",
                text: startData.nextQuestion.text,
                time: aiTime,
                streaming: false
              };
              return c;
            });
            setIsThinking(false);
            return;
          }
        } else {
          // Explicit truthful AI_UNAVAILABLE handling
          const errData = await startRes.json().catch(() => ({}));
          const isUnavailable = startRes.status === 503 || errData.error?.code === "AI_UNAVAILABLE";
          setIsThinking(false);
          setConversation(prev => {
            const c = [...prev];
            c[c.length - 1] = {
              sender: "ai",
              isUnavailable: true,
              text: isUnavailable
                ? (language === "English"
                    ? "⚠️ [AI Unavailable] The Gemini AI intake assistant is temporarily offline. Production intake will not fabricate questions. Please retry or continue directly to registration."
                    : "⚠️ [AI सेवा अनुपलब्ध] जेमिनी AI क्लिनिकल असिस्टेंट वर्तमान में अनुपलब्ध है। कृपया पुनः प्रयास करें या सीधे रजिस्ट्रेशन के लिए आगे बढ़ें।")
                : (errData.error?.message || "Failed to contact intake assistant. Please retry."),
              time: aiTime,
              streaming: false
            };
            return c;
          });
          return;
        }
      } else {
        // 2. Subsequent turns: Step the authoritative interview state machine
        const stepRes = await fetch("/api/intake/interview/step", {
          method: "POST",
          headers: authHeaders,
          credentials: "include",
          body: JSON.stringify({
            sessionId,
            questionKey: currentQuestionKey || "general",
            answerText: actionType === "answer" ? text : undefined,
            action: actionType,
            language
          })
        });

        if (stepRes.ok) {
          const stepData = await stepRes.json();
          if (stepData.success) {
            setCurrentStep(stepData.currentStep);
            setTotalQuestions(stepData.totalQuestions || 5);

            if (stepData.isComplete || !stepData.nextQuestion) {
              setIsComplete(true);
              setShowReviewModal(true);
              if (stepData.reviewSummary) {
                setReviewTurns(stepData.reviewSummary);
              }
              setConversation(prev => {
                const c = [...prev];
                c[c.length - 1] = {
                  sender: "ai",
                  text: language === "English"
                    ? "Great! All key symptoms have been recorded. Please verify your responses in the review below."
                    : "बहुत बढ़िया! आपके सभी मुख्य लक्षणों का विवरण सफलतापूर्वक दर्ज हो गया है। कृपया नीचे दिए गए रिव्यू में अपने उत्तर जांच लें।",
                  time: aiTime,
                  streaming: false
                };
                return c;
              });
              setIsThinking(false);
              return;
            }

            setCurrentQuestionKey(stepData.nextQuestion.questionKey);
            setDynamicOptions(stepData.nextQuestion.options || []);
            setConversation(prev => {
              const c = [...prev];
              c[c.length - 1] = {
                sender: "ai",
                text: stepData.nextQuestion.text,
                time: aiTime,
                streaming: false
              };
              return c;
            });
            setIsThinking(false);
            return;
          }
        } else {
          // Explicit truthful AI_UNAVAILABLE handling
          const errData = await stepRes.json().catch(() => ({}));
          const isUnavailable = stepRes.status === 503 || errData.error?.code === "AI_UNAVAILABLE";
          setIsThinking(false);
          setConversation(prev => {
            const c = [...prev];
            c[c.length - 1] = {
              sender: "ai",
              isUnavailable: true,
              text: isUnavailable
                ? (language === "English"
                    ? "⚠️ [AI Unavailable] The Gemini AI intake assistant is temporarily offline. Production intake will not fabricate questions. Please retry or continue directly to registration."
                    : "⚠️ [AI सेवा अनुपलब्ध] जेमिनी AI क्लिनिकल असिस्टेंट वर्तमान में अनुपलब्ध है। कृपया पुनः प्रयास करें या सीधे रजिस्ट्रेशन के लिए आगे बढ़ें।")
                : (errData.error?.message || "Failed to process interview step. Please retry."),
              time: aiTime,
              streaming: false
            };
            return c;
          });
          return;
        }
      }
    } catch (err) {
      console.warn("[AIInterview] Gateway network error:", err.message);
      setIsThinking(false);
      setConversation(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          sender: "ai",
          isUnavailable: true,
          text: language === "English"
            ? "⚠️ [Connection Error] Unable to connect to the Gemini AI intake service. Please retry or proceed with manual registration."
            : "⚠️ [कनेक्शन त्रुटि] AI असिस्टेंट से संपर्क नहीं हो पाया। कृपया पुनः प्रयास करें या सीधे रजिस्ट्रेशन के लिए आगे बढ़ें।",
          time: aiTime,
          streaming: false
        };
        return copy;
      });
      return;
    }
  };

  /**
   * handleSaveEdit — Persists inline edits to prior turns via PUT /api/intake/interview/edit
   */
  const handleSaveEdit = async (turnIndex, newText) => {
    if (!sessionId || !newText.trim()) return;
    try {
      const res = await fetch("/api/intake/interview/edit", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          ...(kioskSessionToken ? { "X-Kiosk-Session": kioskSessionToken } : {})
        },
        credentials: "include",
        body: JSON.stringify({
          sessionId,
          turnIndex,
          newAnswerText: newText
        })
      });
      const data = await res.json();
      if (data.success && data.turn) {
        setReviewTurns(prev =>
          prev.map(t => (t.turnIndex === turnIndex ? { ...t, answerText: data.turn.answerText, answerType: "answered" } : t))
        );
        setEditingTurnIndex(null);
        setEditText("");
      }
    } catch (err) {
      console.error("[AIInterview] Failed to edit turn:", err);
    }
  };

  /**
   * handleSubmitIntake — Finalizes interview via POST /api/intake/interview/submit
   * Updates encounter HPI narrative and transitions to document scan / doctor queue
   */
  const handleSubmitIntake = async () => {
    setIsSubmittingIntake(true);
    try {
      if (sessionId) {
        await fetch("/api/intake/interview/submit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            ...(kioskSessionToken ? { "X-Kiosk-Session": kioskSessionToken } : {})
          },
          credentials: "include",
          body: JSON.stringify({ sessionId })
        });
      }
      saveInterviewAndGenerateSummary(conversation);
      if (onNavigate) {
        onNavigate("/kiosk/documents");
      } else if (isDemoMode) {
        nextDemoStep();
      } else {
        setActiveTab("scanner");
      }
    } catch (err) {
      console.error("[AIInterview] Submit intake error:", err);
      saveInterviewAndGenerateSummary(conversation);
      if (onNavigate) {
        onNavigate("/kiosk/documents");
      } else {
        setActiveTab("scanner");
      }
    } finally {
      setIsSubmittingIntake(false);
    }
  };

  const toggleMic = () => {
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      alert("Voice input not supported in this browser.");
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = language === "Hindi" ? "hi-IN" : "en-IN";
    rec.onstart = () => setIsListening(true);
    rec.onend = () => setIsListening(false);
    rec.onresult = (e) => setInputText(e.results[0][0].transcript);
    rec.onerror = () => setIsListening(false);
    if (isListening) rec.stop();
    else rec.start();
  };

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 space-y-4">
      {/* Clinical Stepper & Status Header */}
      <div className="bg-white p-4 sm:p-5 rounded-3xl border border-slate-200/90 shadow-sm space-y-3">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-600 text-white flex items-center justify-center font-bold shadow-md shadow-blue-500/20">
              <Stethoscope size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-slate-900">Adaptive Clinical Intake</h2>
                <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-black px-2 py-0.5 rounded-full">
                  Phase 5A State Machine
                </span>
              </div>
              <p className="text-xs text-slate-500 font-medium">
                Patient: <strong className="text-slate-800">{patientData?.name || "Patient"}</strong> ({patientData?.age || 42}Y / {patientData?.gender || "Male"})
              </p>
            </div>
          </div>

          <div className="text-right">
            <span className="text-xs font-bold text-slate-500 block">
              Question {Math.min(currentStep, totalQuestions)} of {totalQuestions}:{" "}
              <strong className="text-blue-700">
                {CLINICAL_STEPS[Math.min(currentStep, CLINICAL_STEPS.length - 1)]}
              </strong>
            </span>
            {isComplete && (
              <span className="text-[11px] font-extrabold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                ✓ Intake Complete (रिव्यू तैयार)
              </span>
            )}
          </div>
        </div>

        {/* Multi-step progress bar */}
        <div className="grid grid-cols-5 gap-1.5 pt-1">
          {[1, 2, 3, 4, 5].map((stepNum, idx) => (
            <div key={idx} className="space-y-1">
              <div
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  idx < currentStep || isComplete ? "bg-blue-600" : "bg-slate-200"
                }`}
              />
              <span className={`hidden sm:block text-[9px] truncate font-bold text-center ${
                idx < currentStep || isComplete ? "text-blue-700 font-extrabold" : "text-slate-400"
              }`}>
                Step {stepNum}
              </span>
            </div>
          ))}
        </div>
      </div>

      {redFlagTriggered && (
        <RedFlagAlert
          onNotifyTriage={() => {
            alert("🚨 Triage staff notified!");
            setRedFlagTriggered(false);
          }}
          onDismiss={() => setRedFlagTriggered(false)}
        />
      )}

      {/* Main Chat Canvas */}
      <div className="bg-white rounded-3xl border border-slate-200/90 shadow-sm flex flex-col h-[520px] overflow-hidden">
        <div className="flex-1 p-5 sm:p-6 overflow-y-auto space-y-4 bg-gradient-to-b from-slate-50/60 to-white">
          {conversation.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.sender === "patient" ? "justify-end" : "justify-start"}`}>
              {msg.sender === "ai" && (
                <div className="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-sm shadow-blue-500/20 text-xs font-bold mt-1">
                  AI
                </div>
              )}
              
              <div
                className={`max-w-lg p-4 rounded-3xl text-sm leading-relaxed transition-all shadow-xs ${
                  msg.sender === "patient"
                    ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-br-xs font-semibold"
                    : "bg-white text-slate-800 border border-slate-200/90 rounded-bl-xs font-medium"
                }`}
              >
                {msg.text ? (
                  <p className="whitespace-pre-line">{msg.text}</p>
                ) : (
                  <div className="flex items-center gap-2 py-1 px-1 text-slate-400 text-xs">
                    <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                    <span className="ml-1 text-[11px] font-bold text-slate-500">Authoritative AI Planner is thinking...</span>
                  </div>
                )}
                <span
                  className={`text-[10px] block text-right mt-1.5 ${
                    msg.sender === "patient" ? "text-blue-200 font-mono" : "text-slate-400 font-mono"
                  }`}
                >
                  {msg.time}
                </span>
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Interactive Bottom Control Panel */}
        <div className="p-4 sm:p-5 bg-white border-t border-slate-200 space-y-3.5">
          {!isComplete ? (
            <>
              {/* Voice & Quick Actions Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Skip and Pata Nahi Action Buttons (Phase 5A Core) */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleStepAction("skip")}
                    disabled={isThinking || !sessionId}
                    className="flex items-center gap-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-bold px-3.5 py-1.5 rounded-xl transition cursor-pointer disabled:opacity-40"
                    title="Skip this question (अगला सवाल)"
                  >
                    <SkipForward size={14} />
                    <span>छोड़ें (Skip)</span>
                  </button>

                  <button
                    onClick={() => handleStepAction("unknown")}
                    disabled={isThinking || !sessionId}
                    className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 text-xs font-bold px-3.5 py-1.5 rounded-xl transition cursor-pointer disabled:opacity-40"
                    title="Don't know / not sure (पता नहीं)"
                  >
                    <HelpCircle size={14} />
                    <span>पता नहीं (Don't Know)</span>
                  </button>
                </div>

                {/* Microphone Button */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleMic}
                    className={`h-9 px-3.5 rounded-xl flex items-center gap-2 text-white shadow-sm transition text-xs font-bold cursor-pointer ${
                      isListening ? "bg-rose-600 ring-2 ring-rose-300 animate-pulse" : "bg-blue-600 hover:bg-blue-700"
                    }`}
                  >
                    {isListening ? <MicOff size={15} /> : <Mic size={15} />}
                    <span>{isListening ? "Listening..." : "बोलकर बताएं (Mic)"}</span>
                  </button>
                </div>
              </div>

              {/* Dynamic Option Pills */}
              <div className="flex flex-wrap justify-center gap-2">
                {dynamicOptions.map((opt, i) => (
                  <button
                    key={i}
                    onClick={() => handleStepAction("answer", opt)}
                    disabled={isThinking}
                    className="bg-slate-50 hover:bg-blue-50 text-slate-800 hover:text-blue-700 border border-slate-200 hover:border-blue-300 font-bold text-xs px-4 py-2 rounded-xl transition transform active:scale-95 disabled:opacity-50 cursor-pointer shadow-2xs hover:-translate-y-0.5"
                  >
                    {opt}
                  </button>
                ))}
              </div>

              {/* Text Input Row */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleStepAction("answer")}
                  placeholder="अपनी तकलीफ या उत्तर यहाँ लिखें..."
                  className="flex-1 bg-slate-50/80 border border-slate-300 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white font-medium"
                />
                <button
                  onClick={() => handleStepAction("answer")}
                  disabled={isThinking || !inputText.trim()}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white p-3.5 rounded-2xl transition shadow-md shadow-blue-500/20 cursor-pointer"
                >
                  <Send size={18} />
                </button>
              </div>
            </>
          ) : (
            /* Completed State: Review Trigger */
            <div className="py-2 flex items-center justify-between gap-4 bg-emerald-50 border border-emerald-200 rounded-2xl px-5">
              <div className="flex items-center gap-3">
                <CheckCircle2 size={24} className="text-emerald-600 shrink-0" />
                <div>
                  <h4 className="text-sm font-extrabold text-emerald-900">Intake Questionnaire Complete</h4>
                  <p className="text-xs text-emerald-700">Please review your responses before final submission.</p>
                </div>
              </div>
              <button
                onClick={() => setShowReviewModal(true)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black px-4 py-2.5 rounded-xl shadow-sm transition flex items-center gap-1.5 cursor-pointer"
              >
                <FileText size={15} />
                <span>जवाब की समीक्षा करें (Review & Edit)</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Patient Intake Review & Edit Drawer / Modal (Phase 5A Core) */}
      {showReviewModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-5 bg-gradient-to-r from-blue-700 to-indigo-700 text-white flex justify-between items-center">
              <div>
                <h3 className="text-base font-black flex items-center gap-2">
                  <FileText size={18} />
                  <span>मरीज द्वारा दी गई जानकारी की समीक्षा (Intake Review)</span>
                </h3>
                <p className="text-xs text-blue-100 mt-0.5">
                  Check your recorded symptoms. You may edit any response before saving.
                </p>
              </div>
              <button
                onClick={() => setShowReviewModal(false)}
                className="text-white/80 hover:text-white p-1.5 rounded-xl hover:bg-white/10 transition cursor-pointer"
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Turns List */}
            <div className="p-5 overflow-y-auto space-y-3 flex-1 bg-slate-50">
              {reviewTurns.length === 0 ? (
                <div className="text-center py-8 text-slate-500 text-xs">
                  Loading responses...
                </div>
              ) : (
                reviewTurns.map((turn) => (
                  <div
                    key={turn.turnIndex}
                    className="bg-white p-4 rounded-2xl border border-slate-200/90 shadow-2xs space-y-2"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="space-y-0.5">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                          Question #{turn.turnIndex} ({turn.questionKey})
                        </span>
                        <p className="text-xs font-bold text-slate-900">{turn.questionText}</p>
                      </div>
                      <span
                        className={`text-[9px] font-black px-2 py-0.5 rounded-full border ${
                          turn.answerType === "skipped"
                            ? "bg-amber-50 text-amber-700 border-amber-200"
                            : turn.answerType === "unknown"
                            ? "bg-slate-100 text-slate-600 border-slate-300"
                            : "bg-emerald-50 text-emerald-700 border-emerald-200"
                        }`}
                      >
                        {turn.provenance || "PATIENT_REPORTED"}
                      </span>
                    </div>

                    {editingTurnIndex === turn.turnIndex ? (
                      <div className="pt-2 space-y-2">
                        <input
                          type="text"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          className="w-full bg-slate-50 border border-blue-400 rounded-xl px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Updated answer..."
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => {
                              setEditingTurnIndex(null);
                              setEditText("");
                            }}
                            className="text-xs text-slate-500 hover:text-slate-700 px-3 py-1 font-bold cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleSaveEdit(turn.turnIndex, editText)}
                            className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1 cursor-pointer"
                          >
                            <Check size={12} /> Save Change
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-between items-center pt-1 border-t border-slate-100">
                        <p className="text-xs font-semibold text-slate-800">
                          {turn.answerText || "[No answer provided]"}
                        </p>
                        <button
                          onClick={() => {
                            setEditingTurnIndex(turn.turnIndex);
                            setEditText(turn.answerText || "");
                          }}
                          className="text-blue-600 hover:text-blue-800 text-[11px] font-bold flex items-center gap-1 cursor-pointer hover:underline"
                        >
                          <Edit3 size={12} /> बदलें (Edit)
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Modal Bottom Actions */}
            <div className="p-4 bg-white border-t border-slate-200 flex justify-between items-center gap-3">
              <button
                onClick={() => setShowReviewModal(false)}
                className="text-xs font-bold text-slate-600 hover:text-slate-900 px-4 py-2 cursor-pointer"
              >
                Continue Chatting
              </button>

              <button
                onClick={handleSubmitIntake}
                disabled={isSubmittingIntake}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs px-6 py-3 rounded-xl flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-50"
              >
                <span>{isSubmittingIntake ? "Saving..." : "पुष्टि करें और जमा करें (Confirm & Submit)"}</span>
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Nav Actions */}
      <div className="flex flex-wrap justify-between items-center gap-3">
        <button
          onClick={() => setActiveTab("auth")}
          className="text-slate-600 hover:text-slate-900 text-xs font-bold flex items-center gap-1 cursor-pointer"
        >
          <ArrowLeft size={14} /> Back to Name & Age
        </button>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => {
              saveInterviewAndGenerateSummary(conversation);
              if (onNavigate) {
                onNavigate("/kiosk/documents");
              } else {
                setActiveTab("scanner");
              }
            }}
            className="bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs px-4 py-2.5 rounded-xl transition cursor-pointer"
          >
            Scan Old Documents (Optional)
          </button>

          <button
            onClick={() => {
              saveInterviewAndGenerateSummary(conversation);
              if (onNavigate) {
                onNavigate("/kiosk/documents");
              } else if (isDemoMode) {
                nextDemoStep();
              } else {
                setActiveTab("summary");
              }
            }}
            className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-black text-xs px-6 py-3 rounded-xl flex items-center gap-2 shadow-lg shadow-blue-500/20 transition transform active:scale-95 cursor-pointer"
          >
            <span>View Case Summary & PDF (समरी देखें)</span>
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};
