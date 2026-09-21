import React, { useState, useEffect, useCallback } from "react";
import {
  Users,
  Clock,
  AlertTriangle,
  FileText,
  Search,
  RefreshCw,
  ChevronRight,
  ShieldAlert,
  Sparkles,
  CheckCircle2
} from "lucide-react";

export const DoctorQueuePage = ({ onNavigate }) => {
  const [queue, setQueue] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [conflictAlert, setConflictAlert] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [claimingHandle, setClaimingHandle] = useState(null);

  const navigateTo = (path) => {
    if (onNavigate) {
      onNavigate(path);
    } else {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  const fetchQueue = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch("/api/doctor/queue", {
        credentials: "include",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      });

      if (res.status === 401) {
        // Redirect to login if unauthorized
        navigateTo("/doctor/login");
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || `Failed to fetch doctor queue (${res.status})`);
      }

      const data = await res.json();
      setQueue(data.queue || []);
    } catch (err) {
      setErrorMsg(err.message || "Failed to connect to queue service.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    // Refresh every 10 seconds automatically
    const timer = setInterval(fetchQueue, 10000);
    return () => clearInterval(timer);
  }, [fetchQueue]);

  // Handle Encounter Claiming
  const handleClaim = async (caseHandle) => {
    setClaimingHandle(caseHandle);
    setConflictAlert("");

    try {
      const res = await fetch("/api/doctor/queue/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "include",
        body: JSON.stringify({ caseHandle })
      });

      if (res.status === 409) {
        // Claim collision
        setConflictAlert("Encounter already claimed by another clinician. Queue refreshed.");
        fetchQueue();
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || "Failed to claim encounter.");
      }

      const data = await res.json();
      const targetHandle = data.caseHandle || caseHandle;
      navigateTo(`/doctor/case/${targetHandle}`);
    } catch (err) {
      setConflictAlert(err.message || "Error claiming encounter.");
    } finally {
      setClaimingHandle(null);
    }
  };

  // Filter Queue Items
  const filteredQueue = queue.filter((item) => {
    const query = searchQuery.toLowerCase();
    const matchesQuery =
      !query ||
      (item.patientName && item.patientName.toLowerCase().includes(query)) ||
      (item.tokenNumber && String(item.tokenNumber).toLowerCase().includes(query)) ||
      (item.chiefComplaint && item.chiefComplaint.toLowerCase().includes(query));

    const matchesPriority =
      priorityFilter === "all" ||
      (priorityFilter === "high" && (item.triagePriority === "HIGH" || item.priority?.includes("High"))) ||
      (priorityFilter === "routine" && (item.triagePriority === "ROUTINE" || item.priority?.includes("Normal")));

    return matchesQuery && matchesPriority;
  });

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8 space-y-6">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-6 rounded-3xl border border-slate-200/90 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black tracking-tight text-slate-900">
              Live OPD Patient Queue
            </h1>
            <span className="bg-indigo-50 text-indigo-700 text-xs font-black px-2.5 py-1 rounded-full border border-indigo-200">
              {queue.length} Total
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Real-time waiting queue with AI triage prioritization. Claim a patient to start consultation.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchQueue}
            disabled={isLoading}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-2.5 rounded-xl text-xs flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw size={14} className={isLoading ? "animate-spin text-indigo-600" : ""} />
            <span>Refresh Queue</span>
          </button>
        </div>
      </div>

      {/* Collision Alert Banner */}
      {conflictAlert && (
        <div className="bg-amber-50 border border-amber-300 text-amber-900 p-4 rounded-2xl flex items-center gap-3 shadow-xs animate-shake">
          <AlertTriangle size={20} className="text-amber-600 shrink-0" />
          <div className="text-xs font-bold">{conflictAlert}</div>
        </div>
      )}

      {/* Error Alert */}
      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-2xl flex items-center gap-3 text-xs font-bold">
          <ShieldAlert size={18} className="text-red-600 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Search & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200/80 shadow-2xs">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search token, patient name, complaint..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-slate-500">Triage:</span>
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            className="text-xs font-semibold bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
          >
            <option value="all">All Priorities</option>
            <option value="high">High Priority Only</option>
            <option value="routine">Routine Only</option>
          </select>
        </div>
      </div>

      {/* Queue Table */}
      <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-xs">
        {isLoading && queue.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <RefreshCw size={28} className="animate-spin text-indigo-600 mx-auto" />
            <p className="text-xs text-slate-500 font-bold">Loading live patient queue from database...</p>
          </div>
        ) : filteredQueue.length === 0 ? (
          <div className="p-16 text-center space-y-3 text-slate-400">
            <Users size={36} className="mx-auto text-slate-300" />
            <h3 className="text-base font-extrabold text-slate-700">No Patients in Waiting Queue</h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              All registered patients have been consulted or no patients are currently checked in at the kiosk.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/90 text-slate-500 text-[11px] font-black uppercase tracking-wider border-b border-slate-200">
                  <th className="py-3.5 px-4 sm:px-6">Token</th>
                  <th className="py-3.5 px-4">Patient Name</th>
                  <th className="py-3.5 px-4">Triage Priority</th>
                  <th className="py-3.5 px-4">Chief Complaint</th>
                  <th className="py-3.5 px-4">Wait Time</th>
                  <th className="py-3.5 px-4">Scans</th>
                  <th className="py-3.5 px-4 sm:px-6 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs font-medium text-slate-700">
                {filteredQueue.map((item) => {
                  const isHigh =
                    item.triagePriority === "HIGH" ||
                    (item.priority && item.priority.includes("High"));
                  const isClaimedByMe = item.assignedDoctorId && item.status === "in_consultation";

                  return (
                    <tr
                      key={item.caseHandle || item.tokenNumber}
                      className="hover:bg-slate-50/80 transition-colors"
                    >
                      {/* Token */}
                      <td className="py-4 px-4 sm:px-6">
                        <span className="font-mono font-black text-slate-900 bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200">
                          #{item.tokenNumber}
                        </span>
                      </td>

                      {/* Name & Demographics */}
                      <td className="py-4 px-4">
                        <div className="font-black text-slate-900">
                          {item.patientName || "Anonymous Patient"}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {item.age ? `${item.age} yrs` : "Age unknown"} • {item.gender || "Gender unrecorded"}
                        </div>
                      </td>

                      {/* Triage Badge */}
                      <td className="py-4 px-4">
                        {isHigh ? (
                          <span className="inline-flex items-center gap-1.5 bg-red-100 text-red-800 text-[11px] font-black px-2.5 py-1 rounded-full border border-red-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-ping"></span>
                            <span>High Priority</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 text-[11px] font-bold px-2.5 py-1 rounded-full border border-slate-200">
                            <span>Routine</span>
                          </span>
                        )}
                      </td>

                      {/* Chief Complaint */}
                      <td className="py-4 px-4 max-w-xs truncate" title={item.chiefComplaint || ""}>
                        <span className="text-slate-800 font-semibold">
                          {item.chiefComplaint || "Routine OPD Consultation"}
                        </span>
                      </td>

                      {/* Wait Time */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-1 text-slate-500 font-bold">
                          <Clock size={13} className="text-slate-400" />
                          <span>{item.waitTime || `${item.waitingMinutes || 5} mins`}</span>
                        </div>
                      </td>

                      {/* Documents Count */}
                      <td className="py-4 px-4">
                        <span className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 text-[11px] font-black px-2 py-0.5 rounded-md border border-blue-200">
                          <FileText size={12} />
                          <span>{item.documentsCount || 0}</span>
                        </span>
                      </td>

                      {/* Action */}
                      <td className="py-4 px-4 sm:px-6 text-right whitespace-nowrap">
                        {item.status === "completed" ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-bold">
                            <CheckCircle2 size={14} /> Completed
                          </span>
                        ) : (
                          <button
                            onClick={() => handleClaim(item.caseHandle)}
                            disabled={claimingHandle === item.caseHandle}
                            className={`font-black text-xs px-4 py-2 rounded-xl flex items-center gap-1 ml-auto shadow-xs transition cursor-pointer disabled:opacity-50 ${
                              isClaimedByMe
                                ? "bg-indigo-700 hover:bg-indigo-800 text-white"
                                : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-500/20"
                            }`}
                          >
                            <span>
                              {claimingHandle === item.caseHandle
                                ? "Claiming..."
                                : isClaimedByMe
                                ? "Resume Case"
                                : "Claim & Consult"}
                            </span>
                            <ChevronRight size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default DoctorQueuePage;
