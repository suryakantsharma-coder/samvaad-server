/**
 * Best-effort **caller** phone for India (ANI / user mobile).
 * Does **not** read LiveKit `sip.*` attributes — those are often trunk/SIP identities, not the caller’s number.
 */

function normalizePhone10(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return null;
}

function metadataToString(meta) {
  if (meta == null || meta === "") return null;
  if (typeof meta === "string") return meta;
  if (Buffer.isBuffer(meta)) return meta.toString("utf8");
  return String(meta);
}

function phoneFromParsedObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const v =
    obj.callerPhone ??
    obj.phone ??
    obj.phoneNumber ??
    obj.mobile ??
    obj.msisdn ??
    obj.from ??
    obj.ani ??
    obj.callerId ??
    obj.caller_number;
  return normalizePhone10(v);
}

function tryParseMetadataString(str) {
  const t = String(str || "").trim();
  if (!t) return null;
  const asPhone = normalizePhone10(t);
  if (asPhone) return asPhone;
  try {
    const j = JSON.parse(t);
    return phoneFromParsedObject(j);
  } catch {
    return null;
  }
}

/** Participant attributes — skips every `sip.*` key (not treated as caller ANI). */
function extractPhoneFromAttributes(attrs) {
  if (!attrs || typeof attrs !== "object") return null;
  const keys = [
    "phone",
    "phoneNumber",
    "callerPhone",
    "callerId",
    "caller_number",
    "ani",
    "from",
    "mobile",
  ];
  for (const k of keys) {
    if (k.startsWith("sip.")) continue;
    const p = normalizePhone10(attrs[k]);
    if (p) return p;
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("sip.")) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    const p = normalizePhone10(v);
    if (p) return p;
  }
  return null;
}

function extractPhoneFromParticipant(participant) {
  if (!participant) return null;
  const fromAttrs = extractPhoneFromAttributes(participant.attributes);
  if (fromAttrs) return fromAttrs;

  const fromIdentity = normalizePhone10(participant.identity);
  if (fromIdentity) return fromIdentity;

  const metaStr = metadataToString(participant.metadata);
  if (metaStr) {
    const p = tryParseMetadataString(metaStr);
    if (p) return p;
  }

  return normalizePhone10(participant.name);
}

/**
 * First participant that yields a non–sip.* caller-like phone (identity / metadata / attrs).
 * @param {{ remoteParticipants?: Map<string, unknown> }} room
 * @returns {string|null}
 */
function bestPhoneFromRemoteParticipants(room) {
  if (!room || !room.remoteParticipants) return null;
  for (const [, p] of room.remoteParticipants) {
    const phone = extractPhoneFromParticipant(p);
    if (phone) return phone;
  }
  return null;
}

/**
 * @param {import("@livekit/agents").JobContext} ctx
 * @param {{ participantWaitMs?: number }} [opts]
 * @returns {Promise<string|null>} 10-digit mobile or null
 */
async function resolveCallerPhone(ctx, opts = {}) {
  const waitMs = opts.participantWaitMs ?? 8000;

  const job = ctx.job;
  if (job) {
    const metaStr = metadataToString(job.metadata);
    const fromJob = metaStr ? tryParseMetadataString(metaStr) : null;
    if (fromJob) return fromJob;
  }

  const info = ctx.info;
  if (info && info.acceptArguments) {
    const aa = info.acceptArguments;
    const metaStr = metadataToString(aa.metadata);
    if (metaStr) {
      const p = tryParseMetadataString(metaStr);
      if (p) return p;
    }
    const attrs = aa.attributes;
    if (attrs && typeof attrs === "object") {
      const p = extractPhoneFromAttributes(attrs);
      if (p) return p;
    }
  }

  const roomMeta = metadataToString(ctx.room?.metadata);
  if (roomMeta) {
    const p = tryParseMetadataString(roomMeta);
    if (p) return p;
  }

  try {
    await Promise.race([
      ctx.waitForParticipant(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("waitForParticipant timeout")), waitMs),
      ),
    ]);
  } catch {
    /* continue — room may still have participants */
  }

  const fromRoom = bestPhoneFromRemoteParticipants(ctx.room);
  if (fromRoom) return fromRoom;

  return null;
}

module.exports = {
  resolveCallerPhone,
  normalizePhone10,
};
