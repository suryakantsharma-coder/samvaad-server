const env = require('../config/env');

/**
 * Public HTTPS link for WhatsApp template {{link}} (Meta may reject localhost).
 * Set WHATSAPP_PRESCRIPTION_URL_BASE or WHATSAPP_PRESCRIPTION_LINK_TEMPLATE in production.
 * @param {string|import('mongoose').Types.ObjectId} prescriptionId
 * @returns {string}
 */
function buildPrescriptionPublicLink(prescriptionId) {
  const id = String(prescriptionId || '').trim();
  if (!id) return '';

  const tpl = env.WHATSAPP_PRESCRIPTION_LINK_TEMPLATE;
  if (tpl) {
    return tpl.replace(/\{id\}/g, id);
  }

  const base = (
    env.WHATSAPP_PRESCRIPTION_URL_BASE ||
    env.WHATSAPP_PRESCRIPTION_VIEW_BASE_URL ||
    ''
  ).replace(/\/$/, '');
  if (base) {
    return `${base}/${id}`;
  }

  const port = env.PORT || 3000;
  return `http://localhost:${port}/api/public/prescriptions/${id}`;
}

module.exports = { buildPrescriptionPublicLink };
