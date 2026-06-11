/**
 * Kanbantt — Google Calendar read-only sync.
 *
 * Pulls events from the user's primary calendar. Read-only via the
 * `calendar.events.readonly` scope. Events are normalized to a small internal
 * shape and cached per-month.
 *
 * Why only the primary calendar?
 *   - Lower scope surface (we don't need calendars.list).
 *   - Aligns with how people use calendar: shared / secondary calendars are
 *     usually noise for personal task planning.
 *   - Easy to expand later if needed.
 *
 * Why per-month caching?
 *   - Matches the CalendarView's navigation unit.
 *   - Bounded memory.
 *   - Invalidation is simple — kick the whole map on demand.
 *
 * Usage:
 *   import { fetchEventsForRange, fetchEventsForMonth, invalidateCache } from './calendar-sync.js';
 *
 *   const events = await fetchEventsForMonth(new Date(2026, 4, 1));
 *   // Returns: [{ id, title, start, end, allDay, location?, htmlLink }]
 */

import { withToken } from './auth.js';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map(); // key: 'YYYY-MM' or 'range:start..end', value: { events, fetchedAt }

/* ------------------------------------------------------------------------ */
/* Core fetch                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Fetch events between two dates from the primary calendar.
 * Handles pagination (up to 5 pages). Returns normalized event objects.
 */
export async function fetchEventsForRange(startDate, endDate, { cacheKey = null } = {}) {
  const ck = cacheKey || `range:${startDate.toISOString()}..${endDate.toISOString()}`;
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.events;
  }

  const all = [];
  let pageToken = null;
  let pages = 0;

  do {
    const token = await withToken();
    const url = new URL(`${CAL_BASE}/calendars/primary/events`);
    url.searchParams.set('timeMin', startDate.toISOString());
    url.searchParams.set('timeMax', endDate.toISOString());
    url.searchParams.set('singleEvents', 'true'); // Expand recurring events.
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('fields', 'items(id,summary,start,end,location,htmlLink,status),nextPageToken');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Calendar fetch: ${r.status} ${await r.text()}`);
    const data = await r.json();

    for (const e of data.items || []) {
      if (e.status === 'cancelled') continue;
      all.push(normalize(e));
    }
    pageToken = data.nextPageToken;
    pages += 1;
  } while (pageToken && pages < 5);

  cache.set(ck, { events: all, fetchedAt: Date.now() });
  return all;
}

/** Convenience: fetch events for a single calendar month. */
export function fetchEventsForMonth(anyDateInMonth) {
  const y = anyDateInMonth.getFullYear();
  const m = anyDateInMonth.getMonth();
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 1); // first day of next month, exclusive via timeMax
  const key = `${y}-${String(m + 1).padStart(2, '0')}`;
  return fetchEventsForRange(start, end, { cacheKey: key });
}

/* ------------------------------------------------------------------------ */
/* Normalization                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Reduce a Google event to the shape Kanbantt actually uses.
 * Keeps htmlLink so the UI can offer a "view in Google Calendar" link.
 */
function normalize(e) {
  const allDay = !e.start?.dateTime;
  return {
    id: e.id,
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay,
    location: e.location || null,
    htmlLink: e.htmlLink || null,
  };
}

/* ------------------------------------------------------------------------ */
/* Cache control                                                            */
/* ------------------------------------------------------------------------ */

/** Drop all cached events. Use on manual refresh button. */
export function invalidateCache() {
  cache.clear();
}

/** Drop the cache for a specific month. */
export function invalidateMonth(date) {
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  cache.delete(key);
}
