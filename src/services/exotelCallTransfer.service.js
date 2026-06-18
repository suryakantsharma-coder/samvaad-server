const env = require("../config/env");

const LOG_TAG = "[ExotelTransfer]";

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

function assertExotelConfigured() {
  if (!env.EXOTEL_ACCOUNT_SID || !env.EXOTEL_API_KEY || !env.EXOTEL_API_TOKEN) {
    throw new Error(
      "Exotel config missing. Set EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN in .env",
    );
  }
}

function buildBaseAuth() {
  const basic = Buffer.from(`${env.EXOTEL_API_KEY}:${env.EXOTEL_API_TOKEN}`).toString(
    "base64",
  );
  return `Basic ${basic}`;
}

function exotelConnectUrl() {
  const region = (env.EXOTEL_REGION || "in").trim() || "in";
  return `https://api.${region}.exotel.com/v1/Accounts/${env.EXOTEL_ACCOUNT_SID}/Calls/connect`;
}

function toE164(raw, defaultCountryCode = "+91") {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return s.replace(/\s/g, "");
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return s;
}

function toExotelDialString(raw) {
  const e164 = toE164(raw);
  if (!e164) return "";
  if (e164.startsWith("+91") && e164.length === 13) return `0${e164.slice(3)}`;
  return e164.replace(/^\+/, "");
}

async function exotelConnectCallerToEmergency(p) {
  assertExotelConfigured();
  const callerId = String(
    p.callerId || env.EXOTEL_CALLER_ID || env.EXOTEL_EXOPHONE || "",
  ).trim();
  if (!callerId) {
    const out = {
      ok: false,
      code: "EXOTEL_CALLER_ID_MISSING",
      message:
        "Set EXOTEL_CALLER_ID (your ExoPhone) in .env for emergency call transfer fallback.",
    };
    logTransfer("error", "exotel_connect_skipped", { reason: out.code, message: out.message });
    return out;
  }

  const from = toExotelDialString(p.callerPhone);
  const to = toExotelDialString(p.emergencyNumber);
  if (!from || from.length < 10) {
    const out = {
      ok: false,
      code: "CALLER_PHONE_MISSING",
      message: "Caller phone is required for Exotel emergency connect.",
    };
    logTransfer("error", "exotel_connect_skipped", { reason: out.code, message: out.message });
    return out;
  }
  if (!to || to.length < 10) {
    const out = {
      ok: false,
      code: "EMERGENCY_NUMBER_MISSING",
      message: "Hospital emergency number is not configured.",
    };
    logTransfer("error", "exotel_connect_skipped", { reason: out.code, message: out.message });
    return out;
  }

  const callerIdDial =
    callerId.replace(/\D/g, "").length >= 10
      ? callerId.replace(/\D/g, "")
      : callerId;

  const body = new URLSearchParams({
    From: from,
    To: to,
    CallerId: callerIdDial,
    CallType: "trans",
  });

  const url = exotelConnectUrl();
  logTransfer("info", "exotel_connect_request", {
    url,
    from: maskPhone(from),
    to: maskPhone(to),
    callerId: maskPhone(callerIdDial),
    callType: "trans",
  });

  let res;
  let rawText = "";
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: buildBaseAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    rawText = await res.text();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logTransfer("error", "exotel_connect_network_error", {
      message: msg,
      from: maskPhone(from),
      to: maskPhone(to),
    });
    return {
      ok: false,
      code: "EXOTEL_CONNECT_NETWORK_ERROR",
      message: msg,
      httpStatus: null,
    };
  }

  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { _rawBody: rawText.slice(0, 2000) };
  }

  const httpStatus = res.status;

  if (!res.ok) {
    const msg =
      data?.RestException?.Message ||
      data?.message ||
      `Exotel connect HTTP ${httpStatus}`;
    logTransfer("error", "exotel_connect_failed", {
      httpStatus,
      message: msg,
      restException: data?.RestException || null,
      response: data,
    });
    return {
      ok: false,
      code: "EXOTEL_CONNECT_FAILED",
      message: msg,
      httpStatus,
      response: data,
    };
  }

  const call = data?.Call || data?.call || null;
  const out = {
    ok: true,
    method: "exotel_connect",
    callSid: call?.Sid ? String(call.Sid) : null,
    status: call?.Status ? String(call.Status) : null,
    httpStatus,
    response: data,
  };
  logTransfer("info", "exotel_connect_success", {
    httpStatus,
    callSid: out.callSid,
    status: out.status,
    direction: call?.Direction ? String(call.Direction) : null,
    uri: call?.Uri ? String(call.Uri) : null,
    response: data,
  });
  return out;
}

module.exports = {
  toE164,
  toExotelDialString,
  exotelConnectCallerToEmergency,
};
