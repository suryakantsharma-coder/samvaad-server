const { SipClient } = require("livekit-server-sdk");
const {
  exotelConnectCallerToEmergency,
  toE164,
} = require("../src/services/exotelCallTransfer.service");
const { resolveCallTransferContext } = require("./resolveCallTransferContext");

const LOG_TAG = "[EmergencyTransfer]";

function maskPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
}

function logTransfer(level, event, payload) {
  const line = JSON.stringify({ event, ...payload });
  if (level === "error") console.error(LOG_TAG, line);
  else if (level === "warn") console.warn(LOG_TAG, line);
  else console.log(LOG_TAG, line);
}

function getEmergencyConnectingInstructions(lang) {
  if (lang === "en") {
    return (
      "URGENT_ONE_TURN — The caller confirmed this is an EMERGENCY. You are Neha (female receptionist). " +
      'Say exactly ONE short English line: "I\'m connecting you to the emergency department now. Please wait." ' +
      "Do NOT ask any more questions. Do NOT call booking tools."
    );
  }
  if (lang === "gu") {
    return (
      "URGENT_ONE_TURN — The caller confirmed this is an EMERGENCY. You are Neha (female receptionist). " +
      'Say exactly ONE short Gujarati line: "હું તમને ઇમરજન્સી વિભાગ સાથે જોડી રહી છું. કૃપા કરીને રાહ જુઓ." ' +
      "Do NOT ask any more questions. Do NOT call booking tools."
    );
  }
  return (
    "URGENT_ONE_TURN — The caller confirmed this is an EMERGENCY. You are Neha (female receptionist). " +
    'Say exactly ONE short Hindi line: "मैं आपको आपातकाल विभाग से जोड़ रही हूँ। कृपया प्रतीक्षा करें।" ' +
    "Do NOT ask any more questions. Do NOT call booking tools."
  );
}

function buildLiveKitSipClient() {
  const host = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!host || !apiKey || !apiSecret) return null;
  return new SipClient(host, apiKey, apiSecret);
}

/** Build candidate REFER targets — Exotel often rejects tel: URIs. */
function buildSipTransferTargets(emergencyNumber) {
  const e164 = toE164(emergencyNumber);
  if (!e164) return [];
  const targets = [];
  const sipDomain = String(process.env.EXOTEL_SIP_DOMAIN || "").trim();
  if (sipDomain) {
    targets.push(`sip:${e164}@${sipDomain}`);
    targets.push(`sip:${e164.replace(/^\+/, "")}@${sipDomain}`);
  }
  targets.push(`tel:${e164}`);
  return [...new Set(targets)];
}

async function livekitTransferSipToEmergency(p) {
  const sip = buildLiveKitSipClient();
  if (!sip) {
    const out = {
      ok: false,
      code: "LIVEKIT_NOT_CONFIGURED",
      message: "LiveKit credentials missing for SIP transfer.",
    };
    logTransfer("error", "livekit_sip_skipped", { reason: out.code, message: out.message });
    return out;
  }

  const targets = buildSipTransferTargets(p.emergencyNumber);
  if (!targets.length) {
    const out = {
      ok: false,
      code: "EMERGENCY_NUMBER_MISSING",
      message: "Hospital emergency number is not configured.",
    };
    logTransfer("error", "livekit_sip_skipped", { reason: out.code, message: out.message });
    return out;
  }

  let lastErr = null;
  for (const transferTo of targets) {
    logTransfer("info", "livekit_sip_request", {
      roomName: p.roomName,
      participantIdentity: p.participantIdentity,
      transferTo: maskPhone(transferTo),
      playDialtone: true,
    });
    try {
      await sip.transferSipParticipant(
        p.roomName,
        p.participantIdentity,
        transferTo,
        { playDialtone: true },
      );
      const out = {
        ok: true,
        method: "livekit_sip_refer",
        transferTo,
        roomName: p.roomName,
        participantIdentity: p.participantIdentity,
      };
      logTransfer("info", "livekit_sip_success", {
        roomName: p.roomName,
        participantIdentity: p.participantIdentity,
        transferTo: maskPhone(transferTo),
      });
      return out;
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      logTransfer("warn", "livekit_sip_attempt_failed", {
        roomName: p.roomName,
        transferTo: maskPhone(transferTo),
        message: msg,
        errorName: err && err.name ? err.name : null,
      });
    }
  }

  const msg = lastErr && lastErr.message ? lastErr.message : "All SIP transfer targets failed";
  logTransfer("error", "livekit_sip_failed", {
    roomName: p.roomName,
    participantIdentity: p.participantIdentity,
    message: msg,
    triedTargets: targets.map((t) => maskPhone(t)),
  });
  return {
    ok: false,
    code: "LIVEKIT_SIP_TRANSFER_FAILED",
    message: msg,
    method: "livekit_sip_refer",
  };
}

async function transferCallerToEmergencyNumber(p) {
  const ctx = resolveCallTransferContext({
    room: p.room || null,
    jobMetadata: p.jobMetadata,
    roomMetadata: p.roomMetadata,
  });

  const callerPhone =
    String(p.callerPhone || "").trim() ||
    String(ctx.sipCallerPhone || "").trim() ||
    null;

  const roomName = String(p.roomName || "").trim();
  const sipIdentity = ctx.sipParticipantIdentity;

  logTransfer("info", "transfer_attempt_start", {
    roomName: roomName || null,
    sipParticipantIdentity: sipIdentity || null,
    exotelCallSid: ctx.exotelCallSid || null,
    callerPhone: maskPhone(callerPhone),
    emergencyNumber: maskPhone(p.emergencyNumber),
    strategy: roomName && sipIdentity ? "livekit_sip_then_exotel" : "exotel_only",
  });

  if (roomName && sipIdentity) {
    const sipResult = await livekitTransferSipToEmergency({
      roomName,
      participantIdentity: sipIdentity,
      emergencyNumber: p.emergencyNumber,
    });
    if (sipResult.ok) {
      const merged = { ...sipResult, exotelCallSid: ctx.exotelCallSid || null };
      logTransfer("info", "transfer_attempt_success", {
        method: merged.method,
        callSid: merged.callSid || ctx.exotelCallSid || null,
        httpStatus: merged.httpStatus || null,
      });
      return merged;
    }
    logTransfer("warn", "livekit_sip_fallback_to_exotel", {
      code: sipResult.code,
      message: sipResult.message,
    });
  } else {
    logTransfer("warn", "livekit_sip_unavailable", {
      reason: !roomName ? "missing_room_name" : "missing_sip_participant",
      fallback: "exotel_connect",
    });
  }

  if (!callerPhone) {
    const out = {
      ok: false,
      code: "TRANSFER_UNAVAILABLE",
      message:
        "Could not transfer: no SIP participant for LiveKit REFER and caller phone unknown for Exotel connect.",
    };
    logTransfer("error", "transfer_attempt_failed", {
      code: out.code,
      message: out.message,
    });
    return out;
  }

  try {
    const exResult = await exotelConnectCallerToEmergency({
      callerPhone,
      emergencyNumber: p.emergencyNumber,
    });
    const merged = { ...exResult, exotelCallSid: ctx.exotelCallSid || null };
    if (merged.ok) {
      logTransfer("info", "transfer_attempt_success", {
        method: merged.method,
        callSid: merged.callSid || merged.exotelCallSid || null,
        httpStatus: merged.httpStatus || null,
        status: merged.status || null,
      });
    } else {
      logTransfer("error", "transfer_attempt_failed", {
        method: merged.method || "exotel_connect",
        code: merged.code,
        message: merged.message,
        httpStatus: merged.httpStatus || null,
      });
    }
    return merged;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logTransfer("error", "transfer_attempt_failed", {
      method: "exotel_connect",
      code: "EXOTEL_TRANSFER_ERROR",
      message: msg,
    });
    return { ok: false, code: "EXOTEL_TRANSFER_ERROR", message: msg };
  }
}

async function handleEmergencyCaseTransfer(p) {
  const { agent, hospital, session } = p;
  if (!agent || agent.emergencyTransferStarted) {
    return { ok: false, code: "ALREADY_STARTED" };
  }
  agent.emergencyTransferStarted = true;

  const emergencyNumber = String(hospital?.emergencyNumber || "").trim();
  if (!emergencyNumber) {
    console.error("[EmergencyTransfer] Hospital has no emergencyNumber configured.");
    return {
      ok: false,
      code: "EMERGENCY_NUMBER_MISSING",
      message: "Hospital emergency number is not configured.",
    };
  }

  const lang =
    agent.preferredLanguage === "en"
      ? "en"
      : agent.preferredLanguage === "gu"
        ? "gu"
        : "hi";

  const logger =
    agent && typeof agent.getCallLogger === "function"
      ? agent.getCallLogger()
      : null;

  if (logger) {
    logger.log("emergency_transfer_start", {
      lang,
      emergencyNumber: emergencyNumber.replace(/\d(?=\d{4})/g, "*"),
    });
  }

  if (session && typeof session.generateReply === "function") {
    try {
      if (logger) {
        logger.log("generate_reply", { purpose: "emergency_connecting", lang });
      }
      const handle = session.generateReply({
        toolChoice: "none",
        instructions: getEmergencyConnectingInstructions(lang),
      });
      if (handle && typeof handle.waitForPlayout === "function") {
        await handle.waitForPlayout();
      }
    } catch (err) {
      console.warn(
        "[EmergencyTransfer] connecting message failed:",
        err && err.message ? err.message : err,
      );
    }
  }

  const transferResult = await transferCallerToEmergencyNumber({
    roomName: p.roomName,
    room: p.room,
    jobMetadata: p.jobMetadata,
    roomMetadata: p.roomMetadata,
    callerPhone: p.callerPhone,
    emergencyNumber,
  });

  if (logger) {
    logger.log("emergency_transfer_end", {
      ok: Boolean(transferResult.ok),
      method: transferResult.method || null,
      code: transferResult.code || null,
      message: transferResult.message || null,
      httpStatus: transferResult.httpStatus ?? null,
      callSid: transferResult.callSid || transferResult.exotelCallSid || null,
      status: transferResult.status || null,
      transferTo: transferResult.transferTo
        ? maskPhone(transferResult.transferTo)
        : null,
      roomName: transferResult.roomName || p.roomName || null,
      hospitalName: hospital?.name || null,
    });
  }

  if (transferResult.ok) {
    logTransfer("info", "handle_emergency_success", {
      hospitalName: hospital?.name || null,
      method: transferResult.method,
      callSid: transferResult.callSid || transferResult.exotelCallSid || null,
      httpStatus: transferResult.httpStatus ?? null,
      status: transferResult.status || null,
    });
  } else {
    logTransfer("error", "handle_emergency_failed", {
      hospitalName: hospital?.name || null,
      code: transferResult.code,
      message: transferResult.message,
      httpStatus: transferResult.httpStatus ?? null,
    });
    if (session && typeof session.generateReply === "function") {
      try {
        const failLine =
          lang === "en"
            ? "I'm sorry — I could not connect the transfer automatically. Please call the hospital emergency number directly or visit the emergency department immediately."
            : "माफ़ कीजिए — मैं कॉल अपने आप ट्रांसफ़र नहीं कर पाई। कृपया सीधे अस्पताल की आपातकालीन नंबर पर कॉल करें या तुरंत इमरजेंसी में आएँ।";
        session.generateReply({
          toolChoice: "none",
          instructions:
            "Say exactly this once in the caller's language, calmly:\n" + failLine,
        });
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (session && typeof session.close === "function" && !session.closing) {
    try {
      await session.close();
    } catch (closeErr) {
      console.warn(
        "[EmergencyTransfer] session.close:",
        closeErr && closeErr.message ? closeErr.message : closeErr,
      );
    }
  }

  return transferResult;
}

function didJustConfirmEmergency(slotsBefore, slotsAfter) {
  return (
    slotsAfter &&
    slotsAfter.caseType === "emergency" &&
    (!slotsBefore || slotsBefore.caseType !== "emergency")
  );
}

module.exports = {
  getEmergencyConnectingInstructions,
  transferCallerToEmergencyNumber,
  handleEmergencyCaseTransfer,
  didJustConfirmEmergency,
};
