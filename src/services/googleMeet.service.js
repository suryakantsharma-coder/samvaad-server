const { google } = require("googleapis");
const env = require("../config/env");
const GoogleOAuthToken = require("../models/googleOAuthToken.model");

const GOOGLE_PROVIDER = "google_calendar";

const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI,
);

let calendarClient = null;

function getCalendar() {
  if (!calendarClient) {
    calendarClient = google.calendar({ version: "v3", auth: oauth2Client });
  }
  return calendarClient;
}

function setOAuthCredentials(tokens) {
  oauth2Client.setCredentials(tokens || {});
}

function generateGoogleAuthUrl(state) {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent",
    ...(state ? { state } : {}),
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

async function saveOAuthTokens(tokens) {
  if (!tokens || (!tokens.refresh_token && !tokens.access_token)) return null;

  const existing = await GoogleOAuthToken.findOne({
    provider: GOOGLE_PROVIDER,
  }).lean();
  const doc = toStoredTokenDoc(tokens);

  if (!doc.refreshToken && existing?.refreshToken) {
    doc.refreshToken = existing.refreshToken;
  }

  return GoogleOAuthToken.findOneAndUpdate(
    { provider: GOOGLE_PROVIDER },
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function loadOAuthTokens() {
  const tokenDoc = await GoogleOAuthToken.findOne({
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

async function ensureCalendarAuth() {
  const savedTokens = await loadOAuthTokens();
  if (!savedTokens?.refresh_token && !savedTokens?.access_token) {
    throw new Error(
      "Google Calendar is not connected. Complete OAuth via /auth/google first.",
    );
  }

  // Setting refresh_token is enough for googleapis to auto-refresh access tokens.
  setOAuthCredentials({
    refresh_token: savedTokens.refresh_token,
    access_token: savedTokens.access_token,
    expiry_date: savedTokens.expiry_date,
    scope: savedTokens.scope,
    token_type: savedTokens.token_type,
  });
}

async function exchangeCodeAndStoreTokens(code) {
  const { tokens } = await oauth2Client.getToken(code);
  setOAuthCredentials(tokens);
  await saveOAuthTokens(tokens);
  return tokens;
}

oauth2Client.on("tokens", async (tokens) => {
  try {
    await saveOAuthTokens(tokens);
  } catch (err) {
    console.error(
      "[Google OAuth] Failed to persist refreshed token:",
      err.message,
    );
  }
});

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
 * Requires prior OAuth consent and stored refresh token in DB.
 *
 * @param {{ email?: string, attendeeEmails?: string[], startTime: string, endTime: string, summary?: string, description?: string }} params
 * @returns {Promise<string>} Meet URL
 */
async function createMeetLink({
  email,
  attendeeEmails = [],
  startTime,
  endTime,
  summary = "Online Consultation",
  description = "Doctor Appointment",
}) {
  await ensureCalendarAuth();

  const calendar = getCalendar();
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

  // Some tenants return conference data only after a follow-up GET.
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
  createMeetLink,
  oauth2Client,
  setOAuthCredentials,
  generateGoogleAuthUrl,
  exchangeCodeAndStoreTokens,
  loadOAuthTokens,
};
