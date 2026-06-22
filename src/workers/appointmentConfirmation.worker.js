const { Worker } = require('bullmq');
const {
  QUEUE_NAME,
  checkRedisReachable,
} = require('../queues/appointmentConfirmation.queue');
const { createRedisConnection } = require('../queues/reminder.queue');
const {
  JOB_SEND_APPOINTMENT_CONFIRMATION,
} = require('../services/appointmentConfirmationDispatch');
const { notifyAppointmentBookedById } = require('../services/appointmentWhatsAppNotify');
const env = require('../config/env');

let workerInstance = null;
let workerConnection = null;

async function handleSendConfirmation(job) {
  const { appointmentMongoId, fallbackPhone } = job.data || {};
  if (!appointmentMongoId) {
    console.warn('[ApptConfirm] Job missing appointmentMongoId', job.id);
    return;
  }
  // Permissions + WhatsApp creds are enforced inside notifyAppointmentBookedById.
  // fallbackPhone (caller/session number) is used only if the patient has no phone.
  await notifyAppointmentBookedById(appointmentMongoId, { fallbackPhone: fallbackPhone || null });
}

/**
 * @returns {Promise<import('bullmq').Worker|undefined>}
 */
async function startAppointmentConfirmationWorker() {
  if (env.REMINDER_WORKER_DISABLED === '1' || env.REMINDER_WORKER_DISABLED === 'true') {
    console.log('[ApptConfirm] Worker not started (REMINDER_WORKER_DISABLED)');
    return undefined;
  }

  if (workerInstance) {
    return workerInstance;
  }

  const redisOk = await checkRedisReachable();
  if (!redisOk) {
    console.error(
      '[ApptConfirm] Redis not reachable — confirmation worker not started.',
      'Confirmations will fall back to direct send until Redis is available.',
    );
    return undefined;
  }

  workerConnection = createRedisConnection();

  workerInstance = new Worker(
    QUEUE_NAME,
    async (job) => {
      const started = Date.now();
      console.log('[ApptConfirm] Job start', {
        id: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade,
      });
      try {
        if (job.name === JOB_SEND_APPOINTMENT_CONFIRMATION) {
          await handleSendConfirmation(job);
        } else {
          console.warn('[ApptConfirm] Unknown job name', job.name);
        }
        console.log('[ApptConfirm] Job completed', {
          id: job.id,
          ms: Date.now() - started,
        });
      } catch (err) {
        console.error('[ApptConfirm] Job failed', {
          id: job.id,
          message: err.message,
          attemptsMade: job.attemptsMade,
        });
        throw err; // let BullMQ retry per attempts/backoff
      }
    },
    {
      connection: workerConnection,
      concurrency: Math.max(
        1,
        parseInt(process.env.APPT_CONFIRM_WORKER_CONCURRENCY || '10', 10),
      ),
      limiter: { max: 100, duration: 1000 },
    },
  );

  let lastErrLog = 0;
  workerInstance.on('error', (err) => {
    const now = Date.now();
    if (now - lastErrLog > 15_000) {
      lastErrLog = now;
      console.error('[ApptConfirm] Worker error:', err.message);
    }
  });

  console.log('[ApptConfirm] BullMQ worker listening', { queue: QUEUE_NAME });
  return workerInstance;
}

async function stopAppointmentConfirmationWorker() {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
  if (workerConnection) {
    await workerConnection.quit();
    workerConnection = null;
  }
}

module.exports = {
  startAppointmentConfirmationWorker,
  stopAppointmentConfirmationWorker,
};
