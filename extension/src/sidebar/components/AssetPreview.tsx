import React, { useRef, useState } from "react";
import { Check, Upload, RefreshCw, ArrowLeft, AlertTriangle } from "lucide-react";
import { useAppStore } from "../stores/app-store";
import { fetchBrandAssets, buildUploadedAssets } from "../../shared/utils/brand-assets";

export function AssetPreview() {
  const { personalization, brandAssets, setBrandAssets, setFlowStep, setError } = useAppStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [refetching, setRefetching] = useState(false);
  const [colorOverride, setColorOverride] = useState(brandAssets?.primary_color ?? "#0891b2");
  const [domainOverride, setDomainOverride] = useState(brandAssets?.domain ?? "");
  const [colorTouched, setColorTouched] = useState(false);

  if (!personalization || !brandAssets) return null;

  const isPlaceholder = brandAssets.logo_source === "placeholder";

  async function handleRefetch() {
    if (!personalization) return;
    setRefetching(true);
    try {
      const next = await fetchBrandAssets(personalization.company_name, {
        domainOverride: domainOverride || undefined,
      });
      const finalColor = colorTouched ? colorOverride : next.primary_color;
      setBrandAssets({ ...next, primary_color: finalColor });
      if (!colorTouched && next.primary_color) setColorOverride(next.primary_color);
      if (!domainOverride && next.domain) setDomainOverride(next.domain);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refetch failed");
    } finally {
      setRefetching(false);
    }
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !personalization) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const assets = await buildUploadedAssets(
        personalization.company_name,
        dataUrl,
        colorTouched ? colorOverride : undefined,
      );
      setBrandAssets(assets);
      if (!colorTouched && assets.primary_color) setColorOverride(assets.primary_color);
    };
    reader.readAsDataURL(file);
  }

  function handleColorChange(hex: string) {
    setColorOverride(hex);
    setColorTouched(true);
    if (brandAssets) setBrandAssets({ ...brandAssets, primary_color: hex });
  }

  function handleConfirm() {
    setFlowStep("generating");
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => setFlowStep("form")}
        className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
      >
        <ArrowLeft size={12} /> Back to form
      </button>

      <div>
        <h2 className="text-sm font-semibold text-slate-100">Confirm brand assets</h2>
        <p className="text-xs text-slate-500 mt-1">
          Found these for <span className="text-slate-300 font-medium">{personalization.company_name}</span>.
          Override the domain or upload a logo if the auto-fetch is off.
        </p>
      </div>

      {isPlaceholder && (
        <div className="flex items-start gap-2 bg-amber-900/30 border border-amber-700/50 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-200">
            Couldn't auto-fetch a logo. Try a different domain (e.g. <code>company.co.in</code>) and refetch, or upload one below.
          </p>
        </div>
      )}

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Logo</span>
          <span className="text-[10px] text-slate-500">
            Source: {brandAssets.logo_source}
          </span>
        </div>

        <div className="flex items-center justify-center h-24 bg-white rounded-lg p-3">
          {brandAssets.logo_url ? (
            <img
              src={brandAssets.logo_url}
              alt={`${personalization.company_name} logo`}
              className="max-h-full max-w-full object-contain"
              onError={() => setBrandAssets({ ...brandAssets, logo_url: undefined, logo_source: "placeholder" })}
            />
          ) : (
            <span className="text-slate-400 text-xs">No logo yet</span>
          )}
        </div>

        <div>
          <label className="text-[10px] uppercase tracking-wide text-slate-500 block mb-1">
            Domain (manual override)
          </label>
          <input
            type="text"
            value={domainOverride}
            onChange={(e) => setDomainOverride(e.target.value)}
            placeholder="e.g. acme.co.in"
            className="input w-full text-xs"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
          >
            <Upload size={12} /> Upload logo
          </button>
          <button
            onClick={handleRefetch}
            disabled={refetching}
            className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 disabled:opacity-50"
          >
            <RefreshCw size={12} className={refetching ? "animate-spin" : ""} /> Refetch
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={handleUpload}
          className="hidden"
        />
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Accent color</span>
          {!colorTouched && (
            <span className="text-[9px] text-emerald-400">auto-extracted</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={colorOverride}
            onChange={(e) => handleColorChange(e.target.value)}
            className="w-10 h-10 rounded cursor-pointer bg-transparent border border-slate-700"
          />
          <input
            type="text"
            value={colorOverride}
            onChange={(e) => handleColorChange(e.target.value)}
            className="input flex-1"
          />
        </div>
        <p className="text-[10px] text-slate-500">
          Sampled from the logo. Used for accents only — ClientLens brand stays dominant.
        </p>
      </div>

      <button
        onClick={handleConfirm}
        disabled={!brandAssets.logo_url}
        className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
      >
        <Check size={14} /> Looks right — run agent council
      </button>
    </div>
  );
}
