import { useEffect, useCallback } from "react";
import { useAppStore } from "../stores/app-store";
import type { CompanyContext, DocumentState } from "../../shared/types";

export function usePageContext() {
  const { setCompany, setDocumentState } = useAppStore();

  const detectContext = useCallback(async () => {
    try {
      // Request page context from background worker
      const contextResponse = await sendMessage({ type: "GET_PAGE_CONTEXT" });
      if (contextResponse?.data) {
        const raw = contextResponse.data as {
          company_name?: string;
          industry?: string;
          logo_candidate?: string;
          source?: string;
          url?: string;
        };

        if (raw.company_name) {
          const company: CompanyContext = {
            name: raw.company_name,
            domain: raw.url ? new URL(raw.url).hostname : undefined,
            industry: raw.industry,
            logo_url: raw.logo_candidate ?? undefined,
            detected_from: (raw.source as CompanyContext["detected_from"]) ?? "website",
          };
          setCompany(company);
        }
      }

      // Request document state
      const docResponse = await sendMessage({ type: "GET_DOCUMENT_STATE" });
      if (docResponse?.data) {
        const raw = docResponse.data as {
          doc_type: string;
          url: string;
          slides?: unknown[];
        };

        const docState: DocumentState = {
          url: raw.url,
          doc_type: raw.doc_type as DocumentState["doc_type"],
          doc_id: extractDocId(raw.url),
        };
        setDocumentState(docState);
      }
    } catch (err) {
      console.warn("[ClientLens] Context detection failed:", err);
    }
  }, [setCompany, setDocumentState]);

  useEffect(() => {
    detectContext();
  }, [detectContext]);

  return { detectContext };
}

function sendMessage(message: { type: string; payload?: unknown }): Promise<{ data?: unknown; error?: string } | null> {
  return new Promise((resolve) => {
    if (!chrome?.runtime) {
      resolve(null);
      return;
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function extractDocId(url: string): string | undefined {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1];
}
