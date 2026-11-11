// All month/day boundaries are computed in the app's timezone, not the server's
// (Render runs in UTC). Without this, a payment at 2am IST on the 1st lands in
// the previous month. Override with APP_TIMEZONE if the user base ever moves.

const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function zonedParts(date) {
  const p = {};
  for (const { type, value } of partsFormatter.formatToParts(date)) p[type] = Number(value);
  return p;
}

// Offset of APP_TZ from UTC at the given instant, in ms (IST → +19 800 000).
function offsetMs(date) {
  const p = zonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant of midnight (in APP_TZ) on the given calendar date.
// `month` is 0-based and, like Date.UTC, may overflow (month 12 → next January).
function zonedMidnight(year, month, day) {
  const guess = Date.UTC(year, month, day);
  const first = guess - offsetMs(new Date(guess));
  // Second pass handles zones where the offset changes near midnight (DST).
  return new Date(guess - offsetMs(new Date(first)));
}

// Today's calendar date in APP_TZ. `month` is 0-based.
function zonedToday(now = new Date()) {
  const p = zonedParts(now);
  return { year: p.year, month: p.month - 1, day: p.day };
}

module.exports = { APP_TZ, zonedMidnight, zonedToday };
