import React, { useEffect, useMemo, useState } from "react";
import { useMeetingCopilotStore } from "../stores/meeting-copilot-store";
import { useAppStore } from "../stores/app-store";
import { listKB } from "../../shared/utils/kb-storage";
import type {
  AgendaItem,
  KBEntry,
  MeetingSessionInput,
  TranscriptSegment,
} from "../../shared/types";
import { generatePostCallSummary } from "../../meeting-copilot/agents/post-call-summary";
import { runLiveKbAsk } from "../../meeting-copilot/agents/live-agents";
import { startLiveOrchestrator, stopLiveOrchestrator } from "../../meeting-copilot/agents/live-orchestrator";
import { connectCalendarInteractive } from "../../meeting-copilot/integrations/google-calendar";
import {
  getSettings,
  saveSessionToHistory,
  listSessionHistory,
  type StoredSessionSummary,
} from "../../shared/utils/settings-storage";
import { pushZohoNote, pushCustomTool } from "../../shared/utils/integrations";
import { parsePastedInvite } from "../../shared/utils/meeting-parse";
import { CopyButton } from "./CopyButton";
import type { MeetingPostCallSummary } from "../../shared/types";

// Three onboarding paths into a copilot session, in priority order:
//   1. Connect Google Calendar — auto-fills from the matching invite.
//   2. Paste meeting URL / invite text — LLM extracts company/agenda/notes.
//   3. Fill the form manually — fallback when the paste yields nothing.
// All three populate the same downstream state, so live agents don't care
// which path the user took.

const NEW_ITEM_TEMPLATE = (): AgendaItem => ({
  id: `agenda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  title: "",
  priority: "should_cover",
  status: "pending",
});

export function MeetingCopilotPanel() {
  const session = useMeetingCopilotStore((s) => s.session);
  const prepareSession = useMeetingCopilotStore((s) => s.prepareSession);
  const setStatus = useMeetingCopilotStore((s) => s.setStatus);
  const resetSession = useMeetingCopilotStore((s) => s.resetSession);

  const appendTranscript = useMeetingCopilotStore((s) => s.appendTranscript);
  const setSummary = useMeetingCopilotStore((s) => s.setSummary);
  const summary = useMeetingCopilotStore((s) => s.lastSummary);

  const [kbEntries, setKbEntries] = useState<KBEntry[]>([]);
  const company = useAppStore((s) => s.company);
  const [history, setHistory] = useState<StoredSessionSummary[]>([]);
  const [pushStatus, setPushStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [transponderStatus, setTransponderStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<{ connected: boolean; email?: string; error?: string } | null>(() => {
    try {
      const raw = localStorage.getItem("clientlens_calendar_status_v1");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  const [calendarBusy, setCalendarBusy] = useState(false);

  async function handleConnectCalendar() {
    setCalendarBusy(true);
    const res = await connectCalendarInteractive();
    const next = { connected: res.ok, email: res.email, error: res.error };
    setCalendarStatus(next);
    try { localStorage.setItem("clientlens_calendar_status_v1", JSON.stringify(next)); } catch { /* noop */ }
    setCalendarBusy(false);
  }

  useEffect(() => { void listKB().then(setKbEntries).catch(() => setKbEntries([])); }, []);
  useEffect(() => { setHistory(listSessionHistory()); }, [summary]);

  useEffect(() => {
    const listener = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type: string; session_id?: string; payload?: unknown };
      if (m.type === "MC_TRANSCRIPT_APPEND") {
        appendTranscript(m.payload as TranscriptSegment);
      } else if (m.type === "MC_ASK_KB") {
        const askPayload = m.payload as { question?: string; id?: string };
        const question = askPayload?.question || "";
        const askId = askPayload?.id;
        const currentSession = useMeetingCopilotStore.getState().session;
        if (!currentSession) return;
        void runLiveKbAsk(question, currentSession, kbEntries).then((ans) => {
          // Echo the question id back so the transponder can match this
          // answer to the right thread entry — necessary because the rep
          // may have already cancelled it by asking another question.
          const out = { ...ans, id: askId };
          chrome.runtime.sendMessage({ type: "MC_KB_ANSWER", payload: out }).catch(() => { /* noop */ });
          const tabId = currentSession.tab_id;
          if (tabId) {
            chrome.tabs.sendMessage(tabId, { type: "MC_KB_ANSWER", payload: out }).catch(() => { /* noop */ });
          }
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [appendTranscript, kbEntries]);

  const [companyName, setCompanyName] = useState(company?.name || "");
  const [personaRole, setPersonaRole] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingNotes, setMeetingNotes] = useState("");
  const [agenda, setAgenda] = useState<AgendaItem[]>([]);

  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteStatus, setPasteStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [showManualFields, setShowManualFields] = useState(true);

  const [urlBusy, setUrlBusy] = useState(false);
  const [urlStatus, setUrlStatus] = useState<{ ok: boolean; detail: string } | null>(null);

  async function handleLookupUrl() {
    const url = meetingUrl.trim();
    if (!url) return;
    setUrlBusy(true);
    setUrlStatus(null);
    try {
      const parsed = await parsePastedInvite(
        `This is a meeting link the rep is about to join. From the URL alone, infer whatever you can about the meeting — calendar event ID, Zoom/Meet platform, anything in the slug. Do not invent company or agenda details that aren't visible in the URL. URL: ${url}`,
      );
      const filled: string[] = [];
      if (parsed.company_name && !companyName.trim()) { setCompanyName(parsed.company_name); filled.push("company"); }
      if (parsed.persona_role && !personaRole.trim()) { setPersonaRole(parsed.persona_role); filled.push("persona"); }
      if (parsed.meeting_title && !meetingTitle.trim()) { setMeetingTitle(parsed.meeting_title); filled.push("title"); }
      if (parsed.meeting_notes && !meetingNotes.trim()) { setMeetingNotes(parsed.meeting_notes); filled.push("notes"); }
      if (filled.length === 0) {
        setUrlStatus({
          ok: false,
          detail: "Bare meeting URLs usually don't carry context. Fill the fields below — the URL is still saved as call context.",
        });
      } else {
        setUrlStatus({ ok: true, detail: `Filled ${filled.join(", ")} from the URL. Edit anything you want, then start.` });
      }
    } catch (err) {
      setUrlStatus({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setUrlBusy(false);
    }
  }

  async function handleParsePaste() {
    const text = pasteText.trim();
    if (!text) return;
    setPasteBusy(true);
    setPasteStatus(null);
    try {
      const parsed = await parsePastedInvite(text);
      const filled: string[] = [];
      if (parsed.company_name) { setCompanyName(parsed.company_name); filled.push("company"); }
      if (parsed.persona_role) { setPersonaRole(parsed.persona_role); filled.push("persona"); }
      if (parsed.meeting_title) { setMeetingTitle(parsed.meeting_title); filled.push("title"); }
      if (parsed.meeting_notes) { setMeetingNotes(parsed.meeting_notes); filled.push("notes"); }
      if (parsed.agenda?.length) { setAgenda(parsed.agenda); filled.push(`${parsed.agenda.length} agenda item${parsed.agenda.length === 1 ? "" : "s"}`); }
      if (filled.length === 0) {
        setPasteStatus({
          ok: false,
          detail: "Couldn't extract anything from that. If it's just a Meet/Calendar URL, paste the invite body too — or fill the fields manually.",
        });
        setShowManualFields(true);
      } else {
        setPasteStatus({ ok: true, detail: `Filled ${filled.join(", ")}. Review below and start.` });
        setShowManualFields(true);
      }
    } catch (err) {
      setPasteStatus({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setPasteBusy(false);
    }
  }

  function updateAgendaItem(id: string, patch: Partial<AgendaItem>) {
    setAgenda((items) => items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }
  function addAgendaItem() {
    setAgenda((items) => [...items, NEW_ITEM_TEMPLATE()]);
  }
  function removeAgendaItem(id: string) {
    setAgenda((items) => items.filter((it) => it.id !== id));
  }

  async function startSession() {
    const url = meetingUrl.trim();
    const noteParts = [meetingNotes.trim(), url ? `Meeting link: ${url}` : ""].filter(Boolean);
    const mergedNotes = noteParts.join("\n\n");

    const input: MeetingSessionInput = {
      company_name: companyName,
      persona_role: personaRole,
      agenda: agenda.filter((a) => a.title.trim().length > 0),
      meeting_title: meetingTitle || undefined,
      meeting_notes: mergedNotes || undefined,
    };

    const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
    const meetTab = tabs[0];
    prepareSession(input, meetTab?.id);
    setStatus("listening");
    startLiveOrchestrator(() => kbEntries);

    await chrome.runtime.sendMessage({
      type: "MC_START_SESSION",
      session_id: useMeetingCopilotStore.getState().session?.id,
      tabId: meetTab?.id,
      payload: { input },
    });

    if (!meetTab?.id) {
      setTransponderStatus({
        ok: false,
        detail: "No Google Meet tab open. Open one and click Start again — copilot still runs in this panel.",
      });
      return;
    }
    await openTransponderOnTab(meetTab.id, {
      status: "listening",
      input,
      agenda: input.agenda,
    });
  }

  async function openTransponderOnTab(tabId: number, payload: Record<string, unknown>) {
    setTransponderStatus(null);
    const send = () =>
      chrome.tabs.sendMessage(tabId, { type: "MC_TRANSPONDER_OPEN", payload });

    // 1) Try the existing listener first.
    try {
      await send();
      setTransponderStatus({ ok: true, detail: "Transponder opened on the Meet tab." });
      return;
    } catch {
      /* fall through to inject */
    }

    // 2) Inject the content script (Chrome doesn't auto-inject into tabs that
    //    were already open when the extension was reloaded). Then retry with
    //    a few short delays — listener registration is async after injection.
    let injectErr: unknown = null;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["meet-transponder.js"],
      });
    } catch (err) {
      injectErr = err;
    }

    // Retry send with backoff. Each iteration waits, then attempts.
    const delays = [120, 250, 500, 800];
    for (const d of delays) {
      await new Promise((r) => setTimeout(r, d));
      try {
        await send();
        setTransponderStatus({ ok: true, detail: "Transponder injected and opened." });
        return;
      } catch {
        /* try next delay */
      }
    }

    setTransponderStatus({
      ok: false,
      detail: `Couldn't open transponder on the Meet tab. Try refreshing the Meet tab. ${
        injectErr ? `(inject: ${injectErr instanceof Error ? injectErr.message : String(injectErr)})` : ""
      }`.trim(),
    });
  }

  async function stopSession() {
    stopLiveOrchestrator();
    const finalSession = useMeetingCopilotStore.getState().session;
    await chrome.runtime.sendMessage({ type: "MC_STOP_SESSION" }).catch(() => { /* noop */ });
    if (finalSession && finalSession.transcript.length > 0) {
      setStatus("ended");
      const s = await generatePostCallSummary(
        { ...finalSession, status: "ended" },
        kbEntries,
      );
      setSummary(s);
      saveSessionToHistory({
        id: finalSession.id,
        saved_at: new Date().toISOString(),
        company: finalSession.input.company_name,
        persona: finalSession.input.persona_role,
        headline: s.headline,
        summary_markdown: summaryToMarkdown(s, finalSession.input.company_name, finalSession.input.persona_role),
      });
    } else {
      resetSession();
    }
  }

  async function handleDownloadMD() {
    if (!summary) return;
    const md = summaryToMarkdown(summary, companyName, personaRole);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clientlens-${(companyName || "call").replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handlePushCRM() {
    if (!summary) return;
    setPushBusy(true);
    setPushStatus(null);
    try {
      const s = getSettings();
      const zoho = s.integrations.zoho;
      const custom = s.integrations.customTool;
      const noteTitle = `ClientLens call · ${companyName}`;
      const noteContent = summaryToMarkdown(summary, companyName, personaRole);
      if (zoho.connected && zoho.pushEnabled && zoho.fields.parentModule && zoho.fields.parentId) {
        const res = await pushZohoNote(zoho, {
          parentModule: zoho.fields.parentModule,
          parentId: zoho.fields.parentId,
          title: noteTitle,
          content: noteContent,
        });
        setPushStatus(res);
      } else if (custom.connected && custom.pushEnabled && custom.fields.pushUrl) {
        const res = await pushCustomTool(custom, {
          type: "meeting_summary",
          company: companyName,
          persona: personaRole,
          headline: summary.headline,
          markdown: noteContent,
          summary,
        });
        setPushStatus(res);
      } else {
        setPushStatus({
          ok: false,
          detail: "No CRM configured. Open Settings → add Zoho (with parent module/ID) or a custom push URL.",
        });
      }
    } catch (err) {
      setPushStatus({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setPushBusy(false);
    }
  }

  const isLive = session?.status === "listening" || session?.status === "paused";
  const readyToStart = companyName.trim() && personaRole.trim();

  const agendaCoverage = useMemo(() => {
    if (!session) return null;
    const total = session.agenda.length;
    const covered = session.agenda.filter((a) => a.status === "covered").length;
    return { total, covered };
  }, [session]);

  return (
    <div style={wrap}>
      <div style={header}>
        <div style={dot(isLive ? "#7FB236" : "#5A5A62")} />
        <span style={kicker}>Meeting copilot {isLive ? "— live" : "— pre-call"}</span>
      </div>

      <div style={infoBox}>
        Fill in the details below and click <strong style={{ color: "#F0EBDB" }}>Start live copilot</strong>.
        If a Google Meet tab is open, the on-screen transponder will attach to it automatically.
        Otherwise the copilot runs in this panel and uses the mock transcript stream.
      </div>

      <div style={calendarBox}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div>
            <div style={{ fontSize: 12, color: "#F0EBDB", fontWeight: 600 }}>
              Google Calendar {calendarStatus?.connected ? "· connected" : ""}
            </div>
            <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>
              {calendarStatus?.connected
                ? `Auto-fills company, agenda, attendees from the matching invite. Manual fields below override.`
                : `Connect once to auto-fill prospect/agenda from the calendar invite when you click Start copilot in Meet.`}
            </div>
            {calendarStatus?.error && (
              <div style={{ ...muted, fontSize: 11, color: "#E05A4B", marginTop: 2 }}>
                {calendarStatus.error}
              </div>
            )}
          </div>
          <button style={ghostBtn} onClick={handleConnectCalendar} disabled={calendarBusy}>
            {calendarBusy ? "…" : calendarStatus?.connected ? "Re-link" : "Connect"}
          </button>
        </div>
      </div>

      <div style={section}>
        <div style={sectionHead}>
          <span>Paste meeting URL or invite</span>
          <span style={optional}>fastest path</span>
        </div>
        <div style={muted}>
          Paste a calendar event URL, .ics body, or the raw invite text — we'll auto-fill prospect, title, notes, and agenda.
          A bare Meet URL alone won't have enough context, so include the invite body if you can.
        </div>
        <textarea
          style={{ ...input, minHeight: 80, resize: "vertical" }}
          placeholder="https://calendar.google.com/event?eid=… or paste the invite body here"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            style={{ ...ghostBtn, opacity: pasteText.trim() && !pasteBusy ? 1 : 0.4 }}
            disabled={!pasteText.trim() || pasteBusy}
            onClick={handleParsePaste}
          >
            {pasteBusy ? "Parsing…" : "Parse & fill fields"}
          </button>
          <button style={ghostBtn} onClick={() => setShowManualFields((v) => !v)}>
            {showManualFields ? "Hide manual fields" : "Fill manually"}
          </button>
        </div>
        {pasteStatus && (
          <div
            style={{
              ...muted,
              fontSize: 11,
              color: pasteStatus.ok ? "#7FB236" : "#E05A4B",
            }}
          >
            {pasteStatus.detail}
          </div>
        )}
      </div>

      {!isLive && !summary && history.length > 0 && (
        <div style={section}>
          <div style={sectionHead}><span>Recent calls</span></div>
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
            {history.slice(0, 6).map((h) => (
              <button
                key={h.id}
                style={historyChip}
                title={`${h.headline}\n— saved ${new Date(h.saved_at).toLocaleString()}`}
                onClick={() => {
                  setCompanyName(h.company);
                  setPersonaRole(h.persona);
                  setMeetingNotes(h.summary_markdown);
                }}
              >
                <div style={{ fontSize: 12, color: "#F0EBDB", fontWeight: 600, textAlign: "left" }}>{h.company || "—"}</div>
                <div style={{ fontSize: 10, color: "#A8A195", textAlign: "left", marginTop: 2 }}>
                  {h.persona || "—"}
                </div>
                <div style={{ fontSize: 10, color: "#7FB236", marginTop: 4, textAlign: "left", lineHeight: 1.3 }}>
                  {h.headline.slice(0, 60)}{h.headline.length > 60 ? "…" : ""}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {showManualFields && (
        <>
          <div style={section}>
            <div style={sectionHead}><span>Prospect</span></div>
            <input style={input} placeholder="Company name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            <input style={{ ...input, marginTop: 6 }} placeholder="Persona role (e.g. CFO, VP Eng)" value={personaRole} onChange={(e) => setPersonaRole(e.target.value)} />
            <div style={{ display: "flex", gap: 6, alignItems: "stretch", marginTop: 6 }}>
              <input
                style={{ ...input, flex: 1 }}
                placeholder="Meeting link (Meet / Zoom / calendar event URL)"
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
              />
              <button
                style={{ ...ghostBtn, opacity: meetingUrl.trim() && !urlBusy ? 1 : 0.4 }}
                disabled={!meetingUrl.trim() || urlBusy}
                onClick={handleLookupUrl}
                title="Try to infer details from this meeting link"
              >
                {urlBusy ? "…" : "Look up"}
              </button>
            </div>
            {urlStatus && (
              <div style={{ ...muted, fontSize: 11, color: urlStatus.ok ? "#7FB236" : "#E05A4B" }}>
                {urlStatus.detail}
              </div>
            )}
          </div>

          <div style={section}>
            <div style={sectionHead}><span>Meeting context</span><span style={optional}>optional</span></div>
            <input
              style={input}
              placeholder="Meeting title (e.g. Q2 roadmap review with Acme)"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
            />
            <textarea
              style={{ ...input, marginTop: 6, minHeight: 72, resize: "vertical" }}
              placeholder="Any context you want the copilot to know — last call outcome, objections raised, key stakeholders, CRM notes you want to paste in."
              value={meetingNotes}
              onChange={(e) => setMeetingNotes(e.target.value)}
            />
          </div>

          <div style={section}>
            <div style={sectionHead}>
              <span>Agenda</span>
              <button style={ghostBtn} onClick={addAgendaItem}>+ Add</button>
            </div>
            {!agenda.length && <div style={muted}>Add the 3–5 things you must cover. The agenda tracker will mark each one as you go.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agenda.map((item) => (
                <div key={item.id} style={agendaRow}>
                  <input style={{ ...input, flex: 1 }} placeholder="Agenda item" value={item.title} onChange={(e) => updateAgendaItem(item.id, { title: e.target.value })} />
                  <select style={select} value={item.priority} onChange={(e) => updateAgendaItem(item.id, { priority: e.target.value as AgendaItem["priority"] })}>
                    <option value="must_cover">Must</option>
                    <option value="should_cover">Should</option>
                    <option value="nice_to_have">Nice</option>
                  </select>
                  <button style={xBtn} onClick={() => removeAgendaItem(item.id)}>×</button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div style={section}>
        {!isLive ? (
          <button style={{ ...primaryBtn, opacity: readyToStart ? 1 : 0.4 }} disabled={!readyToStart} onClick={startSession}>
            Start live copilot
          </button>
        ) : (
          <button style={primaryBtn} onClick={stopSession}>End session &amp; summarize</button>
        )}
        {transponderStatus && (
          <div
            style={{
              ...muted,
              fontSize: 11,
              marginTop: 8,
              color: transponderStatus.ok ? "#7FB236" : "#E05A4B",
            }}
          >
            {transponderStatus.detail}
          </div>
        )}
        {session && (
          <div style={{ marginTop: 10 }}>
            <div style={muted}>Session: {session.status}{session.error ? ` · ${session.error}` : ""}</div>
            {agendaCoverage && (
              <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
                Agenda: {agendaCoverage.covered}/{agendaCoverage.total} covered
              </div>
            )}
            <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
              Transcript segments: {session.transcript.length}
            </div>
          </div>
        )}
      </div>

      {summary && (
        <div style={section}>
          <div style={sectionHead}>
            <span>Post-call summary</span>
            <div style={{ display: "flex", gap: 6 }}>
              <CopyButton text={summaryToMarkdown(summary, companyName, personaRole)} label="Copy MD" />
              <button style={ghostBtn} onClick={handleDownloadMD}>Download .md</button>
              <button style={ghostBtn} onClick={handlePushCRM} disabled={pushBusy}>
                {pushBusy ? "Pushing…" : "Push CRM note"}
              </button>
            </div>
          </div>
          {pushStatus && (
            <div
              style={{
                ...muted,
                color: pushStatus.ok ? "#7FB236" : "#E05A4B",
                fontSize: 11,
              }}
            >
              {pushStatus.detail}
            </div>
          )}
          <div style={crmBox}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
              <div style={{ fontWeight: 600 }}>{summary.headline}</div>
              <CopyButton text={summary.headline} label="Copy" />
            </div>
            {summary.what_went_well.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={kicker}>What went well</div>
                <ul style={bullets}>{summary.what_went_well.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {summary.what_to_improve.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={kicker}>What to improve</div>
                <ul style={bullets}>{summary.what_to_improve.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {summary.action_items.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={kicker}>Action items</div>
                <ul style={bullets}>{summary.action_items.map((a, i) => <li key={i}>[{a.owner}] {a.text}{a.due ? ` · due ${a.due}` : ""}</li>)}</ul>
              </div>
            )}
            {summary.suggested_followup_email && (
              <div style={{ marginTop: 10, borderTop: "1px dashed #2A2A34", paddingTop: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={kicker}>Suggested follow-up email</div>
                  <CopyButton
                    text={`Subject: ${summary.suggested_followup_email.subject}\n\n${summary.suggested_followup_email.body}`}
                    label="Copy email"
                  />
                </div>
                <div style={{ fontWeight: 600 }}>{summary.suggested_followup_email.subject}</div>
                <pre style={pre}>{summary.suggested_followup_email.body}</pre>
              </div>
            )}
            {summary.suggested_crm_note && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={kicker}>Suggested CRM note</div>
                  <CopyButton text={summary.suggested_crm_note} label="Copy note" />
                </div>
                <pre style={pre}>{summary.suggested_crm_note}</pre>
              </div>
            )}
          </div>
          <button style={ghostBtn} onClick={resetSession}>Start new session</button>
        </div>
      )}
    </div>
  );
}

const wrap: React.CSSProperties = {
  background: "#0E0E12",
  border: "1px solid #2A2A34",
  borderRadius: 0,
  color: "#F0EBDB",
  fontFamily: "'Space Grotesk', system-ui, sans-serif",
  letterSpacing: "-0.02em",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const header: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const infoBox: React.CSSProperties = {
  background: "#15151A",
  border: "1px solid #2A2A34",
  borderLeft: "2px solid #F58549",
  padding: "10px 12px",
  fontSize: 12,
  color: "#A8A195",
  lineHeight: 1.55,
};

const calendarBox: React.CSSProperties = {
  background: "#15151A",
  border: "1px solid #2A2A34",
  borderLeft: "2px solid #2A4494",
  padding: "10px 12px",
};

const kicker: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#A8A195",
};

const dot = (color: string): React.CSSProperties => ({
  width: 8,
  height: 8,
  background: color,
  display: "inline-block",
});

const section: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const sectionHead: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase",
  color: "#D4CDB5",
};

const optional: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#5A5A62",
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};

const muted: React.CSSProperties = { color: "#A8A195", fontSize: 12, lineHeight: 1.55 };

const input: React.CSSProperties = {
  background: "#060608",
  border: "1px solid #2A2A34",
  borderRadius: 0,
  color: "#F0EBDB",
  padding: "8px 10px",
  fontFamily: "inherit",
  fontSize: 13,
  width: "100%",
};

const select: React.CSSProperties = {
  ...input,
  padding: "8px",
  width: 70,
};

const crmBox: React.CSSProperties = {
  background: "#15151A",
  border: "1px solid #2A2A34",
  padding: "10px 12px",
  fontSize: 12,
};

const agendaRow: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };

const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3A3A46",
  color: "#D4CDB5",
  padding: "4px 10px",
  fontSize: 11,
  fontFamily: "inherit",
  cursor: "pointer",
  letterSpacing: "0.04em",
};

const primaryBtn: React.CSSProperties = {
  background: "#F58549",
  color: "#0A0A0A",
  border: 0,
  padding: "10px 16px",
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  boxShadow: "0 8px 0 -4px #F58549",
  width: "100%",
};

const xBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3A3A46",
  color: "#A8A195",
  padding: "0 8px",
  cursor: "pointer",
  fontSize: 14,
};

const bullets: React.CSSProperties = {
  margin: "4px 0 0 16px",
  padding: 0,
  color: "#D4CDB5",
  fontSize: 12,
  lineHeight: 1.55,
};

const pre: React.CSSProperties = {
  margin: "4px 0 0",
  padding: "8px 10px",
  background: "#060608",
  border: "1px solid #2A2A34",
  color: "#D4CDB5",
  fontSize: 11,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const historyChip: React.CSSProperties = {
  background: "#15151A",
  border: "1px solid #2A2A34",
  padding: "8px 10px",
  minWidth: 160,
  maxWidth: 220,
  cursor: "pointer",
  fontFamily: "inherit",
  textAlign: "left",
  flexShrink: 0,
};

function summaryToMarkdown(
  s: MeetingPostCallSummary,
  company: string,
  persona: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${s.headline}`);
  lines.push("");
  lines.push(`**Company:** ${company || "—"}`);
  lines.push(`**Persona:** ${persona || "—"}`);
  lines.push(`**Generated:** ${new Date(s.generated_at).toLocaleString()}`);
  lines.push("");
  if (s.what_went_well.length) {
    lines.push("## What went well");
    s.what_went_well.forEach((x) => lines.push(`- ${x}`));
    lines.push("");
  }
  if (s.what_to_improve.length) {
    lines.push("## What to improve");
    s.what_to_improve.forEach((x) => lines.push(`- ${x}`));
    lines.push("");
  }
  if (s.objections_raised?.length) {
    lines.push("## Objections raised");
    s.objections_raised.forEach((o) => lines.push(`- **[${o.response_quality}]** ${o.objection}`));
    lines.push("");
  }
  if (s.action_items.length) {
    lines.push("## Action items");
    s.action_items.forEach((a) => lines.push(`- [${a.owner}] ${a.text}${a.due ? ` — due ${a.due}` : ""}`));
    lines.push("");
  }
  if (s.agenda_coverage?.length) {
    lines.push("## Agenda coverage");
    s.agenda_coverage.forEach((a) => lines.push(`- ${a.status.toUpperCase()} — ${a.item}`));
    lines.push("");
  }
  if (s.suggested_followup_email) {
    lines.push("## Suggested follow-up email");
    lines.push(`**Subject:** ${s.suggested_followup_email.subject}`);
    lines.push("");
    lines.push(s.suggested_followup_email.body);
    lines.push("");
  }
  if (s.suggested_crm_note) {
    lines.push("## Suggested CRM note");
    lines.push(s.suggested_crm_note);
  }
  return lines.join("\n");
}
