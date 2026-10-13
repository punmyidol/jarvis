// Day-window helper shared by notion.js (Tasks/Events) and gcal.js (Google
// Calendar), kept in its own file so those two don't require each other.

// Computes the UTC instant for local-midnight -> next-local-midnight of
// `dateStr`, in whichever timezone the caller is actually in (`tzOffsetMin`,
// following JS's own `Date.prototype.getTimezoneOffset()` convention:
// UTC = local + tzOffsetMin). This is what makes "today"/"tomorrow" correct
// for whoever's viewing the page, rather than hardcoding one timezone.
function dayBoundsUTC(dateStr, tzOffsetMin) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) + tzOffsetMin * 60000;
  return {
    startISO: new Date(startMs).toISOString(),
    endISO: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

module.exports = { dayBoundsUTC };
