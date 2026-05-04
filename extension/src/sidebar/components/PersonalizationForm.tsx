import React, { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2, Search, Presentation, FileText, BookOpen, BarChart3, Wand2 } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { fetchBrandAssets } from "../../shared/utils/brand-assets";
import { ICPSelector } from "./ICPSelector";
import { ICP_PROFILES } from "../../shared/constants/icp-profiles";
import type {
  PersonalizationInput,
  MeetingStage,
  DealSizeBand,
  CloudProvider,
  PitchFormat,
} from "../../shared/types";

const STAGES: { value: MeetingStage; label: string }[] = [
  { value: "discovery", label: "Discovery" },
  { value: "tech_deep_dive", label: "Tech Deep Dive" },
  { value: "poc_scoping", label: "POC Scoping" },
  { value: "poc_execution", label: "POC Execution" },
  { value: "poc_review", label: "POC Review" },
  { value: "commercial_close", label: "Commercial Close" },
];

const DEAL_SIZES: { value: DealSizeBand; label: string }[] = [
  { value: "lt_100k", label: "< $100K annual cloud spend" },
  { value: "100k_1m", label: "$100K – $1M" },
  { value: "gt_1m", label: "$1M+" },
];

const CLOUDS: { value: CloudProvider; label: string }[] = [
  { value: "aws", label: "AWS" },
  { value: "gcp", label: "GCP" },
  { value: "azure", label: "Azure" },
];

const FORMATS: { value: PitchFormat; label: string; sub: string; icon: React.ReactNode }[] = [
  { value: "on_screen_ppt", label: "On-screen / PPT", sub: "Slide-sized cards for live calls", icon: <Presentation size={12} /> },
  { value: "one_pager", label: "One-pager", sub: "Single dense exec summary", icon: <FileText size={12} /> },
  { value: "detailed_doc", label: "Detailed doc", sub: "Long-form, multi-section", icon: <BookOpen size={12} /> },
  { value: "analysis", label: "Analysis", sub: "ROI, positioning, risk", icon: <BarChart3 size={12} /> },
  { value: "custom_doc", label: "Custom doc", sub: "Auto-detect or describe below", icon: <Wand2 size={12} /> },
];

export function PersonalizationForm() {
  const {
    setPersonalization,
    setBrandAssets,
    setFlowStep,
    setError,
    deepResearchEnabled,
    setDeepResearchEnabled,
    icpRole,
  } = useAppStore();

  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");

  // ICPSelector writes the selected ICP into store.icpRole. We seed the
  // free-text persona role input with that ICP's canonical label so the
  // backend's matchICP() keyword matcher resolves it correctly. We only
  // overwrite when the field is empty or when the user hasn't customized
  // it away from a known canonical label — manual edits win.
  const lastSeededLabelRef = useRef<string>("");
  useEffect(() => {
    const profile = ICP_PROFILES.find((p) => p.role === icpRole);
    if (!profile) return;
    setRole((current) => {
      const isEmpty = current.trim() === "";
      const stillSeeded = current === lastSeededLabelRef.current;
      if (isEmpty || stillSeeded) {
        lastSeededLabelRef.current = profile.label;
        return profile.label;
      }
      return current;
    });
  }, [icpRole]);
  const [dealSize, setDealSize] = useState<DealSizeBand | "">("");
  const [stage, setStage] = useState<MeetingStage | "">("");
  const [clouds, setClouds] = useState<CloudProvider[]>([]);
  const [region, setRegion] = useState("");
  const [competitor, setCompetitor] = useState("");
  const [pains, setPains] = useState("");
  const [pitchFormat, setPitchFormat] = useState<PitchFormat>("on_screen_ppt");
  const [customHint, setCustomHint] = useState("");
  const [fetching, setFetching] = useState(false);

  const canSubmit = company.trim() && role.trim() && dealSize;

  function toggleCloud(c: CloudProvider) {
    setClouds((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const input: PersonalizationInput = {
      company_name: company.trim(),
      persona_role: role.trim(),
      deal_size: dealSize as DealSizeBand,
      meeting_stage: stage || undefined,
      clouds: clouds.length ? clouds : undefined,
      region: region.trim() || undefined,
      competitor: competitor.trim() || undefined,
      pain_points: pains.trim() || undefined,
      pitch_format: pitchFormat,
      pitch_format_custom_hint:
        pitchFormat === "custom_doc" && customHint.trim() ? customHint.trim() : undefined,
    };

    setPersonalization(input);
    setFetching(true);
    setError(null);

    try {
      const assets = await fetchBrandAssets(input.company_name);
      setBrandAssets(assets);
      setFlowStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch brand assets");
    } finally {
      setFetching(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink">Personalize this pitch</h2>
        <p className="text-[11px] text-ink-4 mt-0.5">
          Fill required fields. Optional fields sharpen personalization.
        </p>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-4 mb-1.5">
          Output format
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {FORMATS.map((f) => {
            const active = pitchFormat === f.value;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setPitchFormat(f.value)}
                className={`text-left p-2 border transition-colors ${
                  active
                    ? "border-zop-orange bg-zop-orange/10"
                    : "border-line bg-surface-2 hover:border-line-2"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={active ? "text-zop-orange" : "text-ink-3"}>{f.icon}</span>
                  <span className="text-[11px] font-semibold text-ink">{f.label}</span>
                </div>
                <div className="text-[10px] text-ink-4 mt-0.5 leading-snug">{f.sub}</div>
              </button>
            );
          })}
        </div>

        {pitchFormat === "custom_doc" && (
          <div className="mt-2 border border-line bg-surface-1 p-2">
            <label className="block text-[10px] font-mono uppercase tracking-[0.14em] text-ink-4 mb-1">
              Describe the doc <span className="text-ink-4 normal-case tracking-normal font-sans">(optional)</span>
            </label>
            <textarea
              value={customHint}
              onChange={(e) => setCustomHint(e.target.value)}
              rows={2}
              placeholder="e.g. RFP response · security questionnaire · partner brief · proposal — leave blank to auto-detect from the open tab and KB."
              className="w-full border border-line bg-surface-0 px-2 py-1.5 text-[11px] font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange resize-y"
            />
            <div className="text-[10px] text-ink-4 mt-1 leading-snug">
              Skip this and the orchestrator infers the doc shape from the page you're on, the persona, and KB hits.
            </div>
          </div>
        )}
      </div>

      <Field label="Company name" required>
        <input
          type="text"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="e.g. Coca-Cola"
          className="w-full border border-line bg-surface-1 px-2.5 py-2 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
        />
      </Field>

      <ICPSelector />

      <Field label="Persona role" required hint="Picker above seeds this. Override freely — e.g. CFO, VP Engineering, Head of FinOps">
        <input
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="CFO"
          className="w-full border border-line bg-surface-1 px-2.5 py-2 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
        />
      </Field>

      <Field label="Deal size / annual cloud spend" required>
        <select
          value={dealSize}
          onChange={(e) => setDealSize(e.target.value as DealSizeBand | "")}
          className="w-full border border-line bg-surface-1 px-2.5 py-2 text-xs text-ink focus:outline-none focus:border-zop-orange"
        >
          <option value="">Select…</option>
          {DEAL_SIZES.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
      </Field>

      <div className="pt-2 border-t border-line">
        <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-4 mb-2">Optional</p>
      </div>

      <Field label="Meeting stage">
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value as MeetingStage | "")}
          className="w-full border border-line bg-surface-1 px-2.5 py-2 text-xs text-ink focus:outline-none focus:border-zop-orange"
        >
          <option value="">Defaults to Discovery</option>
          {STAGES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </Field>

      <Field label="Primary cloud(s)">
        <div className="flex gap-1.5">
          {CLOUDS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => toggleCloud(c.value)}
              className={`flex-1 px-3 py-1.5 text-xs font-medium border transition-colors ${
                clouds.includes(c.value)
                  ? "bg-zop-orange text-zop-black border-zop-orange"
                  : "bg-surface-2 border-line text-ink-3 hover:border-line-2"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Region / data sovereignty">
        <input
          type="text"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="e.g. India-Mumbai, EU, US, Global"
          className="w-full border border-line bg-surface-1 px-2.5 py-2 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
        />
      </Field>

      <Field label="Competitor in deal">
        <input
          type="text"
          value={competitor}
          onChange={(e) => setCompetitor(e.target.value)}
          placeholder="e.g. CloudHealth, Spot.io, Cast.ai"
          className="w-full border border-line bg-surface-1 px-2.5 py-2 text-xs font-mono text-ink placeholder-ink-4 focus:outline-none focus:border-zop-orange"
        />
      </Field>

      <Field label="Known pain points">
        <textarea
          value={pains}
          onChange={(e) => setPains(e.target.value)}
          placeholder="Short notes — anything the rep has heard from the buyer"
          rows={3}
          className="w-full border border-line bg-surface-1 px-2.5 py-2 text-xs text-ink placeholder-ink-4 resize-none focus:outline-none focus:border-zop-orange"
        />
      </Field>

      <label className="flex items-start gap-2 cursor-pointer bg-zop-blue/10 border border-zop-blue/40 px-3 py-2">
        <input
          type="checkbox"
          checked={deepResearchEnabled}
          onChange={(e) => setDeepResearchEnabled(e.target.checked)}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="flex items-center gap-1.5">
            <Search size={11} className="text-zop-blue" />
            <span className="text-xs text-ink font-medium">Deep research</span>
          </div>
          <span className="text-[10px] text-ink-4">
            Fetch the prospect's homepage and distill tech stack, customers, and recent signals before drafting. Slower but sharper.
          </span>
        </div>
      </label>

      <button
        type="submit"
        disabled={!canSubmit || fetching}
        className="w-full py-2.5 bg-zop-orange text-zop-black disabled:bg-surface-3 disabled:text-ink-4 font-semibold transition-all flex items-center justify-center gap-2 hover:shadow-hover-orange"
      >
        {fetching ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        {fetching ? "Fetching brand assets…" : "Continue"}
      </button>
    </form>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-ink-4">
        {label}
        {required && <span className="text-zop-orange ml-1">*</span>}
      </span>
      {children}
      {hint && <span className="block text-[10px] text-ink-4">{hint}</span>}
    </label>
  );
}
