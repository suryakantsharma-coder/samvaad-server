const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

/** @type {Map<string, object>} */
const store = new Map();

function now() {
  return Date.now();
}

function pruneMessages(ctx) {
  const cutoff = now() - FOUR_DAYS_MS;
  if (!Array.isArray(ctx.messages)) ctx.messages = [];
  ctx.messages = ctx.messages.filter((m) => m.at >= cutoff);
}

/**
 * @param {string} phoneDigits
 * @param {object} data
 */
function setDosageCompletionPending(phoneDigits, data) {
  const ctx = getContext(phoneDigits);
  if (!ctx) return;
  ctx.activeFlow = "dosage_completion";
  ctx.dosageCompletion = data;
  ctx.dosageFollowup = null;
}

function clearDosageCompletionState(phoneDigits) {
  const ctx = getContext(phoneDigits);
  if (!ctx) return;
  if (ctx.activeFlow === "dosage_completion" || ctx.activeFlow === "dosage_followup") {
    ctx.activeFlow = null;
  }
  ctx.dosageCompletion = null;
  ctx.dosageFollowup = null;
}

/**
 * @param {string} phoneDigits - WhatsApp `from` or normalized digits
 */
function getContext(phoneDigits) {
  const key = String(phoneDigits || "").replace(/\D/g, "");
  if (!key) return null;

  let ctx = store.get(key);
  if (!ctx) {
    ctx = {
      phoneKey: key,
      hospitalId: null,
      messages: [],
      activeFlow: null,
      appointment: null,
      prescription: null,
    };
    store.set(key, ctx);
  }

  pruneMessages(ctx);
  return ctx;
}

function setHospitalId(phoneDigits, hospitalId) {
  const ctx = getContext(phoneDigits);
  if (!ctx) return;
  ctx.hospitalId = hospitalId || null;
}

/**
 * @param {string} phoneDigits
 * @param {"user"|"assistant"} role
 * @param {string} text
 */
function appendMessage(phoneDigits, role, text) {
  const ctx = getContext(phoneDigits);
  if (!ctx) return;
  ctx.messages.push({
    role,
    text: String(text || "").slice(0, 4000),
    at: now(),
  });
  pruneMessages(ctx);
}

function resetFlows(phoneDigits) {
  const ctx = getContext(phoneDigits);
  if (!ctx) return;
  ctx.activeFlow = null;
  ctx.appointment = null;
  ctx.prescription = null;
  ctx.followup = null;
  ctx.dosageCompletion = null;
  ctx.dosageFollowup = null;
}

module.exports = {
  getContext,
  setHospitalId,
  appendMessage,
  resetFlows,
  setDosageCompletionPending,
  clearDosageCompletionState,
  FOUR_DAYS_MS,
};
