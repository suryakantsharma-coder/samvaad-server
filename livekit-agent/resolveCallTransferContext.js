const { extractSipCallerPhoneFromRoom } = require("./sipCallerPhone");

const CALL_SID_KEYS = [
  "exotelCallSid",
  "callSid",
  "CallSid",
  "exotel_call_sid",
  "sip.callID",
  "sip.callId",
  "sip.call_id",
];

function parseMetadataObject(meta) {
  if (meta == null || meta === "") return null;
  if (typeof meta === "object" && !Buffer.isBuffer(meta)) {
    return meta;
  }
  const s = Buffer.isBuffer(meta) ? meta.toString("utf8") : String(meta).trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

function pickCallSidFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of CALL_SID_KEYS) {
    const v = obj[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

function pickCallSidFromParticipants(room) {
  if (!room || !room.remoteParticipants) return null;
  try {
    for (const p of room.remoteParticipants.values()) {
      const attrs = p.attributes;
      if (attrs && typeof attrs === "object") {
        for (const k of CALL_SID_KEYS) {
          const v = attrs[k];
          if (v != null && String(v).trim()) return String(v).trim();
        }
        for (const [k, v] of Object.entries(attrs)) {
          if (/callsid|call.?sid/i.test(k) && v != null && String(v).trim()) {
            return String(v).trim();
          }
        }
      }
      const meta = parseMetadataObject(p.metadata || (p.info && p.info.metadata));
      const fromMeta = pickCallSidFromObject(meta);
      if (fromMeta) return fromMeta;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function findSipParticipantIdentity(room) {
  if (!room || !room.remoteParticipants) return null;
  try {
    for (const p of room.remoteParticipants.values()) {
      const id = String(p.identity || "").trim();
      if (/^sip_/i.test(id)) return id;
      if (p.name && /^sip_/i.test(String(p.name))) return String(p.name).trim();
      if (p.trackPublications && typeof p.trackPublications.values === "function") {
        for (const pub of p.trackPublications.values()) {
          const n = pub && pub.name ? String(pub.name).trim() : "";
          if (/^sip_/i.test(n)) return n;
        }
      }
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function resolveCallTransferContext(p) {
  const room = p.room || null;
  const jobObj = parseMetadataObject(p.jobMetadata);
  const roomObj = parseMetadataObject(p.roomMetadata);

  const exotelCallSid =
    pickCallSidFromObject(jobObj) ||
    pickCallSidFromObject(roomObj) ||
    pickCallSidFromParticipants(room);

  return {
    exotelCallSid,
    sipParticipantIdentity: findSipParticipantIdentity(room),
    sipCallerPhone: extractSipCallerPhoneFromRoom(room),
  };
}

module.exports = {
  resolveCallTransferContext,
  findSipParticipantIdentity,
  parseMetadataObject,
};
