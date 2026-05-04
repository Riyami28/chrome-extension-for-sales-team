import React, { useEffect } from "react";
import { useAppStore } from "../stores/app-store";
import { useCouncil } from "../hooks/useCouncil";
import { GenerationProgress } from "./GenerationProgress";
import { ResearchBriefCard } from "./ResearchBriefCard";

export function CouncilRunner() {
  const { flowStep, generationProgress, isGenerating, researchBrief } = useAppStore();
  const { run } = useCouncil();

  useEffect(() => {
    if (flowStep === "generating" && !isGenerating) {
      run();
    }
  }, [flowStep, isGenerating, run]);

  if (!generationProgress) return null;
  return (
    <div className="space-y-3">
      <GenerationProgress progress={generationProgress} />
      {researchBrief && <ResearchBriefCard brief={researchBrief} />}
    </div>
  );
}
