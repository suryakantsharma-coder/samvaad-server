const { parseFlexibleTime } = require("./appointmentDateTime");

function toMinutes(h, m) {
  return h * 60 + m;
}

/**
 * Fix HTML entities and broken escapes often copied from web forms into Doctor.availability.
 * @param {string} raw
 */
function sanitizeAvailabilityForDisplay(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";

  s = s.replace(/\r\n/g, "\n");

  s = s.replace(/&amp;/gi, "&");
  s = s.replace(/&nbsp;/gi, " ");
  s = s.replace(/&lt;/gi, "<");
  s = s.replace(/&gt;/gi, ">");
  s = s.replace(/&quot;/gi, '"');
  s = s.replace(/&#x2f;/gi, "/");
  s = s.replace(/&#47;/g, "/");

  s = s.replace(/&#(\d{1,7});/g, (_, num) => {
    const c = parseInt(num, 10);
    if (!Number.isFinite(c) || c < 1) return "";
    try {
      return String.fromCodePoint(c);
    } catch {
      return "";
    }
  });
  s = s.replace(/&#x([\da-f]{1,6});/gi, (_, hex) => {
    const c = parseInt(hex, 16);
    if (!Number.isFinite(c) || c < 1) return "";
    try {
      return String.fromCodePoint(c);
    } catch {
      return "";
    }
  });

  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<p[^>]*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");

  s = s.replace(/\/n/gi, "\n");
  s = s.replace(/\\n/g, "\n");

  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  const lines = s
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.length ? lines.join("\n") : s.trim();
}

/**
 * Split "9 AM - 5 PM" / "9:00 AM – 5:00 PM" / "9am to 5pm" into start/end strings.
 * @param {string} availabilityText
 * @returns {[string, string] | null}
 */
function splitAvailabilityParts(availabilityText) {
  const s = String(availabilityText || "").trim();
  if (!s) return null;
  const dash = s.match(/^(.+?)\s*[-–—]\s*(.+)$/i);
  if (dash) return [dash[1].trim(), dash[2].trim()];
  const to = s.split(/\s+to\s+/i);
  if (to.length === 2) return [to[0].trim(), to[1].trim()];
  return null;
}

/**
 * @param {string} availabilityText - Doctor.availability
 * @returns {{ label: string, ranges: { startMin: number, endMin: number }[] }}
 */
function parseDoctorAvailabilityWindow(availabilityText) {
  const label =
    sanitizeAvailabilityForDisplay(availabilityText) || "9 AM - 5 PM";
  const fallbackRange = {
    startMin: toMinutes(9, 0),
    endMin: toMinutes(17, 0),
  };
  const fallback = { label, ranges: [fallbackRange] };

  const lines = label.split(/\n/).filter(Boolean);
  const ranges = [];

  for (const line of lines) {
    const parts = splitAvailabilityParts(line);
    if (!parts) continue;
    const startT = parseFlexibleTime(parts[0]);
    const endT = parseFlexibleTime(parts[1]);
    if (!startT || !endT) continue;
    const startMin = toMinutes(startT.h, startT.min);
    const endMin = toMinutes(endT.h, endT.min);
    ranges.push({ startMin, endMin });
  }

  if (!ranges.length) {
    const parts = splitAvailabilityParts(label);
    if (parts) {
      const startT = parseFlexibleTime(parts[0]);
      const endT = parseFlexibleTime(parts[1]);
      if (startT && endT) {
        ranges.push({
          startMin: toMinutes(startT.h, startT.min),
          endMin: toMinutes(endT.h, endT.min),
        });
      }
    }
  }

  if (!ranges.length) return fallback;
  return { label, ranges };
}

/**
 * @param {number} h
 * @param {number} min
 * @param {{ ranges: { startMin: number, endMin: number }[] } | { startMin: number, endMin: number }} spec
 */
function isTimeWithinDoctorAvailability(h, min, spec) {
  const t = toMinutes(h, min);
  const ranges =
    spec && Array.isArray(spec.ranges) ? spec.ranges : spec ? [spec] : [];
  if (!ranges.length) return true;

  for (const { startMin, endMin } of ranges) {
    if (startMin <= endMin) {
      if (t >= startMin && t <= endMin) return true;
    } else if (t >= startMin || t <= endMin) {
      return true;
    }
  }
  return false;
}

module.exports = {
  sanitizeAvailabilityForDisplay,
  parseDoctorAvailabilityWindow,
  isTimeWithinDoctorAvailability,
  splitAvailabilityParts,
};
