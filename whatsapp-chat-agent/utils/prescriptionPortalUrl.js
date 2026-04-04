const env = require("../../src/config/env");

/**
 * Final URL for a prescription. Prefer WHATSAPP_PRESCRIPTION_URL_BASE + "/" + Mongo _id.
 * Or WHATSAPP_PRESCRIPTION_LINK_TEMPLATE with `{id}`.
 */
function prescriptionViewUrl(prescriptionMongoId) {
  const id = String(prescriptionMongoId || "").trim();
  if (!id) return null;

  const tmpl = (env.WHATSAPP_PRESCRIPTION_LINK_TEMPLATE || "").trim();
  if (tmpl.includes("{id}")) {
    return tmpl.replace(/\{id\}/g, id);
  }

  const base = (
    env.WHATSAPP_PRESCRIPTION_URL_BASE ||
    env.WHATSAPP_PRESCRIPTION_VIEW_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
  if (base) {
    return `${base}/${id}`;
  }

  const portal = (env.WHATSAPP_PATIENT_PORTAL_URL || "").trim().replace(/\/$/, "");
  if (portal) {
    return `${portal}/prescriptions/${id}`;
  }

  return null;
}

function hasPrescriptionPortalLink() {
  if ((env.WHATSAPP_PRESCRIPTION_URL_BASE || "").trim()) return true;
  if ((env.WHATSAPP_PRESCRIPTION_LINK_TEMPLATE || "").includes("{id}")) return true;
  if ((env.WHATSAPP_PRESCRIPTION_VIEW_BASE_URL || "").trim()) return true;
  if ((env.WHATSAPP_PATIENT_PORTAL_URL || "").trim()) return true;
  return false;
}

function getPortalHintForAssistant() {
  const tmpl = (env.WHATSAPP_PRESCRIPTION_LINK_TEMPLATE || "").trim();
  if (tmpl) {
    return tmpl.replace(/\{id\}/g, "<prescriptionObjectId>");
  }
  const base = (
    env.WHATSAPP_PRESCRIPTION_URL_BASE ||
    env.WHATSAPP_PRESCRIPTION_VIEW_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
  if (base) {
    return `${base}/<prescriptionObjectId>`;
  }
  const portal = (env.WHATSAPP_PATIENT_PORTAL_URL || "").trim().replace(/\/$/, "");
  if (portal) {
    return `${portal}/prescriptions/<prescriptionObjectId>`;
  }
  return "";
}

module.exports = {
  prescriptionViewUrl,
  hasPrescriptionPortalLink,
  getPortalHintForAssistant,
};
