const ExotelCall = require("../models/exotelCall.model");
const env = require("../config/env");
const { toDigits } = require("./callAnalytics.service");

function pad2(v) {
  return String(v).padStart(2, "0");
}

function formatExotelDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function monthStartUtc(year, month1) {
  return new Date(Date.UTC(year, month1 - 1, 1, 0, 0, 0));
}

function monthEndUtc(year, month1) {
  return new Date(Date.UTC(year, month1, 0, 23, 59, 59));
}

function toMonthKey(year, month1) {
  return `${year}-${pad2(month1)}`;
}

function parseExotelDateMaybe(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const iso = s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function assertExotelConfigured() {
  if (!env.EXOTEL_ACCOUNT_SID || !env.EXOTEL_API_KEY || !env.EXOTEL_API_TOKEN) {
    throw new Error(
      "Exotel config missing. Set EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN in .env"
    );
  }
}

function buildBaseAuth() {
  const basic = Buffer.from(`${env.EXOTEL_API_KEY}:${env.EXOTEL_API_TOKEN}`).toString("base64");
  return `Basic ${basic}`;
}

function exotelBaseUrl() {
  const region = (env.EXOTEL_REGION || "in").trim() || "in";
  return `https://api.${region}.exotel.com/v1/Accounts/${env.EXOTEL_ACCOUNT_SID}/Calls.json`;
}

function pickAfterToken(nextPageUri) {
  if (!nextPageUri) return "";
  try {
    const u = new URL(`https://dummy.local${nextPageUri}`);
    return u.searchParams.get("After") || "";
  } catch {
    return "";
  }
}

async function fetchExotelCallsPage({
  year,
  month,
  pageSize = 100,
  after = "",
}) {
  assertExotelConfigured();
  const start = monthStartUtc(year, month);
  const end = monthEndUtc(year, month);

  const url = new URL(exotelBaseUrl());
  url.searchParams.set(
    "DateCreated",
    `gte:${formatExotelDate(start)};lte:${formatExotelDate(end)}`
  );
  url.searchParams.set("PageSize", String(pageSize));
  url.searchParams.set("SortBy", "DateCreated:desc");
  if (after) url.searchParams.set("After", after);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: buildBaseAuth() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.RestException?.Message || data?.message || `Exotel HTTP ${res.status}`;
    throw new Error(`[Exotel] fetch failed: ${msg}`);
  }
  return data;
}

function mapRawCallToDoc(rawCall, syncMonth) {
  const sid = String(rawCall?.Sid || "").trim();
  if (!sid) return null;
  const duration = Number(rawCall.Duration || 0);
  const phoneNumber = rawCall.PhoneNumber || "";
  return {
    sid,
    callSid: sid,
    accountSid: rawCall.AccountSid || "",
    parentCallSid: rawCall.ParentCallSid || "",
    from: rawCall.From || "",
    to: rawCall.To || "",
    phoneNumber,
    phoneNumberDigits: toDigits(phoneNumber),
    phoneNumberSid: rawCall.PhoneNumberSid || "",
    status: rawCall.Status || "",
    direction: rawCall.Direction || "",
    answeredBy: rawCall.AnsweredBy || "",
    callerName: rawCall.CallerName || "",
    forwardedFrom: rawCall.ForwardedFrom || "",
    customField: rawCall.CustomField || "",
    uri: rawCall.Uri || "",
    recordingUrl: rawCall.RecordingUrl || "",
    dateCreated: parseExotelDateMaybe(rawCall.DateCreated),
    dateUpdated: parseExotelDateMaybe(rawCall.DateUpdated),
    startTime: parseExotelDateMaybe(rawCall.StartTime),
    endTime: parseExotelDateMaybe(rawCall.EndTime),
    duration,
    creditUsed: Math.ceil(Math.max(0, duration) / 60),
    price: Number(rawCall.Price || 0),
    syncMonth,
    raw: rawCall,
  };
}

async function saveCalls(calls, syncMonth) {
  let upserts = 0;
  for (const rawCall of calls) {
    const doc = mapRawCallToDoc(rawCall, syncMonth);
    if (!doc) continue;
    await ExotelCall.findOneAndUpdate(
      { sid: doc.sid },
      { $set: doc },
      { upsert: true, new: false }
    );
    upserts += 1;
  }
  return upserts;
}

async function syncExotelMonth({ year, month, pageSize = 100 }) {
  const syncMonth = toMonthKey(year, month);
  let totalFetched = 0;
  let totalSaved = 0;
  let after = "";

  // Exotel pagination via NextPageUri/After token.
  for (let i = 0; i < 1000; i += 1) {
    const page = await fetchExotelCallsPage({ year, month, pageSize, after });
    const calls = Array.isArray(page?.Calls) ? page.Calls : [];
    totalFetched += calls.length;
    totalSaved += await saveCalls(calls, syncMonth);

    const nextAfter = pickAfterToken(page?.Metadata?.NextPageUri);
    if (!nextAfter || calls.length === 0) break;
    after = nextAfter;
  }

  return { syncMonth, totalFetched, totalSaved };
}

function getCurrentUtcYearMonth() {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/** Calendar month in server local TZ (Asia/Kolkata when TZ is set in index.js). */
function getCurrentLocalYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

module.exports = {
  toMonthKey,
  monthStartUtc,
  monthEndUtc,
  getCurrentUtcYearMonth,
  getCurrentLocalYearMonth,
  syncExotelMonth,
};
