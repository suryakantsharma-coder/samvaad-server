const { RoomServiceClient } = require("livekit-server-sdk");
const { getThankYouLine } = require("./preferredLanguage");

const LOG_TAG = "[EndCall]";

/** @param {string} name @param {boolean} defaultOn */
function parseEnvFlag(name, defaultOn) {
  const v = process.env[name];
  if (v == null || v === "") return defaultOn;
  const s = String(v).trim().toLowerCase();
  if (s === "0" || s === "false" || s === "off" || s === "no") return false;
  if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
  return defaultOn;
}

/** @param {string} name @param {number} def */
function parseEnvMs(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function isAutoEndAfterBookingEnabled() {
  return parseEnvFlag("AGENT_AUTO_END_AFTER_BOOKING", true);
}

/** Pause after booking thank-you before deleteRoom (default 2s). */
function getBookingEndDelayMs() {
  return parseEnvMs("AGENT_BOOKING_END_DELAY_MS", 2000);
}

/** Agent must stay listening this long before hangup (avoids cutting between speech chunks). */
function getAutoEndStableIdleMs() {
  return parseEnvMs("AGENT_AUTO_END_STABLE_IDLE_MS", 1200);
}

/** Extra pause after emergency thank-you before deleteRoom (default 2s). */
function getEmergencyEndDelayMs() {
  return parseEnvMs("AGENT_EMERGENCY_END_DELAY_MS", 2000);
}

/**
 * LiveKit REST API expects https:// — .env often has wss:// for WebRTC.
 * @param {string | undefined} raw
 */
function normalizeLiveKitHost(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (u.startsWith("wss://")) return `https://${u.slice(6)}`;
  if (u.startsWith("ws://")) return `http://${u.slice(5)}`;
  return u;
}

/**
 * @param {{ log?: (type: string, data?: object) => void } | null | undefined} logger
 * @param {string} type
 * @param {object} [data]
 */
function logEndCallEvent(logger, type, data = {}) {
  console.log(LOG_TAG, type, data && Object.keys(data).length ? data : "");
  if (logger && typeof logger.log === "function") {
    logger.log(type, data);
  }
}

/**
 * Deletes the LiveKit room so the SIP trunk receives BYE and the caller's phone disconnects.
 * @param {string} roomName
 * @param {{ logger?: { log?: (type: string, data?: object) => void } | null, reason?: string }} [opts]
 */
async function endPhoneCallByDeletingRoom(roomName, opts = {}) {
  const room = String(roomName || "").trim();
  const reason = opts.reason || "unspecified";
  const logger = opts.logger || null;

  logEndCallEvent(logger, "end_call_delete_room_invoked", {
    roomName: room || null,
    reason,
  });

  console.log(LOG_TAG, "========== CALL CUT START ==========", {
    roomName: room || null,
    reason,
  });

  if (!room) {
    console.warn(LOG_TAG, "skip deleteRoom: empty roomName");
    logEndCallEvent(logger, "end_call_delete_room_skipped", {
      code: "NO_ROOM",
      reason,
    });
    return { ok: false, code: "NO_ROOM" };
  }

  const host = normalizeLiveKitHost(process.env.LIVEKIT_URL);
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!host || !apiKey || !apiSecret) {
    console.warn(LOG_TAG, "skip deleteRoom: LiveKit credentials missing", {
      hasHost: Boolean(host),
      hasApiKey: Boolean(apiKey),
      hasApiSecret: Boolean(apiSecret),
    });
    logEndCallEvent(logger, "end_call_delete_room_skipped", {
      code: "LIVEKIT_NOT_CONFIGURED",
      reason,
      roomName: room,
    });
    return { ok: false, code: "LIVEKIT_NOT_CONFIGURED" };
  }

  console.log(LOG_TAG, "deleteRoom request", { host, room, reason });
  const rooms = new RoomServiceClient(host, apiKey, apiSecret);
  try {
    await rooms.deleteRoom(room);
    console.log(LOG_TAG, "========== CALL CUT SUCCESS ==========", {
      roomName: room,
      reason,
      message: "SIP caller should disconnect now",
    });
    logEndCallEvent(logger, "end_call_delete_room_ok", { roomName: room, reason });
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/not.?found|does not exist/i.test(msg)) {
      console.log(LOG_TAG, "room already deleted:", room);
      logEndCallEvent(logger, "end_call_delete_room_ok", {
        roomName: room,
        reason,
        code: "ALREADY_GONE",
      });
      return { ok: true, code: "ALREADY_GONE" };
    }
    console.warn(LOG_TAG, "========== CALL CUT FAILED ==========", {
      roomName: room,
      reason,
      message: msg,
    });
    logEndCallEvent(logger, "end_call_delete_room_failed", {
      roomName: room,
      reason,
      code: "DELETE_FAILED",
      message: msg,
    });
    return { ok: false, code: "DELETE_FAILED", message: msg };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the agent is done speaking/thinking (single idle snapshot).
 * @param {import('@livekit/agents').voice.AgentSession | null | undefined} session
 * @param {number} [maxMs]
 */
async function waitForAgentSpeechIdle(session, maxMs = 120000) {
  if (!session) return;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (session.closing) return;
    const st = session.agentState;
    if (st === "listening" || st === "idle") return;
    await delay(100);
  }
  console.warn(LOG_TAG, "waitForAgentSpeechIdle timed out after", maxMs, "ms");
}

/**
 * Wait until the agent has been continuously idle — not a brief gap between utterances.
 * @param {import('@livekit/agents').voice.AgentSession | null | undefined} session
 * @param {number} [stableMs]
 * @param {number} [maxMs]
 */
async function waitForStableAgentIdle(session, stableMs, maxMs = 180000) {
  if (!session) return;
  const need = stableMs > 0 ? stableMs : getAutoEndStableIdleMs();
  let listeningSince = null;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (session.closing) return;
    const st = session.agentState;
    if (st === "listening" || st === "idle") {
      if (listeningSince === null) listeningSince = Date.now();
      else if (Date.now() - listeningSince >= need) return;
    } else {
      listeningSince = null;
    }
    await delay(100);
  }
  console.warn(
    LOG_TAG,
    "waitForStableAgentIdle timed out after",
    maxMs,
    "ms",
  );
}

/**
 * After confirmation playout, wait until the agent is idle, then delete the room.
 * @param {{
 *   roomName?: string | null,
 *   session?: import('@livekit/agents').voice.AgentSession | null,
 *   logger?: { log?: (type: string, data?: object) => void } | null,
 *   reason?: string,
 * }} opts
 */
async function autoEndCallAfterBooking(opts = {}) {
  if (!isAutoEndAfterBookingEnabled()) {
    console.log(LOG_TAG, "autoEndCallAfterBooking skipped — AGENT_AUTO_END_AFTER_BOOKING off");
    return { ok: false, code: "DISABLED" };
  }

  const roomName = opts.roomName;
  const session = opts.session;
  const extraDelayMs = getBookingEndDelayMs();
  const logger = opts.logger;
  const reason = opts.reason || "booking_confirmed";

  logEndCallEvent(logger, "end_call_booking_flow_start", {
    roomName: roomName || null,
    reason,
    extraDelayMs,
    stableIdleMs: getAutoEndStableIdleMs(),
    agentState: session ? session.agentState : null,
  });

  if (session) {
    console.log(LOG_TAG, "booking end — waiting for stable agent idle…");
    await waitForStableAgentIdle(session, getAutoEndStableIdleMs());
  }

  if (session && session.closing) {
    logEndCallEvent(logger, "end_call_booking_flow_aborted", {
      code: "SESSION_CLOSING",
      roomName: roomName || null,
    });
    return { ok: false, code: "SESSION_CLOSING" };
  }

  if (extraDelayMs > 0) {
    logEndCallEvent(logger, "end_call_booking_extra_delay", {
      delayMs: extraDelayMs,
      roomName: roomName || null,
    });
    await delay(extraDelayMs);
    if (session && session.closing) {
      return { ok: false, code: "SESSION_CLOSING" };
    }
  }

  logEndCallEvent(logger, "end_call_booking_hangup", {
    roomName: roomName || null,
    afterConfirmationIdle: true,
    reason,
  });

  const result = await endPhoneCallByDeletingRoom(roomName, { logger, reason });
  logEndCallEvent(logger, "end_call_booking_flow_complete", {
    roomName: roomName || null,
    ok: Boolean(result.ok),
    code: result.code || null,
    reason,
  });
  return result;
}

/**
 * Emergency flow: wait for thank-you audio to finish, then delete room (SIP BYE).
 * @param {{
 *   roomName?: string | null,
 *   session?: import('@livekit/agents').voice.AgentSession | null,
 *   logger?: { log?: (type: string, data?: object) => void } | null,
 *   reason?: string,
 * }} opts
 */
async function endEmergencyPhoneCall(opts = {}) {
  const roomName = opts.roomName;
  const session = opts.session;
  const logger = opts.logger;
  const reason = opts.reason || "emergency_flow_complete";
  const extraDelayMs = getEmergencyEndDelayMs();

  logEndCallEvent(logger, "end_call_emergency_flow_start", {
    roomName: roomName || null,
    reason,
    extraDelayMs,
    stableIdleMs: getAutoEndStableIdleMs(),
    agentState: session ? session.agentState : null,
  });

  if (session) {
    console.log(LOG_TAG, "emergency end — waiting for thank-you playout (stable idle)…");
    await waitForStableAgentIdle(session, getAutoEndStableIdleMs());
  }

  if (session && session.closing) {
    logEndCallEvent(logger, "end_call_emergency_flow_aborted", {
      code: "SESSION_CLOSING",
      roomName: roomName || null,
    });
    return { ok: false, code: "SESSION_CLOSING" };
  }

  if (extraDelayMs > 0) {
    logEndCallEvent(logger, "end_call_emergency_extra_delay", {
      delayMs: extraDelayMs,
      roomName: roomName || null,
    });
    await delay(extraDelayMs);
  }

  logEndCallEvent(logger, "end_call_emergency_hangup", {
    roomName: roomName || null,
    reason,
  });

  const result = await endPhoneCallByDeletingRoom(roomName, { logger, reason });
  logEndCallEvent(logger, "end_call_emergency_flow_complete", {
    roomName: roomName || null,
    ok: Boolean(result.ok),
    code: result.code || null,
    reason,
  });
  if (result.ok) {
    console.log(LOG_TAG, "========== EMERGENCY CALL END DONE ==========", {
      roomName: roomName || null,
      method: result.code || "deleteRoom",
    });
  } else {
    console.warn(LOG_TAG, "========== EMERGENCY CALL END FAILED ==========", {
      roomName: roomName || null,
      code: result.code || null,
    });
  }
  return result;
}

/**
 * Schedule hangup after the create_appointment tool returns
 * (so tool_response speech can finish before the SIP line drops).
 * @param {{
 *   agent: {
 *     session?: import('@livekit/agents').voice.AgentSession | null,
 *     _callRoomName?: string | null,
 *     roomName?: string | null,
 *     getCallLogger?: () => unknown,
 *     postBookingClosingInFlight?: boolean,
 *   },
 * }} p
 */
function scheduleAutoEndAfterBookingConfirmed(p) {
  const agent = p && p.agent;
  if (!agent || !isAutoEndAfterBookingEnabled()) return;

  const roomName =
    (agent._callRoomName && String(agent._callRoomName)) ||
    (agent.roomName && String(agent.roomName)) ||
    "";
  const session = agent.session || null;
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;

  agent.postBookingClosingInFlight = true;
  console.log(LOG_TAG, "scheduling auto hangup after booking for room:", roomName || "(missing)");
  logEndCallEvent(logger, "end_call_booking_scheduled", {
    roomName: roomName || null,
  });

  setImmediate(() => {
    autoEndCallAfterBooking({
      roomName,
      session,
      logger,
      reason: "booking_confirmed",
    })
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        console.error(LOG_TAG, "deferred auto end failed:", msg);
        logEndCallEvent(logger, "end_call_booking_error", {
          errorMessage: msg,
          roomName,
        });
      })
      .finally(() => {
        agent.postBookingClosingInFlight = false;
      });
  });
}

module.exports = {
  isAutoEndAfterBookingEnabled,
  getBookingEndDelayMs,
  getAutoEndStableIdleMs,
  getEmergencyEndDelayMs,
  getThankYouLine,
  normalizeLiveKitHost,
  endPhoneCallByDeletingRoom,
  waitForAgentSpeechIdle,
  waitForStableAgentIdle,
  autoEndCallAfterBooking,
  endEmergencyPhoneCall,
  scheduleAutoEndAfterBookingConfirmed,
};
