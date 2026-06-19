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

/** Default post-closing delay when caller flow passes speechAlreadyComplete (emergency noted). */
const DEFAULT_SPEECH_COMPLETE_DELAY_MS = 2000;

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

/** Optional extra pause after confirmation audio finishes; default 0 (cut as soon as idle). */
function getAutoEndDelayMs() {
  return parseEnvMs("AGENT_AUTO_END_DELAY_MS", 0);
}

/** Delay after thank-you when speech playout was already awaited (emergency noted). */
function getSpeechCompleteEndDelayMs() {
  const v = parseEnvMs("AGENT_AUTO_END_DELAY_MS", DEFAULT_SPEECH_COMPLETE_DELAY_MS);
  return v > 0 ? v : DEFAULT_SPEECH_COMPLETE_DELAY_MS;
}

/** Agent must stay listening this long before hangup (avoids cutting between speech chunks). */
function getAutoEndStableIdleMs() {
  return parseEnvMs("AGENT_AUTO_END_STABLE_IDLE_MS", 1200);
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
  console.warn(
    LOG_TAG,
    "waitForStableAgentIdle timed out after",
    maxMs,
    "ms",
  );
}

/**
 * After confirmation playout, wait until the agent is idle, then delete the room.
 * No fixed timer by default — booking may take as long as the caller needs; we only
 * hang up once the post-booking status + thank-you lines have finished playing.
 * @param {{
 *   roomName?: string | null,
 *   session?: import('@livekit/agents').voice.AgentSession | null,
 *   logger?: { log?: (type: string, data?: object) => void } | null,
 *   extraDelayMs?: number,
 *   speechAlreadyComplete?: boolean,
 * }} opts
 */
async function autoEndCallAfterBooking(opts = {}) {
  if (!isAutoEndAfterBookingEnabled()) {
    console.warn(LOG_TAG, "auto end skipped: AGENT_AUTO_END_AFTER_BOOKING is disabled");
    return { ok: false, code: "DISABLED" };
  }

  const roomName = opts.roomName;
  const session = opts.session;
  const speechAlreadyComplete = Boolean(opts.speechAlreadyComplete);
  const extraDelayMs = speechAlreadyComplete
    ? opts.extraDelayMs != null
      ? opts.extraDelayMs
      : getSpeechCompleteEndDelayMs()
    : opts.extraDelayMs != null
      ? opts.extraDelayMs
      : getAutoEndDelayMs();
  const logger = opts.logger;
  const purpose = opts.purpose || "post_booking";

  console.log(LOG_TAG, "autoEndCallAfterBooking start", {
    purpose,
    roomName: roomName || "(missing)",
    speechAlreadyComplete,
    extraDelayMs,
  });

  if (session && !speechAlreadyComplete) {
    console.log(LOG_TAG, "waiting for agent stable idle before hangup…");
    await waitForStableAgentIdle(session, getAutoEndStableIdleMs());
  } else if (speechAlreadyComplete) {
    console.log(LOG_TAG, "thank-you / closing speech already complete — skipping idle wait");
  }

  if (session && session.closing) {
    console.warn(LOG_TAG, "auto end aborted: session already closing");
    return { ok: false, code: "SESSION_CLOSING" };
  }

  if (extraDelayMs > 0) {
    console.log(LOG_TAG, `post-speech delay started (${extraDelayMs}ms)`);
    if (logger && typeof logger.log === "function") {
      logger.log("auto_end_extra_delay", {
        delayMs: extraDelayMs,
        roomName: roomName || null,
        purpose,
        speechAlreadyComplete,
      });
    }
    await delay(extraDelayMs);
    console.log(LOG_TAG, "post-speech delay finished");
    if (session && session.closing) {
      console.warn(LOG_TAG, "auto end aborted after delay: session closing");
      return { ok: false, code: "SESSION_CLOSING" };
    }
  }

  console.log(LOG_TAG, "invoking endPhoneCallByDeletingRoom", roomName || "(missing)");
  if (logger && typeof logger.log === "function") {
    logger.log("auto_end_hangup", {
      roomName: roomName || null,
      afterConfirmationIdle: !speechAlreadyComplete,
      purpose,
    });
  }

  const result = await endPhoneCallByDeletingRoom(roomName);
  if (result.ok) {
    console.log(LOG_TAG, "call disconnected successfully", roomName || "");
  } else {
    console.warn(LOG_TAG, "call disconnect failed", result.code, result.message || "");
  }
  if (logger && typeof logger.log === "function") {
    logger.log("auto_end_complete", {
      roomName: roomName || null,
      ok: Boolean(result.ok),
      code: result.code || null,
      purpose,
    });
  }
  return result;
}

/**
 * Schedule hangup after agent closing speech (booking confirmation or emergency goodbye).
 * @param {{
 *   agent: { session?: import('@livekit/agents').voice.AgentSession | null, _callRoomName?: string | null, _emergencyTransferCtx?: { roomName?: string | null } | null, getCallLogger?: () => unknown, postBookingClosingInFlight?: boolean },
 *   purpose?: string,
 *   extraDelayMs?: number,
 *   speechAlreadyComplete?: boolean,
 * }} p
 */
function scheduleAutoEndCall(p) {
  const agent = p && p.agent;
  if (!agent || !isAutoEndAfterBookingEnabled()) {
    console.warn(
      LOG_TAG,
      "scheduleAutoEndCall skipped:",
      !agent ? "no agent" : "AGENT_AUTO_END_AFTER_BOOKING disabled",
    );
    return;
  }

  const roomName =
    (agent._callRoomName && String(agent._callRoomName)) ||
    (agent._emergencyTransferCtx &&
    agent._emergencyTransferCtx.roomName
      ? String(agent._emergencyTransferCtx.roomName)
      : "");
  const session = agent.session || null;
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;
  const purpose = (p && p.purpose) || "auto_end";
  const extraDelayMs = p && p.extraDelayMs != null ? p.extraDelayMs : undefined;
  const speechAlreadyComplete = Boolean(p && p.speechAlreadyComplete);

  if (!roomName) {
    console.warn(LOG_TAG, "scheduleAutoEndCall: roomName missing on agent — hangup may fail");
  }

  agent.postBookingClosingInFlight = true;
  console.log(LOG_TAG, `scheduling auto hangup (${purpose}) for room:`, roomName || "(missing)", {
    speechAlreadyComplete,
    extraDelayMs: extraDelayMs != null ? extraDelayMs : "(default)",
  });

  setImmediate(() => {
    autoEndCallAfterBooking({
      roomName,
      session,
      logger,
      extraDelayMs,
      speechAlreadyComplete,
      purpose,
    })
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        console.error(LOG_TAG, "deferred auto end failed:", msg);
        if (logger && typeof logger.log === "function") {
          logger.log("auto_end_error", { errorMessage: msg, roomName, purpose });
        }
      })
      .finally(() => {
        agent.postBookingClosingInFlight = false;
      });
  });
}

/**
 * Schedule hangup after the create_appointment tool returns to LiveKit Realtime
 * (so tool_response speech can finish before the SIP line drops).
 * @param {{
 *   agent: { session?: import('@livekit/agents').voice.AgentSession | null, _emergencyTransferCtx?: { roomName?: string | null } | null, getCallLogger?: () => unknown, postBookingClosingInFlight?: boolean },
 *   purpose?: string,
 *   extraDelayMs?: number,
 *   speechAlreadyComplete?: boolean,
 * }} p
 */
function scheduleAutoEndAfterBookingConfirmed(p) {
  scheduleAutoEndCall({
    agent: p && p.agent,
    purpose: (p && p.purpose) || "post_booking",
    extraDelayMs: p && p.extraDelayMs,
    speechAlreadyComplete: p && p.speechAlreadyComplete,
  });
}

module.exports = {
  isAutoEndAfterBookingEnabled,
  getAutoEndDelayMs,
  getSpeechCompleteEndDelayMs,
  DEFAULT_SPEECH_COMPLETE_DELAY_MS,
  getAutoEndStableIdleMs,
  getThankYouLine,
  endPhoneCallByDeletingRoom,
  waitForAgentSpeechIdle,
  waitForStableAgentIdle,
  autoEndCallAfterBooking,
  scheduleAutoEndCall,
  scheduleAutoEndAfterBookingConfirmed,
};
