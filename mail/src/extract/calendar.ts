/**
 * Calendar invites (RFC 5545 iCalendar, as sent by Google Calendar, Outlook, Calendly...): the
 * first VEVENT of a text/calendar part, as structured fields. Pure and linear: one pass to unfold
 * lines, one pass over them; property parameters are split with indexOf, and quoted parameter
 * values are honoured without regex backtracking. At most MAX_ICS_CHARS are read and every field
 * is bounded, so a hostile invite costs bounded work and a bounded row.
 *
 * Times: `start` / `end` keep the raw value and TZID; `iso` is filled in for UTC ("...Z") and
 * floating or TZID times are left as given (no time-zone database on Workers), all-day dates
 * become YYYY-MM-DD.
 */

export const MAX_ICS_CHARS = 256 * 1024;
const MAX_FIELD = 1000;
const MAX_DESCRIPTION = 4000;
export const MAX_ATTENDEES = 50;

export interface CalendarTime {
  value: string;
  tzid: string | null;
  all_day: boolean;
  /** ISO 8601 when the value is UTC or a date; null for local times with a TZID. */
  iso: string | null;
}

export interface CalendarPerson {
  email: string | null;
  name: string | null;
  role?: string | null;
  status?: string | null;
  rsvp?: boolean;
}

export interface CalendarInvite {
  /** VCALENDAR METHOD: REQUEST (an invite), CANCEL, REPLY, PUBLISH, ... */
  method: string | null;
  uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  start: CalendarTime | null;
  end: CalendarTime | null;
  status: string | null;
  sequence: number | null;
  organizer: CalendarPerson | null;
  attendees: CalendarPerson[];
  attendees_omitted: number;
}

const clip = (s: string | null | undefined, n = MAX_FIELD) => (s ? s.slice(0, n) : null);

/** RFC 5545 TEXT unescaping: \n, \, \; \\ (one pass). */
function unescapeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      const n = s[++i]!;
      out += n === "n" || n === "N" ? "\n" : n;
    } else out += c;
  }
  return out;
}

/** Unfold (CRLF + space/tab continues the previous line) and split. */
function unfold(text: string): string[] {
  const src = text.length > MAX_ICS_CHARS ? text.slice(0, MAX_ICS_CHARS) : text;
  const lines: string[] = [];
  let cur = "";
  for (const raw of src.split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length + (cur ? 1 : 0) > 0) cur += raw.slice(1);
    else {
      if (cur) lines.push(cur);
      cur = raw;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** "NAME;P1=a;P2=\"b:c\":value" -> name, params, value. The first ":" outside quotes ends the parameters. */
export function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 34) quoted = !quoted;
    else if (c === 58 && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let start = 0;
  quoted = false;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 34) quoted = !quoted;
    else if (c === 59 && !quoted) {
      parts.push(head.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(head.slice(start));
  const params: Record<string, string> = {};
  for (const p of parts.slice(1, 21)) {
    const eq = p.indexOf("=");
    if (eq > 0)
      params[p.slice(0, eq).toUpperCase()] = p
        .slice(eq + 1)
        .replace(/^"|"$/g, "")
        .slice(0, MAX_FIELD);
  }
  return { name: (parts[0] ?? "").toUpperCase(), params, value };
}

function time(value: string, params: Record<string, string>): CalendarTime {
  const v = value.trim().slice(0, 40);
  const tzid = params.TZID ? clip(params.TZID, 100) : null;
  const allDay = params.VALUE === "DATE" || /^\d{8}$/.test(v);
  let iso: string | null = null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (m) {
    if (!m[4]) iso = `${m[1]}-${m[2]}-${m[3]}`;
    else if (m[7]) iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  }
  return { value: v, tzid, all_day: allDay, iso };
}

function person(value: string, params: Record<string, string>): CalendarPerson {
  const v = value.trim();
  const email = /^mailto:/i.test(v)
    ? v.slice(7).trim().toLowerCase().slice(0, 320)
    : v.includes("@")
      ? v.toLowerCase().slice(0, 320)
      : null;
  return { email, name: params.CN ? clip(unescapeText(params.CN), 200) : null };
}

/** The first VEVENT of an iCalendar text, or null when there is none. Pure, linear. */
export function parseIcs(text: string | null | undefined): CalendarInvite | null {
  if (!text || !text.includes("BEGIN:VEVENT")) return null;
  const ev: CalendarInvite = {
    method: null,
    uid: null,
    summary: null,
    description: null,
    location: null,
    url: null,
    start: null,
    end: null,
    status: null,
    sequence: null,
    organizer: null,
    attendees: [],
    attendees_omitted: 0,
  };
  let depth = 0; // nesting inside the first VEVENT (VALARM etc.)
  let inEvent = false;
  let done = false;
  for (const line of unfold(text)) {
    if (done) break;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      if (p.value.trim().toUpperCase() === "VEVENT" && !inEvent) inEvent = true;
      else if (inEvent) depth++;
      continue;
    }
    if (p.name === "END") {
      if (inEvent && depth > 0) depth--;
      else if (inEvent && p.value.trim().toUpperCase() === "VEVENT") done = true;
      continue;
    }
    if (!inEvent) {
      if (p.name === "METHOD") ev.method = clip(p.value.trim().toUpperCase(), 40);
      continue;
    }
    if (depth > 0) continue; // inside a VALARM
    switch (p.name) {
      case "UID":
        ev.uid = clip(p.value.trim());
        break;
      case "SUMMARY":
        ev.summary = clip(unescapeText(p.value));
        break;
      case "DESCRIPTION":
        ev.description = clip(unescapeText(p.value), MAX_DESCRIPTION);
        break;
      case "LOCATION":
        ev.location = clip(unescapeText(p.value));
        break;
      case "URL":
        ev.url = clip(p.value.trim(), 2000);
        break;
      case "STATUS":
        ev.status = clip(p.value.trim().toUpperCase(), 40);
        break;
      case "SEQUENCE": {
        const n = Number(p.value.trim());
        ev.sequence = Number.isInteger(n) ? n : null;
        break;
      }
      case "DTSTART":
        ev.start = time(p.value, p.params);
        break;
      case "DTEND":
        ev.end = time(p.value, p.params);
        break;
      case "ORGANIZER":
        ev.organizer = person(p.value, p.params);
        break;
      case "ATTENDEE":
        if (ev.attendees.length >= MAX_ATTENDEES) ev.attendees_omitted++;
        else
          ev.attendees.push({
            ...person(p.value, p.params),
            role: p.params.ROLE ? clip(p.params.ROLE, 40) : null,
            status: p.params.PARTSTAT ? clip(p.params.PARTSTAT, 40) : null,
            rsvp: (p.params.RSVP ?? "").toUpperCase() === "TRUE",
          });
        break;
    }
  }
  return inEvent ? ev : null;
}
