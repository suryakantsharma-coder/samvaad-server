/**
 * Exotel / SIP bridge often sets participant identity or track name to `sip_+918383801256`.
 * Strip the `sip_` prefix and return the phone (E.164 or digits) for tools + prompts.
 */

const SIP_PREFIX = /^sip_/i;

/**
 * @param {string | null | undefined} s
 * @returns {string | null}
 */
function extractPhoneFromSipIdentity(s) {
  if (s == null || typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  if (!SIP_PREFIX.test(t)) return null;
  const rest = t.replace(SIP_PREFIX, "").trim();
  return rest || null;
}

/**
 * Walk remote participants and track publications for `sip_*` names.
 * @param {import('@livekit/rtc-node').Room | null | undefined} room
 * @returns {string | null}
 */
function extractSipCallerPhoneFromRoom(room) {
  if (!room || !room.remoteParticipants) return null;

  /** @type {string[]} */
  const candidates = [];

  try {
    for (const p of room.remoteParticipants.values()) {
      candidates.push(p.identity);
      if (p.name) candidates.push(p.name);
      const info = p.info;
      if (info && info.name) candidates.push(info.name);

      if (p.trackPublications && typeof p.trackPublications.values === "function") {
        for (const pub of p.trackPublications.values()) {
          if (pub.name) candidates.push(pub.name);
          if (pub.info && pub.info.name) candidates.push(pub.info.name);
        }
      }
    }
  } catch (e) {
    console.warn("[LiveKit Agent] extractSipCallerPhoneFromRoom:", e.message);
    return null;
  }

  for (const c of candidates) {
    const phone = extractPhoneFromSipIdentity(c);
    if (phone) return phone;
  }
  return null;
}

module.exports = {
  extractPhoneFromSipIdentity,
  extractSipCallerPhoneFromRoom,
};
