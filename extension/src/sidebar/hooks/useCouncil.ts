import { useCallback } from "react";
import { useAppStore, STAGE_INFO } from "../stores/app-store";
import { runCouncil } from "../../shared/agents/council";
import { listKB } from "../../shared/utils/kb-storage";
import { getStoredModel } from "../../shared/agents/model-catalog";
import type { AgentResult } from "../../shared/types";

const STAGE_MAP: Record<string, keyof typeof STAGE_INFO> = {
  retrieval: "retrieval",
  icp_personalize: "icp_personalize",
  brand_check: "brand_check",
  validation: "validation",
  generating: "generating",
};

export function useCouncil() {
  const {
    personalization,
    brandAssets,
    deepResearchEnabled,
    setIsGenerating,
    setGenerationProgress,
    setLastResult,
    setResearchBrief,
    setError,
    setFlowStep,
  } = useAppStore();

  const run = useCallback(async () => {
    if (!personalization || !brandAssets) {
      setError("Missing personalization input or brand assets");
      setFlowStep("form");
      return;
    }

    setError(null);
    setResearchBrief(null);
    setIsGenerating(true);
    setGenerationProgress({ stage: deepResearchEnabled ? "research" : "retrieval", ...(deepResearchEnabled ? STAGE_INFO.research : STAGE_INFO.retrieval) });

    const kb = await listKB();
    const agentLog: AgentResult[] = [];

    try {
      const modelOverride = getStoredModel() ?? undefined;
      for await (const event of runCouncil({
        input: personalization,
        brandAssets,
        kb,
        modelOverride,
        deepResearch: deepResearchEnabled,
      })) {
        if (event.type === "stage") {
          const mapped = STAGE_MAP[event.stage] ?? "retrieval";
          setGenerationProgress({ stage: mapped, message: event.message, percent: STAGE_INFO[mapped].percent });
        } else if (event.type === "research") {
          setResearchBrief(event.brief);
        } else if (event.type === "agent") {
          agentLog.push(event.result);
        } else if (event.type === "retry") {
          setGenerationProgress({
            stage: "icp_personalize",
            message: `Retry ${event.attempt} — ${event.reason}`,
            percent: 55,
          });
        } else if (event.type === "done") {
          setLastResult(event.pipeline);
          setGenerationProgress({ stage: "done", ...STAGE_INFO.done });
          setFlowStep("result");
          notifyIfBackgrounded("Pitch deck ready", `${event.pipeline.final_output.slides.length} slides`, "done");
          try {
            const writeRes = await chrome.runtime.sendMessage({
              type: "WRITE_TO_DOC",
              payload: { slides: event.pipeline.final_output.slides },
            });
            if (writeRes && !writeRes.success) {
              setError(`Auto-write skipped: ${writeRes.error}`);
            }
          } catch (writeErr) {
            setError(`Auto-write failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
          }
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Council failed";
      setError(msg);
      setFlowStep("form");
      notifyIfBackgrounded("Pitch deck failed", msg, "error");
    } finally {
      setIsGenerating(false);
    }
  }, [personalization, brandAssets, deepResearchEnabled, setIsGenerating, setGenerationProgress, setLastResult, setResearchBrief, setError, setFlowStep]);

  return { run };
}

function notifyIfBackgrounded(title: string, message: string, kind: "done" | "error") {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  chrome.runtime.sendMessage({ type: "COUNCIL_NOTIFY", payload: { title, message, kind } }).catch(() => {});
}
