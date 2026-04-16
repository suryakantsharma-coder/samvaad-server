const fs = require("fs");
const path = require("path");

/**
 * One folder per normalized caller (10-digit India mobile when known).
 * All human-readable fields in saved JSON should be English; see post-call pipeline.
 */
const CALLER_NUMBERS_ROOT = path.join(__dirname, "..", "..", "caller-numbers");

function normalizeCallerKey(callerPhone) {
  if (callerPhone == null || String(callerPhone).trim() === "") {
    return "unknown-caller";
  }
  const digits = String(callerPhone).replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  if (digits.length > 0) return digits;
  return "unknown-caller";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readRegistry() {
  const regPath = path.join(CALLER_NUMBERS_ROOT, "_registry.json");
  if (!fs.existsSync(regPath)) {
    return { schemaVersion: 1, callers: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(regPath, "utf8"));
    if (!data || typeof data !== "object") return { schemaVersion: 1, callers: [] };
    if (!Array.isArray(data.callers)) data.callers = [];
    return data;
  } catch {
    return { schemaVersion: 1, callers: [] };
  }
}

function writeRegistry(registry) {
  const regPath = path.join(CALLER_NUMBERS_ROOT, "_registry.json");
  ensureDir(CALLER_NUMBERS_ROOT);
  fs.writeFileSync(
    regPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
  );
}

/**
 * @param {string} phoneKey — normalized 10-digit
 * @param {{ lastCallAt: string, hospitalId: string }} meta
 */
function upsertCallerRegistry(phoneKey, meta) {
  if (!phoneKey || phoneKey === "unknown-caller") return;
  const registry = readRegistry();
  const callers = registry.callers || [];
  const idx = callers.findIndex((c) => c.phone === phoneKey);
  const entry = {
    phone: phoneKey,
    lastCallAt: meta.lastCallAt,
    lastHospitalId: meta.hospitalId || "",
  };
  if (idx >= 0) callers[idx] = { ...callers[idx], ...entry };
  else callers.push(entry);
  callers.sort((a, b) => String(b.lastCallAt).localeCompare(String(a.lastCallAt)));
  registry.callers = callers;
  registry.schemaVersion = 1;
  writeRegistry(registry);
}

/**
 * Overwrites previous session files for this caller key.
 * @param {object} payload
 * @param {string|null} payload.callerPhone — 10-digit preferred
 * @param {object[]} payload.originalTranscript — raw STT (any language)
 * @param {object[]} payload.englishTranscript — required English lines for storage
 * @returns {string} path to latest.json
 */
function writeLatestTranscript(payload) {
  const phoneRaw = payload.callerPhone ?? payload.callerPhoneNumber;
  const key = normalizeCallerKey(phoneRaw);
  const dir = path.join(CALLER_NUMBERS_ROOT, key);
  ensureDir(dir);
  const filePath = path.join(dir, "latest.json");
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  upsertCallerRegistry(key, {
    lastCallAt: payload.savedAt || new Date().toISOString(),
    hospitalId: payload.hospitalId || "",
  });

  return filePath;
}

/**
 * @param {string} callerKey — from normalizeCallerKey
 * @param {object} extractionPayload
 */
function writeExtractionSidecar(callerKey, extractionPayload) {
  const dir = path.join(CALLER_NUMBERS_ROOT, callerKey);
  ensureDir(dir);
  const filePath = path.join(dir, "extraction.json");
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(extractionPayload, null, 2)}\n`,
    "utf8",
  );
  return filePath;
}

module.exports = {
  CALLER_NUMBERS_ROOT,
  normalizeCallerKey,
  writeLatestTranscript,
  writeExtractionSidecar,
};
