const crypto = require("crypto");
const mongoose = require("mongoose");
const { google } = require("googleapis");
const env = require("../config/env");
const GoogleOAuthToken = require("../models/googleOAuthToken.model");

const GOOGLE_PROVIDER = GoogleOAuthToken.GOOGLE_PROVIDER || "google_calendar";

function newOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

function getStateSecret() {
  const s =
    (env.GOOGLE_OAUTH_STATE_SECRET || env.JWT_ACCESS_SECRET || "").trim();
  return s;
}

/**
 * Signed OAuth state: base64url(hospitalId.exp.hmacHex). Expires in 15 minutes.
 */
function encodeOAuthState(hospitalId) {
  const secret = getStateSecret();
  if (!secret) {
    throw new Error(
      "Set GOOGLE_OAUTH_STATE_SECRET (or JWT_ACCESS_SECRET) for Google OAuth state signing",
    );
  }
  if (!mongoose.isValidObjectId(String(hospitalId))) {
    throw new Error("Invalid hospitalId for OAuth state");
  }
  const exp = Date.now() + 15 * 60 * 1000;
  const payload = `${String(hospitalId).trim()}.${exp}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

function decodeAndVerifyOAuthState(stateParam) {
  const secret = getStateSecret();
  if (!secret) {
    throw new Error("OAuth state secret not configured");
  }
  const decoded = Buffer.from(String(stateParam), "base64url").toString("utf8");
  const lastDot = decoded.lastIndexOf(".");
  if (lastDot <= 0) {
    throw new Error("Invalid OAuth state");
  }
  const sig = decoded.slice(lastDot + 1);
  const payload = decoded.slice(0, lastDot);
  const parts = payload.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid OAuth state payload");
  }
  const [hospitalId, expStr] = parts;
  if (!mongoose.isValidObjectId(hospitalId)) {
    throw new Error("Invalid hospital in OAuth state");
  }
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid OAuth state signature");
  }
  if (Date.now() > parseInt(expStr, 10)) {
    throw new Error("OAuth state expired");
  }
  return { hospitalId };
}

function generateGoogleAuthUrlForHospital(hospitalId) {
  const state = encodeOAuthState(hospitalId);
  const client = newOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent",
    state,
  });
}

function toStoredTokenDoc(tokens) {
  return {
    provider: GOOGLE_PROVIDER,
    accessToken: tokens.access_token || "",
    refreshToken: tokens.refresh_token || "",
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    scope: tokens.scope || "",
    tokenType: tokens.token_type || "",
  };
}

async function saveOAuthTokens(hospitalId, tokens) {
  if (!mongoose.isValidObjectId(String(hospitalId))) {
    throw new Error("Invalid hospitalId for storing Google tokens");
  }
  if (!tokens || (!tokens.refresh_token && !tokens.access_token)) {
    return null;
  }

  const hid = new mongoose.Types.ObjectId(String(hospitalId));
  const existing = await GoogleOAuthToken.findOne({
    hospital: hid,
    provider: GOOGLE_PROVIDER,
  }).lean();
  const doc = toStoredTokenDoc(tokens);

  if (!doc.refreshToken && existing?.refreshToken) {
    doc.refreshToken = existing.refreshToken;
  }

  return GoogleOAuthToken.findOneAndUpdate(
    { hospital: hid, provider: GOOGLE_PROVIDER },
    { $set: { ...doc, hospital: hid } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function loadOAuthTokens(hospitalId) {
  if (!mongoose.isValidObjectId(String(hospitalId))) {
    return null;
  }
  const hid = new mongoose.Types.ObjectId(String(hospitalId));
  const tokenDoc = await GoogleOAuthToken.findOne({
    hospital: hid,
    provider: GOOGLE_PROVIDER,
  }).lean();
  if (!tokenDoc) return null;

  return {
    access_token: tokenDoc.accessToken || undefined,
    refresh_token: tokenDoc.refreshToken || undefined,
    expiry_date: tokenDoc.expiryDate
      ? new Date(tokenDoc.expiryDate).getTime()
      : undefined,
    scope: tokenDoc.scope || undefined,
    token_type: tokenDoc.tokenType || undefined,
  };
}

async function getCalendarConnectionStatus(hospitalId) {
  const tokenDoc = await GoogleOAuthToken.findOne({
    hospital: new mongoose.Types.ObjectId(String(hospitalId)),
    provider: GOOGLE_PROVIDER,
  })
    .select("accessToken refreshToken expiryDate")
    .lean();

  const hasAccess = Boolean(tokenDoc?.accessToken);
  const hasRefresh = Boolean(tokenDoc?.refreshToken);
  const connected = hasAccess || hasRefresh;

  return {
    connected,
    hasRefreshToken: hasRefresh,
    accessTokenExpiresAt: tokenDoc?.expiryDate
      ? new Date(tokenDoc.expiryDate).toISOString()
      : null,
  };
}

async function ensureCalendarAuth(hospitalId) {
  if (!mongoose.isValidObjectId(String(hospitalId))) {
    throw new Error("Valid hospitalId is required for Google Calendar");
  }
  const savedTokens = await loadOAuthTokens(hospitalId);
  if (!savedTokens?.refresh_token && !savedTokens?.access_token) {
    throw new Error(
      `Google Calendar is not connected for this hospital. Complete OAuth via GET /api/hospitals/${hospitalId}/google-calendar/auth-url`,
    );
  }

  const client = newOAuth2Client();
  client.setCredentials({
    refresh_token: savedTokens.refresh_token,
    access_token: savedTokens.access_token,
    expiry_date: savedTokens.expiry_date,
    scope: savedTokens.scope,
    token_type: savedTokens.token_type,
  });

  client.on("tokens", async (t) => {
    try {
      await saveOAuthTokens(hospitalId, t);
    } catch (err) {
      console.error(
        "[Google OAuth] Failed to persist refreshed token:",
        err.message,
      );
    }
  });

  return client;
}

async function exchangeCodeAndStoreTokensForHospital(code, stateParam) {
  const { hospitalId } = decodeAndVerifyOAuthState(stateParam);
  const client = newOAuth2Client();
  const { tokens } = await client.getToken(code);
  await saveOAuthTokens(hospitalId, tokens);
  return { hospitalId, tokens };
}

/**
 * Pull Meet / conference URL from Calendar API event resource.
 * @param {import('googleapis').calendar_v3.Schema$Event} data
 * @returns {string|null}
 */
function extractMeetLinkFromEvent(data) {
  if (!data) return null;
  if (data.hangoutLink) return data.hangoutLink;

  const entryPoints = data.conferenceData?.entryPoints;
  if (!Array.isArray(entryPoints) || entryPoints.length === 0) return null;

  for (const ep of entryPoints) {
    const u = ep.uri;
    if (u && /meet\.google\.com/i.test(u)) return u;
  }
  for (const ep of entryPoints) {
    if (ep.uri) return ep.uri;
  }
  return null;
}

/**
 * Creates a Calendar event with Google Meet and returns the meeting link.
 * Uses OAuth tokens stored for the given hospital.
 *
 * @param {{ hospitalId: string, email?: string, attendeeEmails?: string[], startTime: string, endTime: string, summary?: string, description?: string }} params
 * @returns {Promise<string>} Meet URL
 */
async function createMeetLink({
  hospitalId,
  email,
  attendeeEmails = [],
  startTime,
  endTime,
  summary = "Online Consultation",
  description = "Doctor Appointment",
}) {
  const auth = await ensureCalendarAuth(hospitalId);
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";
  const uniqueAttendeeEmails = [
    ...new Set(
      [...attendeeEmails, email]
        .map((value) => (value == null ? "" : String(value).trim()))
        .filter(Boolean),
    ),
  ];

  if (uniqueAttendeeEmails.length === 0) {
    throw new Error("At least one attendee email is required to create a Meet link");
  }

  const event = {
    summary,
    description,
    start: {
      dateTime: startTime,
      timeZone: "Asia/Kolkata",
    },
    end: {
      dateTime: endTime,
      timeZone: "Asia/Kolkata",
    },
    attendees: uniqueAttendeeEmails.map((attendeeEmail) => ({
      email: attendeeEmail,
    })),
    conferenceData: {
      createRequest: {
        requestId: `meet-${Date.now()}`,
        conferenceSolutionKey: {
          type: "hangoutsMeet",
        },
      },
    },
  };

  const response = await calendar.events.insert({
    calendarId,
    resource: event,
    conferenceDataVersion: 1,
    sendUpdates: "all",
  });

  let data = response.data;
  let link = extractMeetLinkFromEvent(data);

  if (!link && data?.id) {
    const fetched = await calendar.events.get({
      calendarId,
      eventId: data.id,
    });
    data = fetched.data;
    link = extractMeetLinkFromEvent(data);
  }

  if (link) return link;

  const hint =
    data?.conferenceData?.createRequest?.status?.statusCode === "failure"
      ? ` Conference creation failed: ${data.conferenceData.createRequest.status?.failureType || "unknown"}.`
      : "";
  console.warn(
    "[Google Meet] No link in response. conferenceData:",
    JSON.stringify(data?.conferenceData || {}, null, 0).slice(0, 500),
  );
  throw new Error(
    `Calendar event was created (id: ${data?.id || "?"}) but no Meet link was returned.${hint} Ensure Meet is enabled and OAuth user has access to calendarId "${calendarId}".`,
  );
}

module.exports = {
  GOOGLE_PROVIDER,
  createMeetLink,
  generateGoogleAuthUrlForHospital,
  exchangeCodeAndStoreTokensForHospital,
  encodeOAuthState,
  decodeAndVerifyOAuthState,
  loadOAuthTokens,
  saveOAuthTokens,
  getCalendarConnectionStatus,
  ensureCalendarAuth,
};
