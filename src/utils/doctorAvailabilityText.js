/**
 * Fix HTML entities and broken escapes often copied from web forms into Doctor.availability.
 * Kept in src/ so HTTP layer and whatsapp-chat-agent can share one implementation.
 * @param {string} raw
 */
function sanitizeAvailabilityForDisplay(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';

  s = s.replace(/\r\n/g, '\n');

  s = s.replace(/&amp;/gi, '&');
  s = s.replace(/&nbsp;/gi, ' ');
  s = s.replace(/&lt;/gi, '<');
  s = s.replace(/&gt;/gi, '>');
  s = s.replace(/&quot;/gi, '"');
  s = s.replace(/&#x2f;/gi, '/');
  s = s.replace(/&#47;/g, '/');

  s = s.replace(/&#(\d{1,7});/g, (_, num) => {
    const c = parseInt(num, 10);
    if (!Number.isFinite(c) || c < 1) return '';
    try {
      return String.fromCodePoint(c);
    } catch {
      return '';
    }
  });
  s = s.replace(/&#x([\da-f]{1,6});/gi, (_, hex) => {
    const c = parseInt(hex, 16);
    if (!Number.isFinite(c) || c < 1) return '';
    try {
      return String.fromCodePoint(c);
    } catch {
      return '';
    }
  });

  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<p[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');

  s = s.replace(/\/n/gi, '\n');
  s = s.replace(/\\n/g, '\n');

  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');

  const lines = s
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.length ? lines.join('\n') : s.trim();
}

module.exports = { sanitizeAvailabilityForDisplay };
