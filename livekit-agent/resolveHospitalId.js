const mongoose = require("mongoose");
const { parseMetadataObject } = require("./resolveCallTransferContext");

const HOSPITAL_ID_KEYS = [
  "hospitalId",
  "hospital",
  "hospitalObjectId",
  "hospital_id",
];

/**
 * Resolves the hospital Mongo id from a LiveKit room name.
 * Supports plain `hospital-{objectId}` and common trunk/SIP forms like
 * `hospital-{objectId}-call-...` (only the 24-hex id segment is used).
 * @param {string} roomName
 * @returns {string | null}
 */
function parseHospitalIdFromRoom(roomName) {
  const s = String(roomName || "").trim();
  if (!s.startsWith("hospital-")) return null;
  const after = s.slice("hospital-".length);
  // Accept any non-hex delimiter after the ObjectId (-, _, space, end-of-string, etc.)
  // SIP trunk rooms use underscore: hospital-{id}_+91phone_callId
  const m = after.match(/^([0-9a-fA-F]{24})(?=[^0-9a-fA-F]|$)/);
  if (!m) return null;
  const id = m[1];
  return mongoose.isValidObjectId(id) ? id : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} obj
 * @returns {string | null}
 */
function pickHospitalIdFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of HOSPITAL_ID_KEYS) {
    const v = obj[k];
    if (v == null) continue;
    const id = String(v).trim();
    if (/^[0-9a-fA-F]{24}$/.test(id) && mongoose.isValidObjectId(id)) {
      return id;
    }
  }
  return null;
}

/**
 * @param {import("@livekit/agents").JobContext} ctx
 * @param {string} roomName
 * @returns {{ id: string, source: string } | null}
 */
function resolveHospitalId(ctx, roomName) {
  /** @type {Array<[string, unknown]>} */
  const sources = [
    ["job_metadata", ctx.job?.metadata],
    ["job_room_metadata", ctx.job?.room?.metadata],
    ["room_metadata", ctx.room?.metadata],
  ];

  for (const [source, meta] of sources) {
    const id = pickHospitalIdFromObject(parseMetadataObject(meta));
    if (id) return { id, source };
  }

  const fromRoom = parseHospitalIdFromRoom(roomName);
  if (fromRoom) return { id: fromRoom, source: "room_name" };

  return null;
}

module.exports = {
  parseHospitalIdFromRoom,
  pickHospitalIdFromObject,
  resolveHospitalId,
};
