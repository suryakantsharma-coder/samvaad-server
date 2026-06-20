/** @param {string} name @param {number} def */
function parseEnvMs(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** @param {string} name @param {number} def */
function parseEnvInt(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

/** @param {string} name @param {number} def */
function parseEnvFloat(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function isVerboseConnectionLogs() {
  const v = process.env.AGENT_VERBOSE_CONNECTION_LOGS;
  if (v != null && v !== "") {
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes";
  }
  return process.env.NODE_ENV !== "production";
}

function shouldSkipPostCallExtraction() {
  const v = process.env.AGENT_SKIP_POSTCALL_IF_BOOKED;
  if (v == null || v === "") return true;
  const s = String(v).trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "no");
}

module.exports = {
  parseEnvMs,
  parseEnvInt,
  parseEnvFloat,
  isVerboseConnectionLogs,
  shouldSkipPostCallExtraction,
};
