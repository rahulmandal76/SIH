import React from "react";
import { useDemo } from "../../context/DemoContext";
import {
  Globe,
  User,
  UserCheck,
  MessageSquare,
  UploadCloud,
  FileText,
  ShieldCheck,
  CheckSquare
} from "lucide-react";

export const KioskHeader = ({ activeKioskRoute = "welcome", onNavigate }) => {
  const {
    language,
    setLanguage,
    patientData
  } = useDemo();

  const handleNav = (route) => {
    if (onNavigate) {
      onNavigate(route);
    } else {
      window.history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  const currentToken = patientData?.token || "105";

  return (
    <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b border-slate-200/90 shadow-xs transition-all">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
        {/* Brand & Kiosk Identity */}
        <div
          onClick={() => handleNav("/kiosk")}
          className="flex items-center gap-3 cursor-pointer group select-none"
        >
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-blue-700 via-blue-600 to-cyan-500 text-white flex items-center justify-center shadow-md shadow-blue-500/25 group-hover:scale-105 transition-all">
            <User size={22} className="transition-transform group-hover:scale-110" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-black tracking-tight text-slate-900 flex items-center gap-1.5">
                MedSync
                <span className="text-[10px] font-extrabold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200">
                  KIOSK
                </span>
              </span>
              <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full border tracking-wide bg-blue-50 text-blue-700 border-blue-200">
                Patient Self-Intake
              </span>
            </div>
            <p className="text-xs text-slate-500 font-semibold flex items-center gap-1.5 mt-0.5">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>Kiosk Terminal #03</span>
              <span className="text-slate-300">•</span>
              <span className="text-blue-700 font-bold">Token #{currentToken}</span>
            </p>
          </div>
        </div>

        {/* Kiosk Step Progress Bar / Tabs */}
        <nav className="flex items-center bg-slate-100 p-1 rounded-2xl border border-slate-200/80 max-w-full overflow-x-auto text-xs font-bold">
          <button
            onClick={() => handleNav("/kiosk/register")}
            className={`px-3 py-2 rounded-xl transition flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeKioskRoute === "register"
                ? "bg-white text-blue-700 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <UserCheck size={14} />
            <span>1. Identification</span>
          </button>

          <button
            onClick={() => handleNav("/kiosk/consent")}
            className={`px-3 py-2 rounded-xl transition flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeKioskRoute === "consent"
                ? "bg-white text-blue-700 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <CheckSquare size={14} />
            <span>2. Consent</span>
          </button>

          <button
            onClick={() => handleNav("/kiosk/intake")}
            className={`px-3 py-2 rounded-xl transition flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeKioskRoute === "intake"
                ? "bg-white text-blue-700 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <MessageSquare size={14} />
            <span>3. Assessment</span>
          </button>

          <button
            onClick={() => handleNav("/kiosk/documents")}
            className={`px-3 py-2 rounded-xl transition flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeKioskRoute === "documents"
                ? "bg-white text-blue-700 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <UploadCloud size={14} />
            <span>4. Scans</span>
          </button>

          <button
            onClick={() => handleNav("/kiosk/review")}
            className={`px-3 py-2 rounded-xl transition flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeKioskRoute === "review"
                ? "bg-white text-blue-700 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <FileText size={14} />
            <span>5. Summary</span>
          </button>
        </nav>

        {/* Language & Accessibility Controls (NO Doctor portal links) */}
        <div className="flex items-center gap-2">
          <div className="relative inline-flex items-center text-xs bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-2xs">
            <Globe size={14} className="text-slate-400 mr-1.5 shrink-0" />
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-transparent text-slate-800 font-bold focus:outline-none cursor-pointer text-xs"
              aria-label="Select language"
            >
              <option value="English">English</option>
              <option value="Hindi">हिंदी (Hindi)</option>
              <option value="Bengali">বাংলা (Bengali)</option>
              <option value="Marathi">मराठी (Marathi)</option>
              <option value="Tamil">தமிழ் (Tamil)</option>
              <option value="Telugu">తెలుగు (Telugu)</option>
            </select>
          </div>

          <div className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-xl text-[11px] font-bold">
            <ShieldCheck size={14} className="text-emerald-600" />
            <span>Encrypted Session</span>
          </div>
        </div>
      </div>
    </header>
  );
};

export default KioskHeader;
