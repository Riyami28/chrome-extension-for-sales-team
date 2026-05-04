import { create } from "zustand";
import type {
  User,
  CompanyContext,
  ICPRole,
  ActionType,
  OutputType,
  DocumentState,
  PipelineResult,
  PersonalizationInput,
  BrandAssets,
  FlowStep,
  OutputMode,
  EmailInput,
  EmailPipelineResult,
  ObjectionInput,
  ObjectionResponse,
  ResearchBrief,
} from "../../shared/types";

interface AppState {
  // Auth
  user: User | null;
  setUser: (user: User | null) => void;

  // Company context
  company: CompanyContext | null;
  setCompany: (company: CompanyContext | null) => void;

  // Generation config
  icpRole: ICPRole;
  setIcpRole: (role: ICPRole) => void;

  useCase: string;
  setUseCase: (useCase: string) => void;

  actionType: ActionType;
  setActionType: (type: ActionType) => void;

  outputType: OutputType;
  setOutputType: (type: OutputType) => void;

  // Document state
  documentState: DocumentState | null;
  setDocumentState: (state: DocumentState | null) => void;

  // Mode
  isLiveMode: boolean;
  setIsLiveMode: (live: boolean) => void;

  // Generation state
  isGenerating: boolean;
  setIsGenerating: (generating: boolean) => void;

  generationProgress: GenerationProgress | null;
  setGenerationProgress: (progress: GenerationProgress | null) => void;

  lastResult: PipelineResult | null;
  setLastResult: (result: PipelineResult | null) => void;

  error: string | null;
  setError: (error: string | null) => void;

  // Personalization flow
  flowStep: FlowStep;
  setFlowStep: (step: FlowStep) => void;

  personalization: PersonalizationInput | null;
  setPersonalization: (p: PersonalizationInput | null) => void;

  brandAssets: BrandAssets | null;
  setBrandAssets: (a: BrandAssets | null) => void;

  // Output mode routing (pitch / email / objection)
  outputMode: OutputMode;
  setOutputMode: (mode: OutputMode) => void;

  // Deep research toggle + brief
  deepResearchEnabled: boolean;
  setDeepResearchEnabled: (v: boolean) => void;
  researchBrief: ResearchBrief | null;
  setResearchBrief: (b: ResearchBrief | null) => void;

  // Email flow
  emailInput: EmailInput | null;
  setEmailInput: (e: EmailInput | null) => void;
  lastEmail: EmailPipelineResult | null;
  setLastEmail: (e: EmailPipelineResult | null) => void;

  // Objection flow
  objectionInput: ObjectionInput | null;
  setObjectionInput: (o: ObjectionInput | null) => void;
  lastObjection: ObjectionResponse | null;
  setLastObjection: (o: ObjectionResponse | null) => void;
}

export interface GenerationProgress {
  stage:
    | "research"
    | "retrieval"
    | "brand_check"
    | "icp_personalize"
    | "validation"
    | "generating"
    | "drafting"
    | "responding"
    | "done";
  message: string;
  percent: number;
}

const GENERATION_STAGES: Record<GenerationProgress["stage"], { message: string; percent: number }> = {
  research: { message: "Deep-researching the prospect...", percent: 10 },
  retrieval: { message: "Retrieving relevant content from internal docs...", percent: 25 },
  icp_personalize: { message: "Personalizing for ICP profile...", percent: 55 },
  brand_check: { message: "Checking brand compliance...", percent: 70 },
  validation: { message: "Validating & fact-checking...", percent: 85 },
  generating: { message: "Generating final output...", percent: 95 },
  drafting: { message: "Drafting email...", percent: 55 },
  responding: { message: "Crafting grounded response...", percent: 60 },
  done: { message: "Complete!", percent: 100 },
};

export const STAGE_INFO = GENERATION_STAGES;

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),

  company: null,
  setCompany: (company) => set({ company }),

  icpRole: "cfo",
  setIcpRole: (icpRole) => set({ icpRole }),

  useCase: "",
  setUseCase: (useCase) => set({ useCase }),

  actionType: "generate_new",
  setActionType: (actionType) => set({ actionType }),

  outputType: "google_slides",
  setOutputType: (outputType) => set({ outputType }),

  documentState: null,
  setDocumentState: (documentState) => set({ documentState }),

  isLiveMode: false,
  setIsLiveMode: (isLiveMode) => set({ isLiveMode }),

  isGenerating: false,
  setIsGenerating: (isGenerating) => set({ isGenerating }),

  generationProgress: null,
  setGenerationProgress: (generationProgress) => set({ generationProgress }),

  lastResult: null,
  setLastResult: (lastResult) => set({ lastResult }),

  error: null,
  setError: (error) => set({ error }),

  flowStep: "form",
  setFlowStep: (flowStep) => set({ flowStep }),

  personalization: null,
  setPersonalization: (personalization) => set({ personalization }),

  brandAssets: null,
  setBrandAssets: (brandAssets) => set({ brandAssets }),

  outputMode: "pitch",
  setOutputMode: (outputMode) => set({ outputMode }),

  deepResearchEnabled: false,
  setDeepResearchEnabled: (deepResearchEnabled) => set({ deepResearchEnabled }),
  researchBrief: null,
  setResearchBrief: (researchBrief) => set({ researchBrief }),

  emailInput: null,
  setEmailInput: (emailInput) => set({ emailInput }),
  lastEmail: null,
  setLastEmail: (lastEmail) => set({ lastEmail }),

  objectionInput: null,
  setObjectionInput: (objectionInput) => set({ objectionInput }),
  lastObjection: null,
  setLastObjection: (lastObjection) => set({ lastObjection }),
}));
