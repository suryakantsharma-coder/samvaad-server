const {
  getAppointmentConfirmationQueue,
  checkRedisReachable,
} = require('../queues/appointmentConfirmation.queue');
const { notifyAppointmentBookedById } = require('./appointmentWhatsAppNotify');

const JOB_SEND_APPOINTMENT_CONFIRMATION = 'send-appointment-confirmation';

const LOG = '[WhatsApp] Appointment confirmation';

/**
 * Send the confirmation directly (fire-and-forget). Used as a fallback when the
 * queue is unavailable so a confirmation is never silently dropped.
 * @param {string} appointmentMongoId
 * @param {string|null} [fallbackPhone]
 */
function sendDirect(appointmentMongoId, fallbackPhone) {
  Promise.resolve()
    .then(() => notifyAppointmentBookedById(appointmentMongoId, { fallbackPhone }))
    .then(() => console.log(`${LOG}: sent directly (no queue)`, String(appointmentMongoId)))
    .catch((err) =>
      console.error(`${LOG}: direct send failed:`, err && err.message ? err.message : err),
    );
}

/**
 * Reliable appointment-confirmation trigger for ALL booking paths (API, Razorpay,
 * voice agent). Enqueues a BullMQ job with retry + persistence; if Redis is not
 * reachable it falls back to a direct send so the message still goes out.
 *
 * Idempotency: a "created" confirmation is deduped per appointment via a stable
 * jobId, so retries/double-calls do not double-send. A "rescheduled" confirmation
 * uses a unique jobId so updated details are always re-sent.
 *
 * Never throws — safe to call without awaiting from request handlers / tools.
 * @param {string|object} appointmentMongoId  appointment _id (string or ObjectId)
 * @param {{ kind?: 'created'|'rescheduled', fallbackPhone?: string|null }} [opts]
 *   fallbackPhone: caller/session number used only if the patient record has no phone.
 * @returns {Promise<{ queued: boolean }>}
 */
async function enqueueAppointmentConfirmation(appointmentMongoId, opts = {}) {
  const id = appointmentMongoId ? String(appointmentMongoId) : '';
  if (!id) return { queued: false };

  const kind = opts.kind === 'rescheduled' ? 'rescheduled' : 'created';
  const fallbackPhone =
    opts.fallbackPhone != null && String(opts.fallbackPhone).trim() !== ''
      ? String(opts.fallbackPhone).trim()
      : null;

  try {
    const reachable = await checkRedisReachable();
    if (!reachable) {
      console.warn(`${LOG}: Redis unreachable — sending directly`, id);
      sendDirect(id, fallbackPhone);
      return { queued: false };
    }

    const queue = getAppointmentConfirmationQueue();
    const jobId =
      kind === 'rescheduled'
        ? `appt-confirm-${id}-r-${Date.now()}`
        : `appt-confirm-${id}`;

    await queue.add(
      JOB_SEND_APPOINTMENT_CONFIRMATION,
      { appointmentMongoId: id, kind, fallbackPhone },
      { jobId },
    );
    console.log(`${LOG}: queued`, { appointmentId: id, kind, jobId, hasFallbackPhone: Boolean(fallbackPhone) });
    return { queued: true };
  } catch (err) {
    console.error(
      `${LOG}: enqueue failed — sending directly:`,
      err && err.message ? err.message : err,
    );
    sendDirect(id, fallbackPhone);
    return { queued: false };
  }
}

module.exports = {
  JOB_SEND_APPOINTMENT_CONFIRMATION,
  enqueueAppointmentConfirmation,
};
