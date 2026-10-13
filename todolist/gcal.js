// Tiny read-only Google Calendar helper for the Day column - zero-dependency
// JS using global fetch, same style as notion.js. Auth is a stored OAuth
// refresh token (written once by scripts/gcal-auth.js) exchanged for a
// short-lived access token on demand.

const config = require('./config');
const { dayBoundsUTC } = require('./time');

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function isConfigured() {
  return Boolean(config.GCAL_CLIENT_ID && config.GCAL_CLIENT_SECRET && config.GCAL_REFRESH_TOKEN);
}

let tokenCache = null; // { token, expiresAt }

async function accessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GCAL_CLIENT_ID,
      client_secret: config.GCAL_CLIENT_SECRET,
      refresh_token: config.GCAL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    // Only the error code/description - never echo the request (it holds the secret).
    throw new Error(`token refresh -> ${r.status}: ${data.error || ''} ${data.error_description || ''}`.trim());
  }
  // Refresh a minute early so a token never expires mid-request.
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function req(path, params, attempt = 0) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const r = await fetch(`${API}${path}${qs}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  console.log(`[gcal] GET ${path} -> ${r.status}`);
  if ((r.status === 429 || r.status === 403) && attempt < 1) {
    // 403 rateLimitExceeded / 429 - Google's usage limits; one short retry.
    await new Promise(resolve => setTimeout(resolve, 1000));
    return req(path, params, attempt + 1);
  }
  if (r.status === 401 && attempt < 1) {
    tokenCache = null; // revoked/expired early - force a fresh exchange once
    return req(path, params, attempt + 1);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// The calendars checked in the Google Calendar sidebar (calendarList's
// `selected`), so the Day column shows exactly what the GCal UI shows.
// Cached like the class schedule - toggling a calendar shows up within the TTL.
let calendarsCache = null; // { data, fetchedAt }
const CALENDARS_TTL_MS = 30 * 60 * 1000;

async function shownCalendars() {
  const now = Date.now();
  if (calendarsCache && now - calendarsCache.fetchedAt < CALENDARS_TTL_MS) {
    return calendarsCache.data;
  }
  const items = [];
  let pageToken;
  do {
    const params = { maxResults: '250' };
    if (pageToken) params.pageToken = pageToken;
    const data = await req('/users/me/calendarList', params);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  const data = items
    .filter(c => c.selected && !c.hidden)
    .map(c => ({
      id: c.id,
      summary: c.summaryOverride || c.summary || c.id,
      color: c.backgroundColor || '',
      fg: c.foregroundColor || '',
    }));
  calendarsCache = { data, fetchedAt: now };
  return data;
}

async function listEvents(calendarId, timeMin, timeMax) {
  const items = [];
  let pageToken;
  do {
    const params = {
      singleEvents: 'true', // Google expands recurring events into instances
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: '250',
    };
    if (pageToken) params.pageToken = pageToken;
    const data = await req(`/calendars/${encodeURIComponent(calendarId)}/events`, params);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

function declinedBySelf(ev) {
  return (ev.attendees || []).some(a => a.self && a.responseStatus === 'declined');
}

// Google Calendar events on `dateStr` in the viewer's timezone (same
// `tzOffsetMin` convention as notion.getDayView), across every shown
// calendar, flattened into the day-view entry shape.
async function getEventsForDate(dateStr, tzOffsetMin) {
  if (!isConfigured()) return [];
  const { startISO, endISO } = dayBoundsUTC(dateStr, tzOffsetMin);
  const calendars = await shownCalendars();
  const perCalendar = await Promise.all(calendars.map(async cal => {
    const events = await listEvents(cal.id, startISO, endISO);
    const entries = [];
    for (const ev of events) {
      if (ev.status === 'cancelled' || declinedBySelf(ev)) continue;
      const allDay = Boolean(ev.start?.date);
      // All-day events are bare dates with an EXCLUSIVE end date; the UTC
      // window can overlap the neighbouring day's all-day event, so bucket
      // them by date string instead.
      if (allDay && !(ev.start.date <= dateStr && dateStr < ev.end.date)) continue;
      entries.push({
        id: `gcal-${ev.id}`,
        kind: 'gcal',
        title: ev.summary || '(busy)',
        start: allDay ? ev.start.date : ev.start.dateTime,
        end: allDay ? null : ev.end?.dateTime || null,
        hasTime: !allDay,
        sub: cal.summary,
        url: ev.htmlLink || '',
        color: cal.color,
        fg: cal.fg,
      });
    }
    return entries;
  }));
  return perCalendar.flat();
}

module.exports = {
  isConfigured,
  getEventsForDate,
};
