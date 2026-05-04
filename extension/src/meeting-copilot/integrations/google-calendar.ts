// Lightweight Google Calendar reader. Reuses chrome.identity.getAuthToken
// (Google OAuth is already configured in manifest.json). The calendar
// readonly scope must be appended in manifest.json oauth2.scopes.

import type { CalendarAttendee, CalendarEvent, MeetingPlatform } from "../../shared/types";

const BASE = "https://www.googleapis.com/calendar/v3";

async function getToken(opts?: { interactive?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: opts?.interactive ?? true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "no token"));
      } else {
        resolve(typeof token === "string" ? token : (token as { token: string }).token);
      }
    });
  });
}

/** Pull the calendar event whose hangoutLink/description references this Meet
 *  URL. Used to auto-seed session input (company / agenda / attendees) when
 *  the rep starts the copilot from inside a Meet tab. Returns null if there's
 *  no token (calendar not connected) or no match — caller falls back to
 *  Meet-tab DOM heuristics. Always non-interactive: never prompt mid-call. */
export async function findCurrentMeetingFromCalendar(meetUrl: string): Promise<CalendarEvent | null> {
  let token: string;
  try { token = await getToken({ interactive: false }); } catch { return null; }

  const meetCode = meetUrl.match(/meet\.google\.com\/([a-z-]+)/i)?.[1];
  if (!meetCode) return null;

  // Look 2h back / 8h forward — covers running-late and back-to-back.
  const timeMin = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  const params = new URLSearchParams({
    timeMin, timeMax, maxResults: "30",
    singleEvents: "true", orderBy: "startTime",
  });

  let res: Response;
  try {
    res = await fetch(`${BASE}/calendars/primary/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch { return null; }
  if (!res.ok) return null;
  const body = await res.json();
  const events = (body.items || []) as RawEvent[];

  const match = events.find((e) => {
    if (e.hangoutLink?.includes(meetCode)) return true;
    const blob = `${e.location || ""} ${e.description || ""}`;
    return blob.includes(meetCode);
  });
  if (!match) return null;

  const det = detectPlatform(match);
  return {
    id: match.id,
    provider: "google",
    title: match.summary || "Untitled",
    description: match.description,
    start: match.start?.dateTime || match.start?.date || "",
    end: match.end?.dateTime || match.end?.date || "",
    meeting_url: det.url,
    platform: det.platform,
    attendees: (match.attendees || []).map((a) => ({
      email: a.email,
      name: a.displayName,
      domain: a.email.split("@")[1],
      is_organizer: a.organizer,
      response_status: a.responseStatus as CalendarAttendee["response_status"],
    })),
    organizer_email: match.organizer?.email,
  };
}

/** Trigger a one-time interactive Google sign-in to grab the calendar
 *  scope. Settings panel calls this when the user clicks "Connect Calendar". */
export async function connectCalendarInteractive(): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const token = await getToken({ interactive: true });
    // Sanity-check the token gets us at least one event listing.
    const res = await fetch(`${BASE}/users/me/calendarList?maxResults=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: `Calendar API ${res.status}` };
    const body = await res.json();
    const email = body.items?.[0]?.id;
    return { ok: true, email };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function detectPlatform(event: { hangoutLink?: string; location?: string; description?: string }): {
  url?: string;
  platform: MeetingPlatform;
} {
  if (event.hangoutLink) return { url: event.hangoutLink, platform: "google_meet" };
  const blob = `${event.location || ""} ${event.description || ""}`;
  const meet = blob.match(/https:\/\/meet\.google\.com\/[a-z-]+/i)?.[0];
  if (meet) return { url: meet, platform: "google_meet" };
  const zoom = blob.match(/https:\/\/[^\s"]*zoom\.us\/j\/[^\s"<]+/i)?.[0];
  if (zoom) return { url: zoom, platform: "zoom_web" };
  const teams = blob.match(/https:\/\/teams\.microsoft\.com\/[^\s"<]+/i)?.[0];
  if (teams) return { url: teams, platform: "teams_web" };
  return { platform: "other" };
}

interface RawEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  hangoutLink?: string;
  attendees?: { email: string; displayName?: string; organizer?: boolean; responseStatus?: string }[];
  organizer?: { email?: string };
}

export async function listUpcomingMeetings(options?: { maxResults?: number; lookaheadHours?: number }): Promise<CalendarEvent[]> {
  const token = await getToken();
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + (options?.lookaheadHours || 48) * 3600 * 1000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(options?.maxResults ?? 20),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const res = await fetch(`${BASE}/calendars/primary/events?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Calendar API ${res.status}`);
  const body = await res.json();
  const events = (body.items || []) as RawEvent[];

  return events
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e): CalendarEvent => {
      const det = detectPlatform(e);
      const attendees: CalendarAttendee[] = (e.attendees || []).map((a) => ({
        email: a.email,
        name: a.displayName,
        domain: a.email.split("@")[1],
        is_organizer: a.organizer,
        response_status: a.responseStatus as CalendarAttendee["response_status"],
      }));
      return {
        id: e.id,
        provider: "google",
        title: e.summary || "Untitled",
        description: e.description,
        start: e.start!.dateTime!,
        end: e.end!.dateTime!,
        meeting_url: det.url,
        platform: det.platform,
        attendees,
        organizer_email: e.organizer?.email,
      };
    });
}
