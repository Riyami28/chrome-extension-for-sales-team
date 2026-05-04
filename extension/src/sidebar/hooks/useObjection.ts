import { useCallback } from "react";
import { useAppStore, STAGE_INFO, type GenerationProgress } from "../stores/app-store";
import { runObjectionCouncil } from "../../shared/agents/objection-council";
import { listKB } from "../../shared/utils/kb-storage";
import { getStoredModel } from "../../shared/agents/model-catalog";

const STAGE_MAP: Record<string, GenerationProgress["stage"]> = {
  retrieval: "retrieval",
  responding: "responding",
};

export function useObjection() {
  const {
    objectionInput,
    setIsGenerating,
    setGenerationProgress,
    setLastObjection,
    setError,
  } = useAppStore();

  const run = useCallback(async () => {
    if (!objectionInput) {
      setError("No objection text");
      return;
    }
    setError(null);
    setIsGenerating(true);
    setGenerationProgress({ stage: "retrieval", ...STAGE_INFO.retrieval });

    const kb = await listKB();

    try {
      const modelOverride = getStoredModel() ?? undefined;
      for await (const event of runObjectionCouncil({ input: objectionInput, kb, modelOverride })) {
        if (event.type === "stage") {
          const mapped = STAGE_MAP[event.stage] ?? "retrieval";
          setGenerationProgress({ stage: mapped, message: event.message, percent: STAGE_INFO[mapped].percent });
        } else if (event.type === "done") {
          setLastObjection(event.response);
          setGenerationProgress({ stage: "done", ...STAGE_INFO.done });
          notify("ClientLens response ready", event.response.summary || "Click to review", "done");
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Objection council failed";
      setError(msg);
      notify("Objection response failed", msg, "error");
    } finally {
      setIsGenerating(false);
    }
  }, [objectionInput, setIsGenerating, setGenerationProgress, setLastObjection, setError]);

  return { run };
}

function notify(title: string, message: string, kind: "done" | "error") {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  chrome.runtime.sendMessage({ type: "COUNCIL_NOTIFY", payload: { title, message, kind } }).catch(() => {});
}
