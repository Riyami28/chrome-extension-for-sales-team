import React, { useEffect, useState } from "react";
import { useAppStore } from "./stores/app-store";
import { usePageContext } from "./hooks/usePageContext";
import { PersonalizationForm } from "./components/PersonalizationForm";
import { AssetPreview } from "./components/AssetPreview";
import { CouncilRunner } from "./components/CouncilRunner";
import { ResultPanel } from "./components/ResultPanel";
import { LiveModeToggle } from "./components/LiveModeToggle";
import { DesignerPanel } from "./components/DesignerPanel";
import { KnowledgeBasePanel } from "./components/KnowledgeBasePanel";
import { Header, openSettings } from "./components/Header";
import { ModeSwitcher } from "./components/ModeSwitcher";
import { ObjectionPanel } from "./components/ObjectionPanel";
import { MeetingCopilotPanel } from "./components/MeetingCopilotPanel";
import { OnboardingChecklist } from "./components/OnboardingChecklist";
import { ErrorBanner } from "./components/ErrorBanner";
import { isMeetingCopilotEnabled } from "../shared/meeting-copilot/feature-flag";
import { listKB } from "../shared/utils/kb-storage";
import { FileText, BookOpen, Radio } from "lucide-react";

type AdminTab = "form" | "kb" | "copilot";

interface TabDef {
  id: AdminTab;
  label: string;
  icon: React.ReactNode;
  activeBg: string;
  activeText: string;
}

export default function App() {
  const { user, setUser, isGenerating, lastResult, error, setError, flowStep, outputMode } = useAppStore();
  const { detectContext } = usePageContext();
  const [adminTab, setAdminTab] = useState<AdminTab>("form");
  const [kbCount, setKbCount] = useState(0);

  useEffect(() => {
    detectContext();
    listKB().then((entries) => setKbCount(entries.length)).catch(() => { /* ignore */ });
  }, []);

  // Auth is disabled — anyone who opens the extension is treated as a local
  // admin user. Role-based gates downstream still work because `user.role`
  // is populated.
  useEffect(() => {
    if (!user) {
      setUser({
        id: "local-user",
        email: "local@clientlens.app",
        name: "You",
        role: "admin",
      });
    }
  }, [user, setUser]);

  if (!user) return null;

  const hasKBAccess = user.role === "admin" || user.role === "pmm" || user.role === "designer";
  const copilotOn = isMeetingCopilotEnabled();

  const tabs: TabDef[] = [
    {
      id: "form",
      label: "Generate",
      icon: <FileText size={12} />,
      activeBg: "bg-zop-orange",
      activeText: "text-zop-black",
    },
    ...(hasKBAccess
      ? [
          {
            id: "kb" as const,
            label: "Knowledge",
            icon: <BookOpen size={12} />,
            activeBg: "bg-zop-blue",
            activeText: "text-zop-cream",
          },
        ]
      : []),
    ...(copilotOn
      ? [
          {
            id: "copilot" as const,
            label: "Copilot",
            icon: <Radio size={12} />,
            activeBg: "bg-zop-green",
            activeText: "text-zop-black",
          },
        ]
      : []),
  ];
  const showTabs = tabs.length > 1;

  return (
    <div className="flex flex-col h-screen bg-surface-0 text-ink text-sm overflow-hidden font-sans">
      <Header />

      {showTabs && (
        <div className="px-3 pt-2 pb-1 w-full max-w-[720px] mx-auto">
          <div className="flex gap-1 bg-surface-1 border border-line p-1">
            {tabs.map((t) => {
              const active = adminTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setAdminTab(t.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? `${t.activeBg} ${t.activeText}`
                      : "text-ink-3 hover:text-ink hover:bg-surface-2"
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 w-full max-w-[720px] mx-auto">
        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => setError(null)}
            onOpenSettings={openSettings}
          />
        )}

        <OnboardingChecklist kbCount={kbCount} onOpenSettings={openSettings} />

        {(!showTabs || adminTab === "form") && (
          <>
            <ModeSwitcher />

            {outputMode === "pitch" && (
              <>
                <LiveModeToggle />
                {flowStep === "form" && <PersonalizationForm />}
                {flowStep === "preview" && <AssetPreview />}
                {(flowStep === "generating" || isGenerating) && <CouncilRunner />}
                {flowStep === "result" && lastResult && <ResultPanel result={lastResult} />}
              </>
            )}

            {outputMode === "objection" && (
              <>
                {isGenerating && <CouncilRunner />}
                {!isGenerating && <ObjectionPanel />}
              </>
            )}
          </>
        )}

        {showTabs && adminTab === "kb" && (
          <>
            <KnowledgeBasePanel />
            {(user.role === "designer" || user.role === "admin" || user.role === "pmm") && <DesignerPanel />}
          </>
        )}

        {copilotOn && adminTab === "copilot" && <MeetingCopilotPanel />}
      </div>
    </div>
  );
}
