const DoctorModel = require("../models/doctor.model");
const {
  resolveAvgPatientTimeMinutes,
  resolveHourBucketCapacity,
} = require("./checkupDuration");

/** @type {Map<string, { expiresAt: number, doctorListText: string, hospitalUpdatedAt: number | null }>} */
const doctorListCache = new Map();

function parseEnvMs(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function cacheTtlMs() {
  return parseEnvMs("HOSPITAL_INSTRUCTION_CACHE_MS", 5 * 60 * 1000);
}

function isCompactDoctorPrompt() {
  const v = process.env.AGENT_COMPACT_HOSPITAL_PROMPT;
  if (v == null || v === "") {
    return process.env.NODE_ENV === "production";
  }
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/**
 * @param {Record<string, unknown>} d
 * @param {boolean} compact
 */
function formatDoctorLine(d, compact) {
  const id = d._id ? String(d._id) : "";
  if (compact) {
    return (
      `**doctorObjectId=\`${id}\`** · Dr. ${d.fullName}` +
      (d.designation ? ` (${d.designation})` : "") +
      (d.status && d.status !== "On Duty" ? ` — ${d.status}` : "")
    );
  }
  const avgMin = resolveAvgPatientTimeMinutes(d);
  const perSlot = resolveHourBucketCapacity(d);
  return (
    `**doctorObjectId=\`${id}\`** · Dr. ${d.fullName} (${d.availability || "9 AM – 5 PM"})` +
    ` · avg ${avgMin} min/patient · ${perSlot} patient${perSlot === 1 ? "" : "s"}/hour slot` +
    (d.status && d.status !== "On Duty" ? ` — ${d.status}` : "")
  );
}

/**
 * @param {Array<Record<string, unknown>>} doctors
 * @param {boolean} compact
 */
function buildDoctorListText(doctors, compact) {
  if (!doctors || doctors.length === 0) {
    return "No doctors currently available.";
  }
  const byDept = {};
  for (const d of doctors) {
    const dept = d.designation || "General";
    (byDept[dept] = byDept[dept] || []).push(d);
  }
  return Object.entries(byDept)
    .map(([dept, list]) => {
      const items = list.map((d) => formatDoctorLine(d, compact)).join(", ");
      return `${dept}: ${items}`;
    })
    .join("\n");
}

/**
 * Cached doctor list for system prompt (TTL + compact mode in production).
 * @param {{ _id: unknown, updatedAt?: Date | string | null }} hospital
 */
async function getDoctorListTextForHospital(hospital) {
  const hospitalId = String(hospital._id);
  const ttl = cacheTtlMs();
  const compact = isCompactDoctorPrompt();
  const updatedAtMs = hospital.updatedAt
    ? new Date(hospital.updatedAt).getTime()
    : null;
  const cacheKey = `${hospitalId}:${compact ? "c" : "f"}`;
  const now = Date.now();
  const hit = doctorListCache.get(cacheKey);
  if (hit && hit.expiresAt > now && hit.hospitalUpdatedAt === updatedAtMs) {
    return hit.doctorListText;
  }

  const doctors = await DoctorModel.find({ hospital: hospital._id })
    .select("fullName designation availability status averagePatientTime")
    .lean();

  const doctorListText = buildDoctorListText(doctors, compact);
  doctorListCache.set(cacheKey, {
    expiresAt: now + ttl,
    doctorListText,
    hospitalUpdatedAt: updatedAtMs,
  });
  return doctorListText;
}

function clearHospitalInstructionCache() {
  doctorListCache.clear();
}

module.exports = {
  getDoctorListTextForHospital,
  buildDoctorListText,
  clearHospitalInstructionCache,
  isCompactDoctorPrompt,
};

// comment to push to github
