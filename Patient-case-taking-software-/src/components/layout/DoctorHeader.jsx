import React, { useState, useEffect } from "react";
import {
  Stethoscope,
  Users,
  LogOut,
  ShieldCheck,
  Building2,
  RefreshCw,
  FolderOpen
} from "lucide-react";

export const DoctorHeader = ({ activeDoctorRoute = "queue", activeCaseHandle = null, onNavigate }) => {
  const [queueCount, setQueueCount] = useState(null);
  const [clinicianName, setClinicianName] = useState("Dr. Amit K. Verma");
  const [chamber, setChamber] = useState("OPD Chamber #04 - General Medicine");
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleNav = (route) => {
    if (onNavigate) {
      onNavigate(route);
    } else {
      window.history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  // Poll live queue counter periodically
  useEffect(() => {
    let isMounted = true;
    const fetchQueueCount = async () => {
      try {
        const res = await fetch("/api/doctor/queue", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (isMounted) {
            setQueueCount(data.totalWaiting ?? (data.queue ? data.queue.length : 0));
            if (data.doctor) {
              setClinicianName(data.doctor.name || "Dr. Amit K. Verma");
              setChamber(data.doctor.chamber || "OPD Chamber #04");
            }
          }
        }
      } catch (err) {
        // Fallback gracefully without breaking UI
      }
    };

    fetchQueueCount();
    const timer = setInterval(fetchQueueCount, 15000);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include"
      });
    } catch (err) {
      // Ignore network error on logout
    } finally {
      localStorage.removeItem("medikiosk_role");
      localStorage.removeItem("medikiosk_current_patient");
      handleNav("/doctor/login");
    }
  };

  return (
    <header className="sticky top-0 z-50 bg-slate-900 text-white border-b border-slate-800 shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-wrap items-center justify-between gap-3">
        {/* Brand & Clinician Identity */}
        <div
          onClick={() => handleNav("/doctor/queue")}
          className="flex items-center gap-3 cursor-pointer select-none group"
        >
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 text-white flex items-center justify-center shadow-md shadow-indigo-500/25 group-hover:scale-105 transition-all">
            <Stethoscope size={20} className="transition-transform group-hover:rotate-6" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-black tracking-tight text-white flex items-center gap-1.5">
                MedSync
                <span className="text-[10px] font-extrabold text-indigo-300 bg-indigo-950/80 px-2 py-0.5 rounded-md border border-indigo-700/60">
                  CLINICAL PORTAL
                </span>
              </span>
              <span className="text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full border border-indigo-500/40 bg-indigo-900/40 text-indigo-300 tracking-wider">
                Physician Station
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5 mt-0.5">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span className="text-slate-200 font-semibold">{clinicianName}</span>
              <span className="text-slate-600">•</span>
              <span className="text-slate-400 truncate max-w-[200px]">{chamber}</span>
            </p>
          </div>
        </div>

        {/* Doctor Portal Navigation */}
        <nav className="flex items-center bg-slate-800/90 p-1 rounded-2xl border border-slate-700/70 text-xs font-semibold">
          <button
            onClick={() => handleNav("/doctor/queue")}
            className={`px-3.5 py-1.5 rounded-xl transition flex items-center gap-2 whitespace-nowrap cursor-pointer ${
              activeDoctorRoute === "queue"
                ? "bg-indigo-600 text-white font-black shadow-xs"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <Users size={15} />
            <span>Patient Queue</span>
            {queueCount !== null && (
              <span className="bg-indigo-900 text-indigo-200 text-[10px] font-black px-1.5 py-0.2 rounded-md border border-indigo-400/30">
                {queueCount}
              </span>
            )}
          </button>

          {activeCaseHandle && (
            <button
              onClick={() => handleNav(`/doctor/case/${activeCaseHandle}`)}
              className={`px-3.5 py-1.5 rounded-xl transition flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                activeDoctorRoute === "case"
                  ? "bg-indigo-600 text-white font-black shadow-xs"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <FolderOpen size={15} />
              <span>Active Case Dossier</span>
            </button>
          )}
        </nav>

        {/* Doctor Controls: Security Status & Logout */}
        <div className="flex items-center gap-2.5">
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800/80 text-emerald-400 border border-slate-700 rounded-xl text-[11px] font-semibold">
            <ShieldCheck size={14} className="text-emerald-400" />
            <span>RBAC Verified</span>
          </div>

          <button
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="bg-red-950/40 hover:bg-red-900/60 text-red-300 border border-red-800/60 text-xs font-bold px-3 py-1.5 rounded-xl flex items-center gap-1.5 transition active:scale-95 cursor-pointer disabled:opacity-50"
            title="Sign out of clinician chamber"
          >
            <LogOut size={13} />
            <span>{isLoggingOut ? "Signing out..." : "Sign Out"}</span>
          </button>
        </div>
      </div>
    </header>
  );
};

export default DoctorHeader;
