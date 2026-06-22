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

function isAutoEndAfterEmergencyEnabled() {
  return parseEnvFlag("AGENT_AUTO_END_AFTER_EMERGENCY", true);
}

/** Optional extra pause after confirmation audio finishes; default 0 (cut as soon as idle). */
function getAutoEndDelayMs() {
  return parseEnvMs("AGENT_AUTO_END_DELAY_MS", 0);
}

/** Extra pause after emergency thank-you before deleteRoom (default 2s). */
function getEmergencyEndDelayMs() {
  return parseEnvMs("AGENT_EMERGENCY_END_DELAY_MS", 500);
}

/** Agent must stay listening this long before hangup (avoids cutting between speech chunks). */
function getAutoEndStableIdleMs() {
  return parseEnvMs("AGENT_AUTO_END_STABLE_IDLE_MS", 1000);
}

/**
 * Max time to wait for the post-booking confirmation reply to BEGIN speaking
 * before we start measuring idle. Covers the gap between the tool returning and
 * the Realtime model emitting the first audio of the confirmation (function-output
 * submission + response generation latency). Without this, the idle window during
 * that gap can satisfy the stable-idle threshold and cut the call before — or
 * during — the confirmation. Set to 0 to disable the wait-for-speech guard.
 */
function getAutoEndSpeechStartMaxMs() {
  return parseEnvMs("AGENT_AUTO_END_SPEECH_START_MAX_MS", 8000);
}

/**
 * Deletes the LiveKit room so the SIP trunk receives BYE and the caller's phone disconnects.
 * @param {string} roomName
 */
async function endPhoneCallByDeletingRoom(roomName) {
  const room = String(roomName || "").trim();
  if (!room) {
    console.warn(LOG_TAG, "skip deleteRoom: empty roomName");
    return { ok: false, code: "NO_ROOM" };
  }

  const host = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!host || !apiKey || !apiSecret) {
    console.warn(LOG_TAG, "skip deleteRoom: LiveKit credentials missing");
    return { ok: false, code: "LIVEKIT_NOT_CONFIGURED" };
  }

  const rooms = new RoomServiceClient(host, apiKey, apiSecret);
  try {
    await rooms.deleteRoom(room);
    console.log(LOG_TAG, "room deleted — SIP call should hang up:", room);
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/not.?found|does not exist/i.test(msg)) {
      console.log(LOG_TAG, "room already deleted:", room);
      return { ok: true, code: "ALREADY_GONE" };
    }
    console.warn(LOG_TAG, "deleteRoom failed:", msg);
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
  console.warn(LOG_TAG, "waitForStableAgentIdle timed out after", maxMs, "ms");
}

/**
 * Wait until the agent LEAVES the idle/listening state — i.e. the confirmation
 * reply has actually started (speaking/thinking). Returns true if speech started,
 * false if it timed out or the session is closing. Used before measuring stable
 * idle so we never hang up in the gap before the confirmation begins.
 * @param {import('@livekit/agents').voice.AgentSession | null | undefined} session
 * @param {number} maxMs
 */
async function waitForAgentSpeechStart(session, maxMs) {
  if (!session || !(maxMs > 0)) return false;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (session.closing) return false;
    const st = session.agentState;
    if (st && st !== "listening" && st !== "idle") return true;
    await delay(50);
  }
  console.warn(
    LOG_TAG,
    "waitForAgentSpeechStart: confirmation reply did not start within",
    maxMs,
    "ms",
  );
  return false;
}

/**
 * After confirmation playout, wait until the agent is idle, then delete the room.
 * No fixed timer by default — booking may take as long as the caller needs; we only
 * hang up once the post-booking status + thank-you lines have finished playing.
 * @param {{
 *   roomName?: string | null,
 *   session?: import('@livekit/agents').voice.AgentSession | null,
 *   logger?: { log?: (type: string, data?: object) => void } | null,
 * }} opts
 */
async function autoEndCallAfterBooking(opts = {}) {
  if (!isAutoEndAfterBookingEnabled()) return { ok: false, code: "DISABLED" };

  const roomName = opts.roomName;
  const session = opts.session;
  const extraDelayMs = getAutoEndDelayMs();
  const logger = opts.logger;

  if (session) {
    // 1) Wait for the booking-confirmation reply to actually START speaking so we
    //    do not measure "idle" during the gap before it begins (which would cut
    //    the call before/during confirmation).
    const started = await waitForAgentSpeechStart(
      session,
      getAutoEndSpeechStartMaxMs(),
    );
    if (logger && typeof logger.log === "function") {
      logger.log("auto_end_speech_start", {
        roomName: roomName || null,
        confirmationStarted: started,
      });
    }
    // 2) Then wait until it has finished playing (continuous idle).
    await waitForStableAgentIdle(session, getAutoEndStableIdleMs());
  }

  if (session && session.closing) {
    return { ok: false, code: "SESSION_CLOSING" };
  }

  if (extraDelayMs > 0) {
    if (logger && typeof logger.log === "function") {
      logger.log("auto_end_extra_delay", {
        delayMs: extraDelayMs,
        roomName: roomName || null,
      });
    }
    await delay(extraDelayMs);
    if (session && session.closing) {
      return { ok: false, code: "SESSION_CLOSING" };
    }
  }

  if (logger && typeof logger.log === "function") {
    logger.log("auto_end_hangup", {
      roomName: roomName || null,
      afterConfirmationIdle: true,
    });
  }

  const result = await endPhoneCallByDeletingRoom(roomName);
  if (logger && typeof logger.log === "function") {
    logger.log("auto_end_complete", {
      roomName: roomName || null,
      ok: Boolean(result.ok),
      code: result.code || null,
    });
  }
  return result;
}

/**
 * Schedule hangup after the create_appointment tool returns to LiveKit Realtime
 * (so tool_response speech can finish before the SIP line drops).
 * @param {{
 *   agent: { session?: import('@livekit/agents').voice.AgentSession | null, _emergencyTransferCtx?: { roomName?: string | null } | null, getCallLogger?: () => unknown, postBookingClosingInFlight?: boolean },
 * }} p
 */
function resolveAgentRoomName(agent) {
  if (!agent) return "";
  if (agent._callRoomName) return String(agent._callRoomName);
  if (agent._emergencyTransferCtx && agent._emergencyTransferCtx.roomName) {
    return String(agent._emergencyTransferCtx.roomName);
  }
  return "";
}

function scheduleAutoEndAfterBookingConfirmed(p) {
  const agent = p && p.agent;
  if (!agent || !isAutoEndAfterBookingEnabled()) return;

  const roomName = resolveAgentRoomName(agent);
  const session = agent.session || null;
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;

  agent.postBookingClosingInFlight = true;
  console.log(
    LOG_TAG,
    "scheduling auto hangup after booking for room:",
    roomName || "(missing)",
  );

  setImmediate(() => {
    autoEndCallAfterBooking({ roomName, session, logger })
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        console.error(LOG_TAG, "deferred auto end failed:", msg);
        if (logger && typeof logger.log === "function") {
          logger.log("auto_end_error", { errorMessage: msg, roomName });
        }
      })
      .finally(() => {
        agent.postBookingClosingInFlight = false;
      });
  });
}

/**
 * After caller confirms they noted the emergency number, wait for the agent's
 * thank-you line to finish, then delete the room (SIP BYE).
 * @param {{
 *   roomName?: string | null,
 *   session?: import('@livekit/agents').voice.AgentSession | null,
 *   logger?: { log?: (type: string, data?: object) => void } | null,
 * }} opts
 */
async function autoEndCallAfterEmergency(opts = {}) {
  if (!isAutoEndAfterEmergencyEnabled()) return { ok: false, code: "DISABLED" };

  const roomName = opts.roomName;
  const session = opts.session;
  const extraDelayMs = getEmergencyEndDelayMs();
  const logger = opts.logger;

  if (logger && typeof logger.log === "function") {
    logger.log("auto_end_emergency_start", {
      roomName: roomName || null,
      stableIdleMs: getAutoEndStableIdleMs(),
      extraDelayMs,
    });
  }

  if (session) {
    await waitForStableAgentIdle(session, getAutoEndStableIdleMs());
  }

  if (session && session.closing) {
    if (logger && typeof logger.log === "function") {
      logger.log("auto_end_emergency_aborted", {
        roomName: roomName || null,
        reason: "session_closing",
      });
    }
    return { ok: false, code: "SESSION_CLOSING" };
  }

  if (extraDelayMs > 0) {
    if (logger && typeof logger.log === "function") {
      logger.log("auto_end_emergency_extra_delay", {
        delayMs: extraDelayMs,
        roomName: roomName || null,
      });
    }
    await delay(extraDelayMs);
    if (session && session.closing) {
      return { ok: false, code: "SESSION_CLOSING" };
    }
  }

  if (logger && typeof logger.log === "function") {
    logger.log("auto_end_emergency_hangup", {
      roomName: roomName || null,
      afterThankYouIdle: true,
    });
  }

  const result = await endPhoneCallByDeletingRoom(roomName);
  if (logger && typeof logger.log === "function") {
    logger.log("auto_end_emergency_complete", {
      roomName: roomName || null,
      ok: Boolean(result.ok),
      code: result.code || null,
    });
  }
  return result;
}

/**
 * Schedule hangup once caller confirms they noted the emergency number.
 * The LLM speaks the thank-you line via prompt; we cut after playout.
 * @param {{
 *   agent: { session?: import('@livekit/agents').voice.AgentSession | null, _callRoomName?: string | null, _emergencyTransferCtx?: { roomName?: string | null } | null, getCallLogger?: () => unknown, postBookingClosingInFlight?: boolean },
 * }} p
 */
function scheduleAutoEndAfterEmergencyNoted(p) {
  const agent = p && p.agent;
  if (!agent || !isAutoEndAfterEmergencyEnabled()) return;

  const roomName = resolveAgentRoomName(agent);
  const session = agent.session || null;
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;

  agent.postBookingClosingInFlight = true;
  console.log(
    LOG_TAG,
    "scheduling auto hangup after emergency thank-you for room:",
    roomName || "(missing)",
  );

  if (logger && typeof logger.log === "function") {
    logger.log("auto_end_emergency_scheduled", { roomName: roomName || null });
  }

  setImmediate(() => {
    autoEndCallAfterEmergency({ roomName, session, logger })
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        console.error(LOG_TAG, "deferred emergency auto end failed:", msg);
        if (logger && typeof logger.log === "function") {
          logger.log("auto_end_emergency_error", {
            errorMessage: msg,
            roomName,
          });
        }
      })
      .finally(() => {
        agent.postBookingClosingInFlight = false;
      });
  });
}

module.exports = {
  isAutoEndAfterBookingEnabled,
  isAutoEndAfterEmergencyEnabled,
  getAutoEndDelayMs,
  getEmergencyEndDelayMs,
  getAutoEndStableIdleMs,
  getThankYouLine,
  endPhoneCallByDeletingRoom,
  waitForAgentSpeechIdle,
  waitForStableAgentIdle,
  waitForAgentSpeechStart,
  getAutoEndSpeechStartMaxMs,
  autoEndCallAfterBooking,
  autoEndCallAfterEmergency,
  scheduleAutoEndAfterBookingConfirmed,
  scheduleAutoEndAfterEmergencyNoted,
};
