/**
 * Flexible appointment date/time parsing for WhatsApp chat.
 * Uses a reference `now` (default: new Date()) for "current year/month" defaults.
 */

const ORDINAL_SUFFIX = /(?:st|nd|rd|th)/gi;

/** @param {number} y @param {number} m 0-11 */
function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

/** @param {Date} d */
function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function normalizeYear(n, now) {
  if (n >= 100) return n;
  const y = now.getFullYear();
  const century = Math.floor(y / 100) * 100;
  const candidate = century + n;
  if (candidate < y - 80) return candidate + 100;
  if (candidate > y + 20) return candidate - 100;
  return candidate;
}

function monthIndexFromName(name) {
  const s = String(name || "")
    .toLowerCase()
    .replace(ORDINAL_SUFFIX, "")
    .trim();
  const key3 = s.slice(0, 3);
  const map = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };
  if (map[key3] !== undefined) return map[key3];
  const full = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const i = full.findIndex((w) => w.startsWith(s) || w === s);
  return i >= 0 ? i : null;
}

/**
 * Build a local Date at midnight for (y, m0, day), capping day to month length.
 * @param {number} y
 * @param {number} m0 0-11
 * @param {number} day
 */
function dateAtLocalDay(y, m0, day) {
  const dim = daysInMonth(y, m0);
  const d = Math.min(Math.max(1, day), dim);
  return new Date(y, m0, d);
}

/**
 * If the calendar day is strictly before "today", move to the same day next month (then next year if needed).
 * @param {Date} candidate
 * @param {Date} now
 */
function rollForwardIfPast(candidate, now) {
  let y = candidate.getFullYear();
  let m = candidate.getMonth();
  let d = candidate.getDate();
  let cur = dateAtLocalDay(y, m, d);
  const today = startOfLocalDay(now);
  let guard = 0;
  while (startOfLocalDay(cur) < today && guard < 24) {
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
    cur = dateAtLocalDay(y, m, d);
    guard += 1;
  }
  return cur;
}

/**
 * @param {string} raw
 * @param {Date} [now]
 * @returns {{ y: number, m0: number, d: number, display: string } | null}
 */
function parseFlexibleDate(raw, now = new Date()) {
  const input = String(raw || "")
    .trim()
    .replace(ORDINAL_SUFFIX, "")
    .replace(/\s+/g, " ");
  if (!input) return null;

  const refY = now.getFullYear();
  const refM = now.getMonth();

  // ISO YYYY-MM-DD
  let m = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
    const dt = dateAtLocalDay(y, mo, d);
    if (dt.getMonth() !== mo) return null;
    return {
      y,
      m0: mo,
      d: dt.getDate(),
      display: formatDisplayDate(y, mo, dt.getDate()),
    };
  }

  // YYYY/MM/DD or YYYY.MM.DD
  m = input.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    if (mo < 0 || mo > 11 || d < 1) return null;
    const dt = dateAtLocalDay(y, mo, d);
    if (dt.getMonth() !== mo) return null;
    return {
      y,
      m0: mo,
      d: dt.getDate(),
      display: formatDisplayDate(y, mo, dt.getDate()),
    };
  }

  // DD/MM/YYYY or DD-MM-YY (assume day-first when ambiguous, common for IN)
  m = input.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    let a = parseInt(m[1], 10);
    let b = parseInt(m[2], 10);
    const yRaw = m[3];
    const y =
      yRaw.length === 4 ? parseInt(yRaw, 10) : normalizeYear(parseInt(yRaw, 10), now);
    let day;
    let mo0;
    if (a > 12) {
      day = a;
      mo0 = b - 1;
    } else if (b > 12) {
      day = b;
      mo0 = a - 1;
    } else {
      day = a;
      mo0 = b - 1;
    }
    if (mo0 < 0 || mo0 > 11 || day < 1) return null;
    const dt = dateAtLocalDay(y, mo0, day);
    if (dt.getMonth() !== mo0) return null;
    return {
      y,
      m0: mo0,
      d: dt.getDate(),
      display: formatDisplayDate(y, mo0, dt.getDate()),
    };
  }

  const monthRe =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

  // MonthName [Day] [, Year]  e.g. April 5, april 5 2026
  const reMonthFirst = new RegExp(
    `^${monthRe}\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{2,4}))?$`,
    "i",
  );
  m = input.match(reMonthFirst);
  if (m) {
    const mo0 = monthIndexFromName(m[1]);
    if (mo0 == null) return null;
    const day = parseInt(m[2], 10);
    const y = m[3] ? (m[3].length === 4 ? parseInt(m[3], 10) : normalizeYear(parseInt(m[3], 10), now)) : refY;
    if (day < 1 || day > 31) return null;
    let dt = dateAtLocalDay(y, mo0, day);
    if (dt.getMonth() !== mo0) return null;
    if (!m[3]) dt = rollForwardIfPast(dt, now);
    return {
      y: dt.getFullYear(),
      m0: dt.getMonth(),
      d: dt.getDate(),
      display: formatDisplayDate(dt.getFullYear(), dt.getMonth(), dt.getDate()),
    };
  }

  // Day MonthName [Year]  e.g. 5 April, 15th april, 3 dec 26
  const reDayFirst = new RegExp(
    `^(\\d{1,2})\\s+${monthRe}(?:\\s+(\\d{2,4}))?$`,
    "i",
  );
  m = input.match(reDayFirst);
  if (m) {
    const day = parseInt(m[1], 10);
    const mo0 = monthIndexFromName(m[2]);
    if (mo0 == null) return null;
    const y = m[3] ? (m[3].length === 4 ? parseInt(m[3], 10) : normalizeYear(parseInt(m[3], 10), now)) : refY;
    if (day < 1 || day > 31) return null;
    let dt = dateAtLocalDay(y, mo0, day);
    if (dt.getMonth() !== mo0) return null;
    if (!m[3]) dt = rollForwardIfPast(dt, now);
    return {
      y: dt.getFullYear(),
      m0: dt.getMonth(),
      d: dt.getDate(),
      display: formatDisplayDate(dt.getFullYear(), dt.getMonth(), dt.getDate()),
    };
  }

  // Day only: "5", "25"
  m = input.match(/^(\d{1,2})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    if (day < 1 || day > 31) return null;
    let y = refY;
    let mo0 = refM;
    let dt = dateAtLocalDay(y, mo0, day);
    if (dt.getMonth() !== mo0) {
      dt = dateAtLocalDay(y, mo0, daysInMonth(y, mo0));
    }
    dt = rollForwardIfPast(dt, now);
    return {
      y: dt.getFullYear(),
      m0: dt.getMonth(),
      d: dt.getDate(),
      display: formatDisplayDate(dt.getFullYear(), dt.getMonth(), dt.getDate()),
    };
  }

  return null;
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatDisplayDate(y, m0, d) {
  return `${d} ${MONTH_SHORT[m0]} ${y}`;
}

const INVISIBLE_TIME = /[\u200B-\u200D\uFEFF\u2060]/g;

/**
 * Normalize user time text. Must not turn "p.m." into "p:m:" (that breaks parsing).
 * @param {string} raw
 */
function normalizeTimeInput(raw) {
  let s = String(raw || "").normalize("NFC").trim();
  if (!s) return "";
  s = s.replace(INVISIBLE_TIME, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.toLowerCase();
  s = s.replace(/\ba\s*\.\s*m\s*\.\s*/gi, "am ");
  s = s.replace(/\bp\s*\.\s*m\s*\.\s*/gi, "pm ");
  s = s.replace(/\bnoon\b/g, "12:00 pm");
  s = s.replace(/\bmidnight\b/g, "12:00 am");
  s = s.replace(/(\d{1,2})\s*\.\s*(\d{1,2})(?=\s|$|[ap])/g, "$1:$2");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * @param {string} raw
 * @param {Date} [_now] reserved for future "today at" hints
 * @returns {{ h: number, min: number, display: string } | null}
 */
function parseFlexibleTime(raw, _now = new Date()) {
  const s = normalizeTimeInput(raw);
  if (!s) return null;

  let m = s.match(
    /^(\d{1,2})\s*:\s*(\d{1,2})\s*(am|pm)?$/,
  );
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = m[3];
    if (min > 59 || h > 23) return null;
    if (ap) {
      if (h < 1 || h > 12) return null;
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
    } else {
      if (h === 24 && min === 0) h = 0;
      if (h > 23) return null;
    }
    return { h, min, display: formatDisplayTime(h, min) };
  }

  m = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    if (h < 1 || h > 12) return null;
    if (m[2] === "pm" && h < 12) h += 12;
    if (m[2] === "am" && h === 12) h = 0;
    return { h, min: 0, display: formatDisplayTime(h, 0) };
  }

  m = s.match(/^(\d{3,4})$/);
  if (m) {
    const digits = m[1];
    let h;
    let min;
    if (digits.length === 3) {
      h = parseInt(digits[0], 10);
      min = parseInt(digits.slice(1), 10);
    } else {
      h = parseInt(digits.slice(0, 2), 10);
      min = parseInt(digits.slice(2), 10);
    }
    if (h > 23 || min > 59) return null;
    return { h, min, display: formatDisplayTime(h, min) };
  }

  m = s.match(/^(\d{1,2})\s+(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (min > 59) return null;
    if (m[3] === "pm") {
      if (h < 1 || h > 12) return null;
      if (h < 12) h += 12;
    } else {
      if (h < 1 || h > 12) return null;
      if (h === 12) h = 0;
    }
    return { h, min, display: formatDisplayTime(h, min) };
  }

  return null;
}

function formatDisplayTime(h, min) {
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  const mm = String(min).padStart(2, "0");
  return `${h12}:${mm} ${ap}`;
}

/**
 * @param {number} y
 * @param {number} m0 0-11
 * @param {number} d
 */
function toYyyyMmDd(y, m0, d) {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * @param {number} h
 * @param {number} min
 */
function to24hClock(h, min) {
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * @param {string} dateInput
 * @param {string} timeInput
 * @param {Date} [now]
 * @returns {Date}
 */
function combineToAppointmentDate(dateInput, timeInput, now = new Date()) {
  const dp = parseFlexibleDate(dateInput, now);
  const tp = parseFlexibleTime(timeInput, now);
  if (!dp || !tp) {
    throw new Error(
      "Could not read date/time. Please send a clear date and time.",
    );
  }
  return new Date(dp.y, dp.m0, dp.d, tp.h, tp.min, 0, 0);
}

module.exports = {
  parseFlexibleDate,
  parseFlexibleTime,
  combineToAppointmentDate,
  toYyyyMmDd,
  to24hClock,
  formatDisplayDate,
  formatDisplayTime,
};
