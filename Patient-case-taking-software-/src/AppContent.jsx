import React, { useState, useEffect } from "react";
import { useDemo } from "./context/DemoContext";
import { Header } from "./components/layout/Header";
import { KioskHeader } from "./components/layout/KioskHeader";
import { DoctorHeader } from "./components/layout/DoctorHeader";
import { Footer } from "./components/layout/Footer";
import { DemoBanner } from "./components/layout/DemoBanner";

import { LandingPage } from "./pages/LandingPage";
import { KioskWelcome } from "./pages/KioskWelcome";
import { LanguageSelectPage } from "./pages/LanguageSelectPage";
import { ConsentPage } from "./pages/ConsentPage";
import { PatientAuth } from "./pages/PatientAuth";
import { AIInterviewPage } from "./pages/AIInterviewPage";
import { DocumentScannerPage } from "./pages/DocumentScannerPage";
import { OCRResultsPage } from "./pages/OCRResultsPage";
import { ClinicalSummaryPage } from "./pages/ClinicalSummaryPage";
import { DoctorDashboardPage } from "./pages/DoctorDashboardPage";
import { DoctorQueuePage } from "./pages/DoctorQueuePage";
import { PatientCasePage } from "./pages/PatientCasePage";
import { AyushIntakePage } from "./pages/AyushIntakePage";
import { ArchitecturePage } from "./pages/ArchitecturePage";
import { SecurityPage } from "./pages/SecurityPage";
import { LoginPage } from "./pages/LoginPage";

export const AppContent = () => {
  const { activeTab } = useDemo();
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener("popstate", handleLocationChange);
    return () => window.removeEventListener("popstate", handleLocationChange);
  }, []);

  const navigate = (path) => {
    window.history.pushState(null, "", path);
    setCurrentPath(path);
  };

  // --------------------------------------------------------------------------
  // 1. Kiosk Flow Isolation (/kiosk/*)
  // --------------------------------------------------------------------------
  if (currentPath.startsWith("/kiosk")) {
    let subRoute = "welcome";
    if (currentPath === "/kiosk/register") subRoute = "register";
    else if (currentPath === "/kiosk/consent") subRoute = "consent";
    else if (currentPath === "/kiosk/intake") subRoute = "intake";
    else if (currentPath === "/kiosk/documents") subRoute = "documents";
    else if (currentPath === "/kiosk/ocr-results" || currentPath === "/kiosk/documents/results") subRoute = "ocr-results";
    else if (currentPath === "/kiosk/review") subRoute = "review";

    return (
      <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-800 antialiased">
        <KioskHeader activeKioskRoute={subRoute} onNavigate={navigate} />
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4">
          {subRoute === "welcome" && <KioskWelcome onNavigate={navigate} />}
          {subRoute === "register" && <PatientAuth onNavigate={navigate} />}
          {subRoute === "consent" && <ConsentPage onNavigate={navigate} />}
          {subRoute === "intake" && <AIInterviewPage onNavigate={navigate} />}
          {subRoute === "documents" && <DocumentScannerPage onNavigate={navigate} />}
          {subRoute === "ocr-results" && <OCRResultsPage onNavigate={navigate} />}
          {subRoute === "review" && <ClinicalSummaryPage onNavigate={navigate} />}
        </main>
        <Footer />
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // 2. Doctor Portal Flow Isolation (/doctor/*)
  // --------------------------------------------------------------------------
  if (currentPath.startsWith("/doctor")) {
    if (currentPath === "/doctor/login") {
      return (
        <div className="min-h-screen bg-slate-900 flex flex-col font-sans text-slate-100 antialiased">
          <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-12">
            <LoginPage initialRole="doctor" onNavigate={navigate} />
          </main>
          <Footer />
        </div>
      );
    }

    if (currentPath.startsWith("/doctor/case/")) {
      const caseHandle = currentPath.replace("/doctor/case/", "").split("/")[0];
      return (
        <div className="min-h-screen bg-slate-100 flex flex-col font-sans text-slate-800 antialiased">
          <DoctorHeader activeDoctorRoute="case" activeCaseHandle={caseHandle} onNavigate={navigate} />
          <main className="flex-1 w-full mx-auto">
            <PatientCasePage caseHandle={caseHandle} onNavigate={navigate} />
          </main>
          <Footer />
        </div>
      );
    }

    // /doctor/queue or /doctor
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col font-sans text-slate-800 antialiased">
        <DoctorHeader activeDoctorRoute="queue" onNavigate={navigate} />
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <DoctorQueuePage onNavigate={navigate} />
        </main>
        <Footer />
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // 3. Standard Legacy & Root Tab Navigation (Phase 2-12 Backward Compatibility)
  // --------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-800 antialiased">
      <Header />
      <DemoBanner />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8">
        {activeTab === "landing" && <LandingPage />}
        {activeTab === "kiosk" && <KioskWelcome />}
        {activeTab === "language" && <LanguageSelectPage />}
        {activeTab === "consent" && <ConsentPage />}
        {activeTab === "auth" && <PatientAuth />}
        {activeTab === "interview" && <AIInterviewPage />}
        {activeTab === "scanner" && <DocumentScannerPage />}
        {activeTab === "ocr-results" && <OCRResultsPage />}
        {activeTab === "summary" && <ClinicalSummaryPage />}
        {activeTab === "doctor" && <DoctorDashboardPage />}
        {activeTab === "login" && <LoginPage />}
        {activeTab === "ayush" && <AyushIntakePage />}
        {activeTab === "architecture" && <ArchitecturePage />}
        {activeTab === "security" && <SecurityPage />}
      </main>

      <Footer />
    </div>
  );
};

export default AppContent;
