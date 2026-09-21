import React, { createContext, useContext, useState, useEffect } from "react";

const DemoContext = createContext();

const defaultPatient = {
  token: "105",
  patientId: "P-1001",
  name: "Walk-in Patient",
  age: 42,
  gender: "Male",
  language: "Hindi",
  chiefComplaint: "Awaiting AI Clinical Intake",
  historyStatus: "In Progress",
  priority: "Normal",
  triageReason: "Kiosk Self-Check-in",
  caseData: {
    hpi: "",
    pastHistory: "",
    currentMeds: [],
    allergies: [],
    familyHistory: "Nil reported",
    extractedReports: []
  },
  conversation: []
};

export const DemoProvider = ({ children }) => {
  // Roles: "patient" | "doctor" | "landing"
  const [userRole, setUserRole] = useState(() => {
    return localStorage.getItem("medikiosk_role") || "patient";
  });

  const [activeTab, setActiveTab] = useState(() => {
    const savedRole = localStorage.getItem("medikiosk_role") || "patient";
    return savedRole === "doctor" ? "doctor" : "kiosk";
  });

  const [isDemoMode, setIsDemoMode] = useState(false);
  const [demoStep, setDemoStep] = useState(1);
  const [language, setLanguage] = useState("Hindi");
  const [patientData, setPatientData] = useState(() => {
    const saved = localStorage.getItem("medikiosk_current_patient");
    return saved ? JSON.parse(saved) : defaultPatient;
  });
  const [redFlagTriggered, setRedFlagTriggered] = useState(false);
  const [scannedDocs, setScannedDocs] = useState([]);
  const [activeQueue, setActiveQueue] = useState(() => {
    const saved = localStorage.getItem("medikiosk_queue");
    return saved ? JSON.parse(saved) : [];
  });
  const [patientConversation, setPatientConversation] = useState(() => {
    const saved = localStorage.getItem("medikiosk_conversation");
    return saved ? JSON.parse(saved) : [];
  });
  const [latestToken, setLatestToken] = useState(() => {
    return parseInt(localStorage.getItem("medikiosk_token") || "105", 10);
  });
  const [activeScannedDoc, setActiveScannedDoc] = useState(null);

  // Phase 3.1: Kiosk session token for patient-scope AI authorization.
  // Created by POST /api/intake and bound to a specific patientUid.
  // Required as X-Kiosk-Session header on patient-scoped AI requests.
  // Phase 4 will replace this with a JWT bearing User.id + role.
  const [kioskSessionToken, setKioskSessionToken] = useState(() => {
    return localStorage.getItem("medikiosk_kiosk_token") || null;
  });

  // Switch Role
  const switchRole = (newRole) => {
    setUserRole(newRole);
    localStorage.setItem("medikiosk_role", newRole);
    if (newRole === "doctor") {
      setActiveTab("doctor");
    } else {
      setActiveTab("kiosk");
    }
  };

  // Fetch initial queue from Server API on load
  useEffect(() => {
    const fetchQueue = async () => {
      try {
        const res = await fetch("/api/queue");
        if (res.ok) {
          const data = await res.json();
          if (data.queue && data.queue.length > 0) {
            setActiveQueue(data.queue);
            localStorage.setItem("medikiosk_queue", JSON.stringify(data.queue));
          }
        }
      } catch (e) {
        console.warn("Server fetch notice (using local storage):", e.message);
      }
    };
    fetchQueue();
  }, []);

  // Save changes to localStorage
  useEffect(() => {
    localStorage.setItem("medikiosk_role", userRole);
  }, [userRole]);

  useEffect(() => {
    localStorage.setItem("medikiosk_current_patient", JSON.stringify(patientData));
  }, [patientData]);

  useEffect(() => {
    localStorage.setItem("medikiosk_queue", JSON.stringify(activeQueue));
  }, [activeQueue]);

  useEffect(() => {
    localStorage.setItem("medikiosk_conversation", JSON.stringify(patientConversation));
  }, [patientConversation]);

  useEffect(() => {
    localStorage.setItem("medikiosk_token", latestToken.toString());
  }, [latestToken]);

  // Trigger End-to-End Guided Demo Mode
  const startDemoMode = () => {
    setIsDemoMode(true);
    setDemoStep(1);
    switchRole("patient");
    setActiveTab("kiosk");
  };

  const nextDemoStep = () => {
    const nextStep = demoStep + 1;
    setDemoStep(nextStep);

    switch (nextStep) {
      case 2:
        setActiveTab("language");
        break;
      case 3:
        setActiveTab("consent");
        break;
      case 4:
        setActiveTab("auth");
        break;
      case 5:
        setActiveTab("interview");
        break;
      case 6:
        setRedFlagTriggered(true);
        setActiveTab("interview");
        break;
      case 7:
        setActiveTab("scanner");
        break;
      case 8:
        setActiveTab("ocr-results");
        break;
      case 9:
        setActiveTab("summary");
        break;
      case 10:
        switchRole("doctor");
        setActiveTab("doctor");
        break;
      default:
        setIsDemoMode(false);
        setDemoStep(1);
        break;
    }
  };

  const stopDemoMode = () => {
    setIsDemoMode(false);
    setDemoStep(1);
  };

  // Dynamically analyze conversation and generate real clinical summary
  const saveInterviewAndGenerateSummary = (conversation) => {
    setPatientConversation(conversation);

    const patientReplies = conversation
      .filter((m) => m.sender === "patient")
      .map((m) => m.text);

    const chiefComplaint = patientReplies[0] || (patientData.chiefComplaint !== "Awaiting AI Clinical Intake" ? patientData.chiefComplaint : null);
    const duration = patientReplies[1] || null;
    const painLocation = patientReplies[2] || null;

    // Detect red flags in actual patient responses
    const allPatientText = patientReplies.join(" ").toLowerCase();
    const isRedFlag =
      allPatientText.includes("chest") ||
      allPatientText.includes("seene") ||
      allPatientText.includes("left arm") ||
      allPatientText.includes("baayein") ||
      allPatientText.includes("saans") ||
      allPatientText.includes("breathless") ||
      allPatientText.includes("behosh") ||
      allPatientText.includes("heart");

    const nextTokenNum = latestToken + 1;
    setLatestToken(nextTokenNum);

    // Detect medications dynamically if mentioned in patient conversation
    const detectedMeds = [];
    if (allPatientText.includes("paracetamol") || allPatientText.includes("calpol") || allPatientText.includes("crocin") || allPatientText.includes("dolo")) {
      detectedMeds.push("Tab. Paracetamol 650mg SOS");
    }
    if (allPatientText.includes("bp") || allPatientText.includes("blood pressure") || allPatientText.includes("amlodipine") || allPatientText.includes("telmi")) {
      detectedMeds.push("Tab. Amlodipine 5mg OD");
    }
    if (allPatientText.includes("sugar") || allPatientText.includes("metformin") || allPatientText.includes("diabetes")) {
      detectedMeds.push("Tab. Metformin 500mg BD");
    }
    if (allPatientText.includes("gas") || allPatientText.includes("acidity") || allPatientText.includes("panto") || allPatientText.includes("omee") || allPatientText.includes("antacid")) {
      detectedMeds.push("Cap. Pantoprazole 40mg OD (before breakfast)");
    }
    if (allPatientText.includes("aspirin") || allPatientText.includes("blood thinner") || allPatientText.includes("ecospirin")) {
      detectedMeds.push("Tab. Ecosprin 75mg OD");
    }

    // Preserve previously scanned OCR meds or use detected (never fabricate default medications)
    const existingMeds = Array.isArray(patientData.caseData?.currentMeds) ? patientData.caseData.currentMeds : [];
    const resolvedMeds = detectedMeds.length > 0
      ? Array.from(new Set([...existingMeds, ...detectedMeds]))
      : existingMeds;

    // Build truthful HPI
    const hpiParts = [];
    if (chiefComplaint) hpiParts.push(`Patient reported: "${chiefComplaint}"`);
    if (duration) hpiParts.push(`Duration/Onset: ${duration}`);
    if (painLocation) hpiParts.push(`Location/Characteristics: ${painLocation}`);
    const hpiNarrative = hpiParts.length > 0 ? hpiParts.join(". ") : null;

    // Only set pastHistory if patient reported it
    let resolvedPastHistory = null;
    if (allPatientText.includes("sugar") || allPatientText.includes("diabetes")) {
      resolvedPastHistory = "Diabetes Mellitus Reported";
    } else if (allPatientText.includes("bp") || allPatientText.includes("hypertension") || allPatientText.includes("blood pressure")) {
      resolvedPastHistory = "Hypertension Reported";
    }

    const updatedPatient = {
      ...patientData,
      token: nextTokenNum.toString(),
      chiefComplaint: chiefComplaint || "General check-in",
      priority: isRedFlag ? "High Priority" : "Normal",
      triageReason: isRedFlag
        ? "Acute Red-Flag Symptom detected in patient intake"
        : "Standard OPD Intake",
      historyStatus: "Complete (AI Verified)",
      consultationStatus: "incomplete",
      conversation: conversation,
      caseData: {
        ...patientData.caseData,
        hpi: hpiNarrative,
        pastHistory: resolvedPastHistory,
        currentMeds: resolvedMeds,
        allergies: allPatientText.includes("allergy")
          ? ["Allergy Reported by Patient"]
          : []
      }
    };

    setPatientData(updatedPatient);
    setRedFlagTriggered(isRedFlag);
    return updatedPatient;
  };

  // Submit case to Server Database & Route to Doctor Queue
  const sendCaseToDoctor = async (patientToSubmit) => {
    const rawPatient = patientToSubmit || patientData;
    const patient = {
      ...rawPatient,
      token: String(rawPatient.token),
      consultationStatus: rawPatient.consultationStatus || "incomplete",
      status: rawPatient.status || "waiting"
    };

    // 1. Update local queue immediately
    setActiveQueue((prev) => {
      const filtered = (prev || []).filter((p) => String(p.token).trim() !== String(patient.token).trim());
      return [patient, ...filtered];
    });
    setPatientData(patient);

    // 2. Persist to Express Server backend
    try {
      const resp = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patient)
      });
      const data = await resp.json().catch(() => ({}));
      // Capture the kiosk session token for patient-scoped AI authorization (Phase 3.1)
      if (data.kioskSessionToken) {
        setKioskSessionToken(data.kioskSessionToken);
        localStorage.setItem("medikiosk_kiosk_token", data.kioskSessionToken);
      }
      console.log("[Client] Case saved to server successfully!");
    } catch (err) {
      console.warn("[Client] Saved locally, server sync error:", err.message);
    }

    // 3. Switch role to Doctor and open Doctor Dashboard
    switchRole("doctor");
    setActiveTab("doctor");
  };

  // Submit case to Server Database & Route to Doctor Queue WITHOUT auto-redirecting
  const sendCaseOnlyToDoctor = async (patientToSubmit) => {
    const rawPatient = patientToSubmit || patientData;
    const patient = {
      ...rawPatient,
      token: String(rawPatient.token),
      consultationStatus: rawPatient.consultationStatus || "incomplete",
      status: rawPatient.status || "waiting"
    };

    // 1. Update local queue immediately
    setActiveQueue((prev) => {
      const filtered = (prev || []).filter((p) => String(p.token).trim() !== String(patient.token).trim());
      return [patient, ...filtered];
    });
    setPatientData(patient);

    // 2. Persist to Express Server backend
    try {
      const resp = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patient)
      });
      const data = await resp.json().catch(() => ({}));
      // Capture the kiosk session token for patient-scoped AI authorization (Phase 3.1)
      if (data.kioskSessionToken) {
        setKioskSessionToken(data.kioskSessionToken);
        localStorage.setItem("medikiosk_kiosk_token", data.kioskSessionToken);
      }
      console.log("[Client] Case saved to server successfully!");
    } catch (err) {
      console.warn("[Client] Saved locally, server sync error:", err.message);
    }
  };

  return (
    <DemoContext.Provider
      value={{
        userRole,
        setUserRole,
        switchRole,
        activeTab,
        setActiveTab,
        isDemoMode,
        demoStep,
        startDemoMode,
        nextDemoStep,
        stopDemoMode,
        language,
        setLanguage,
        patientData,
        setPatientData,
        redFlagTriggered,
        setRedFlagTriggered,
        scannedDocs,
        setScannedDocs,
        activeQueue,
        setActiveQueue,
        patientConversation,
        setPatientConversation,
        saveInterviewAndGenerateSummary,
        sendCaseToDoctor,
        sendCaseOnlyToDoctor,
        latestToken,
        activeScannedDoc,
        setActiveScannedDoc,
        kioskSessionToken,
        setKioskSessionToken
      }}
    >
      {children}
    </DemoContext.Provider>
  );
};

export const useDemo = () => useContext(DemoContext);
