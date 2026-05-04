import { useCallback } from "react";
import { useAppStore, STAGE_INFO } from "../stores/app-store";
import { mockGenerate } from "../../shared/utils/mock-api";
import type { GenerationRequest } from "../../shared/types";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";
const IS_MOCK = import.meta.env.VITE_MOCK_MODE === "true";

export function useGeneration() {
  const {
    company, icpRole, useCase, actionType, outputType,
    documentState, isLiveMode, user,
    setIsGenerating, setGenerationProgress, setLastResult, setError,
  } = useAppStore();

  const generate = useCallback(async (overrides?: Partial<GenerationRequest>) => {
    if (!company || !user) {
      setError("Please set a company and ensure you're logged in.");
      return;
    }

    setError(null);
    setIsGenerating(true);
    setGenerationProgress({ stage: "retrieval", ...STAGE_INFO.retrieval });

    const request: GenerationRequest = {
      company,
      icp_role: icpRole,
      use_case: useCase,
      action_type: actionType,
      output_type: outputType,
      current_document: documentState ?? undefined,
      live_mode: isLiveMode,
      ...overrides,
    };

    try {
      if (IS_MOCK) {
        // Preview mode — generate directly using Claude in-browser
        const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY ?? "";
        if (!apiKey) {
          setError("Set VITE_ANTHROPIC_API_KEY in extension/.env.local for preview mode.");
          return;
        }

        for await (const event of mockGenerate(request, apiKey)) {
          if (event.type === "progress") {
            const stage = event.stage as keyof typeof STAGE_INFO;
            setGenerationProgress({ stage, ...STAGE_INFO[stage] });
          } else if (event.type === "result") {
            setLastResult(event.data as never);
            setGenerationProgress({ stage: "done", ...STAGE_INFO.done });
            if (documentState?.url) {
              chrome.runtime?.sendMessage?.({
                type: "INSERT_CONTENT",
                payload: {
                  action: actionType,
                  slides: (event.data as { final_output: { slides: unknown[] } }).final_output.slides,
                  text: (event.data as { final_output: { renderable_text: string } }).final_output.renderable_text,
                },
              });
            }
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
        return;
      }

      // Production — stream from backend
      const token = await getAuthToken();

      const response = await fetch(`${BACKEND_URL}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: "Unknown error" }));
        throw new Error(err.detail ?? `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "progress") {
              const stage = event.stage as keyof typeof STAGE_INFO;
              setGenerationProgress({ stage, ...STAGE_INFO[stage] });
            } else if (event.type === "result") {
              setLastResult(event.data);
              setGenerationProgress({ stage: "done", ...STAGE_INFO.done });
              if (documentState?.url) {
                chrome.runtime.sendMessage({
                  type: "INSERT_CONTENT",
                  payload: {
                    action: actionType,
                    slides: event.data.final_output.slides,
                    text: event.data.final_output.renderable_text,
                  },
                });
              }
            } else if (event.type === "error") {
              throw new Error(event.message);
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setIsGenerating(false);
    }
  }, [
    company, icpRole, useCase, actionType, outputType,
    documentState, isLiveMode, user,
    setIsGenerating, setGenerationProgress, setLastResult, setError,
  ]);

  const quickAction = useCallback(async (action: string, targetIcp?: string) => {
    await generate({
      action_type: action as GenerationRequest["action_type"],
      icp_role: targetIcp as GenerationRequest["icp_role"] ?? icpRole,
    });
  }, [generate, icpRole]);

  return { generate, quickAction };
}

async function getAuthToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chrome?.identity) {
      // In dev/preview context — use stored token
      chrome.storage?.local?.get("supabase_token", (result) => {
        if (result?.supabase_token) resolve(result.supabase_token);
        else reject(new Error("Not authenticated"));
      });
      return;
    }
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        chrome.storage.local.get("supabase_token", (result) => {
          if (result.supabase_token) resolve(result.supabase_token);
          else reject(new Error("Not authenticated"));
        });
        return;
      }
      resolve(token);
    });
  });
}
