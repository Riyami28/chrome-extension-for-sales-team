// End-to-end smoke test: runs the full council pipeline against a stubbed
// Gemini endpoint and verifies it emits stage/agent/done events and produces
// a validated slide deck.
//
// Approach: esbuild-bundles src/shared/agents/council.ts (pure, no chrome.*)
// into an ESM blob, evaluates it with stubbed import.meta.env + globalThis.fetch.

import { build } from "esbuild";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// Output inside the project so Node can resolve node_modules from there.
const tmp = resolve(".smoke-tmp");
import { mkdirSync } from "fs";
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, "entry.mjs");
const out = join(tmp, "bundle.mjs");
const councilPath = resolve("src/shared/agents/council.ts");
const emailCouncilPath = resolve("src/shared/agents/email-council.ts");
const objectionCouncilPath = resolve("src/shared/agents/objection-council.ts");

writeFileSync(
  entry,
  [
    `export { runCouncil, extractJson } from ${JSON.stringify(councilPath)};`,
    `export { runEmailCouncil } from ${JSON.stringify(emailCouncilPath)};`,
    `export { runObjectionCouncil } from ${JSON.stringify(objectionCouncilPath)};`,
  ].join("\n"),
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  absWorkingDir: process.cwd(),
  define: {
    "import.meta.env.VITE_LLM_PROVIDER": '"gemini"',
    "import.meta.env.VITE_GEMINI_API_KEY": '"fake-key"',
    "import.meta.env.VITE_GEMINI_MODEL": '"gemini-2.0-flash"',
  },
  external: ["@anthropic-ai/sdk"],
  logLevel: "error",
});

// --- Fake Gemini endpoint ---------------------------------------------------
const AGENT_RESPONSES = [
  // Call 1 — retrieval
  JSON.stringify({
    relevant_source_ids: ["kb-1"],
    citations: [
      { source_id: "kb-1", quote: "317 rules", claim: "catalog size" },
      { source_id: "kb-1", quote: "up to 60% first-scan savings", claim: "savings" },
      { source_id: "kb-1", quote: "30-day pilot", claim: "pilot" },
    ],
    missing_info: [],
  }),
  // Call 2 — ICP personalization
  JSON.stringify({
    slides: [
      { index: 0, title: "ClientLens for Acme CFO", components: [{ type: "text_block", content: "317 rules · up to 60% · 30-day pilot" }] },
      { index: 1, title: "How it works", components: [{ type: "text_block", content: "Read-only, ISO 27001 + SOC 2 Type II." }] },
      { index: 2, title: "Commercial", components: [{ type: "text_block", content: "Pay on verified savings." }] },
    ],
  }),
  // Call 3 — brand compliance
  JSON.stringify({ pass: true, violations: [], tone_score: 0.9 }),
  // Call 4 — validation
  JSON.stringify({ grounded: true, claims: [], hallucinations: [] }),
];

let responseQueue = [...AGENT_RESPONSES];
function setResponses(list) {
  responseQueue = [...list];
}
globalThis.fetch = async (url) => {
  const u = String(url);
  if (!u.includes("generativelanguage.googleapis.com")) {
    throw new Error(`unexpected fetch: ${u}`);
  }
  const body = responseQueue.shift() ?? AGENT_RESPONSES[0];
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: body }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

// --- Load bundle + run ------------------------------------------------------
const mod = await import(out);
const { runCouncil, extractJson, runEmailCouncil, runObjectionCouncil } = mod;

// --- Unit: extractJson fixtures --------------------------------------------
const fixtures = [
  { name: "fenced json", input: '```json\n{"ok":true,"n":5}\n```', expect: { ok: true, n: 5 } },
  { name: "bare object", input: '{"ok":true,"list":[1,2,3]}', expect: { ok: true, list: [1, 2, 3] } },
  { name: "prose prefix", input: 'Here is the JSON:\n\n{"stage":"done","score":0.9}\n\nThanks!', expect: { stage: "done", score: 0.9 } },
  { name: "nested braces", input: '{"a":{"b":{"c":1}},"d":2}', expect: { a: { b: { c: 1 } }, d: 2 } },
  { name: "string with brace", input: '{"tag":"{not json}","x":1}', expect: { tag: "{not json}", x: 1 } },
  { name: "malformed", input: "not json at all {{{", expect: null },
];
let failed = 0;
for (const f of fixtures) {
  const got = extractJson(f.input);
  const pass = JSON.stringify(got) === JSON.stringify(f.expect);
  console.log(`${pass ? "✅" : "❌"} extractJson: ${f.name}`);
  if (!pass) {
    console.log(`   expected ${JSON.stringify(f.expect)}`);
    console.log(`   got      ${JSON.stringify(got)}`);
    failed++;
  }
}

// --- Integration: full council pipeline ------------------------------------
const events = [];
const gen = runCouncil({
  input: {
    company_name: "Acme",
    persona_role: "CFO",
    deal_size: "mid_market",
    meeting_stage: "discovery",
    clouds: ["aws", "gcp"],
    region: "apac",
    competitor: "cast.ai",
    pain_points: "cloud spend",
  },
  brandAssets: { company_name: "Acme", primary_color: "#0891b2", logo_source: "web" },
  kb: [
    {
      id: "kb-1",
      name: "ClientLens Product Facts",
      namespace: "product_overview",
      source_type: "text",
      content: "ClientLens has 317 rules across AWS+GCP+Azure. Up to 60% savings on first scan. 30-day pilot. ISO 27001 + SOC 2 Type II. Read-only, AES-256-GCM.",
      status: "ready",
      uploaded_by: "test@example.com",
      uploaded_by_role: "admin",
      uploaded_at: new Date().toISOString(),
    },
  ],
  modelOverride: { provider: "gemini", model: "gemini-2.0-flash" },
});

for await (const ev of gen) events.push(ev);

const types = events.map((e) => e.type);
const done = events.find((e) => e.type === "done");
const agentEvents = events.filter((e) => e.type === "agent");
const errorEvent = events.find((e) => e.type === "error");

console.log("\n— council events —");
for (const e of events) {
  if (e.type === "stage") console.log(`  stage    ${e.stage}: ${e.message}`);
  else if (e.type === "agent") console.log(`  agent    ${e.result.agent} → ${e.result.status}`);
  else if (e.type === "retry") console.log(`  retry    attempt ${e.attempt} — ${e.reason}`);
  else if (e.type === "done") console.log(`  done     ${e.pipeline.final_output.slides.length} slides`);
  else if (e.type === "error") console.log(`  error    ${e.message}`);
}

const checks = [
  ["council emits retrieval stage", types.includes("stage")],
  ["all 4 agents ran", agentEvents.length === 4],
  ["no error event", !errorEvent],
  ["done event present", !!done],
  ["slides produced", done?.pipeline?.final_output?.slides?.length === 3],
  ["sources tracked", done?.pipeline?.metadata?.sources_used?.[0] === "kb-1"],
  ["brand_compliant flag", done?.pipeline?.metadata?.brand_compliant === true],
  ["hallucination_check clean", done?.pipeline?.metadata?.hallucination_check === "clean"],
];

console.log("\n— council checks —");
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) failed++;
}

// --- Integration: email council --------------------------------------------
setResponses([
  JSON.stringify({ relevant_source_ids: ["kb-1"] }),
  JSON.stringify({
    subject: "Cut AWS spend 20% in 30 days",
    body: "Hi Priya,\n\nClientLens runs 317 rules across AWS+GCP+Azure and typically surfaces up to 60% savings on the first scan. Read-only, ISO 27001 + SOC 2 Type II. Worth a 30-day pilot?",
    cta: "Open to a 15-min walkthrough next week?",
    tone_notes: "Concrete, CFO-friendly",
    sources_used: ["kb-1"],
  }),
  JSON.stringify({ pass: true, violations: [], tone_score: 0.92 }),
  JSON.stringify({ grounded: true, hallucinations: [] }),
]);

const emailEvents = [];
const emailGen = runEmailCouncil({
  input: {
    recipient_name: "Priya",
    company_name: "Acme",
    persona_role: "CFO",
    intent: "intro",
    context: "Met at KubeCon, AWS-heavy, wants to cut 20%",
  },
  kb: [
    {
      id: "kb-1",
      name: "ClientLens Product Facts",
      namespace: "product_overview",
      source_type: "text",
      content: "317 rules, up to 60% savings, ISO 27001 + SOC 2 Type II, 30-day pilot.",
      status: "ready",
      uploaded_by: "test@example.com",
      uploaded_by_role: "admin",
      uploaded_at: new Date().toISOString(),
    },
  ],
  modelOverride: { provider: "gemini", model: "gemini-2.0-flash" },
});
for await (const ev of emailGen) emailEvents.push(ev);
const emailDone = emailEvents.find((e) => e.type === "done");
const emailError = emailEvents.find((e) => e.type === "error");
const emailAgents = emailEvents.filter((e) => e.type === "agent");

console.log("\n— email council events —");
for (const e of emailEvents) {
  if (e.type === "stage") console.log(`  stage    ${e.stage}: ${e.message}`);
  else if (e.type === "agent") console.log(`  agent    ${e.result.agent} → ${e.result.status}`);
  else if (e.type === "done") console.log(`  done     subject="${e.pipeline.final_output.subject}"`);
  else if (e.type === "error") console.log(`  error    ${e.message}`);
}

const emailChecks = [
  ["email: 4 agents ran", emailAgents.length === 4],
  ["email: no error", !emailError],
  ["email: subject present", !!emailDone?.pipeline?.final_output?.subject],
  ["email: body non-empty", (emailDone?.pipeline?.final_output?.body?.length ?? 0) > 20],
  ["email: brand_compliant", emailDone?.pipeline?.metadata?.brand_compliant === true],
  ["email: sources_used tracked", emailDone?.pipeline?.metadata?.sources_used?.[0] === "kb-1"],
];

console.log("\n— email checks —");
for (const [name, pass] of emailChecks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) failed++;
}

// --- Integration: objection council ----------------------------------------
setResponses([
  JSON.stringify({ relevant_source_ids: ["kb-1"] }),
  JSON.stringify({
    summary: "Cast.ai is compute-only; ClientLens covers 30+ resource types across 3 clouds.",
    response: "Cast.ai handles Kubernetes compute bin-packing well, but ClientLens schedules 30+ resource types (storage, RDS, Redshift, etc.) across AWS/GCP/Azure dependency-aware. Different surface area.",
    citations: [{ source_id: "kb-1", quote: "30+ resource types", claim: "coverage" }],
    confidence: 0.85,
  }),
]);

const objEvents = [];
const objGen = runObjectionCouncil({
  input: { objection_text: "Cast.ai already does this. Why pay again?", competitor_hint: "cast.ai" },
  kb: [
    {
      id: "kb-1",
      name: "Competitor battlecard",
      namespace: "battlecard",
      source_type: "text",
      content: "ClientLens schedules 30+ resource types across AWS/GCP/Azure dependency-aware.",
      status: "ready",
      uploaded_by: "test@example.com",
      uploaded_by_role: "admin",
      uploaded_at: new Date().toISOString(),
    },
  ],
  modelOverride: { provider: "gemini", model: "gemini-2.0-flash" },
});
for await (const ev of objGen) objEvents.push(ev);
const objDone = objEvents.find((e) => e.type === "done");
const objError = objEvents.find((e) => e.type === "error");
const objAgents = objEvents.filter((e) => e.type === "agent");

console.log("\n— objection council events —");
for (const e of objEvents) {
  if (e.type === "stage") console.log(`  stage    ${e.stage}: ${e.message}`);
  else if (e.type === "agent") console.log(`  agent    ${e.result.agent} → ${e.result.status}`);
  else if (e.type === "done") console.log(`  done     conf=${e.response.confidence}`);
  else if (e.type === "error") console.log(`  error    ${e.message}`);
}

const objChecks = [
  ["objection: 2 agents ran", objAgents.length === 2],
  ["objection: no error", !objError],
  ["objection: response non-empty", (objDone?.response?.response?.length ?? 0) > 20],
  ["objection: citations present", (objDone?.response?.citations?.length ?? 0) > 0],
];

console.log("\n— objection checks —");
for (const [name, pass] of objChecks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) failed++;
}

rmSync(tmp, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n❌ ${failed} check(s) failed`);
  process.exit(1);
}
console.log("\n✅ smoke test passed");
