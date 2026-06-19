const { Worker } = require('bullmq');
const {
  QUEUE_NAME,
  createRedisConnection,
  checkRedisReachable,
} = require('../queues/reminder.queue');
const { JOB_SEND_REMINDER, JOB_SEND_FEEDBACK } = require('../services/reminder.service');
const {
  notifyMedicineReminder,
  notifyPrescriptionReminderFeedback,
} = require('../services/reminderWhatsAppNotify');
const Prescription = require('../models/prescription.model');
require('../models/doctor.model');
const env = require('../config/env');
const { isReminderTestMode } = require('../utils/time.util');

let workerInstance = null;
let workerConnection = null;

/**
 * @param {import('mongoose').Types.ObjectId|string} prescriptionId
 * @returns {Promise<import('mongoose').Document|null>}
 */
async function loadPrescriptionForReminders(prescriptionId) {
  return Prescription.findById(prescriptionId)
    .populate('patient', 'fullName phoneNumber patientId hospital')
    .populate('hospital', 'name phoneCountryCode')
    .populate({
      path: 'appointment',
      select: 'doctor',
      populate: { path: 'doctor', select: 'fullName' },
    });
}

function resolvePatientPhone(prescription) {
  const p = prescription.patient;
  if (p && typeof p === 'object' && p.phoneNumber) {
    return String(p.phoneNumber).trim();
  }
  return '';
}

async function handleSendReminder(job) {
  const { prescriptionId, slot, medicines } = job.data;
  const prescription = await loadPrescriptionForReminders(prescriptionId);

  if (!prescription) {
    console.warn('[Reminder] send-reminder skipped: prescription missing', prescriptionId);
    return;
  }
  if (prescription.status === 'Cancelled') {
    console.warn('[Reminder] send-reminder skipped: cancelled', prescriptionId);
    return;
  }

  const to = resolvePatientPhone(prescription);
  if (!to) {
    console.error('[Reminder] send-reminder failed: no patient phone', prescriptionId);
    throw new Error('Patient phone number not available');
  }

  try {
    await notifyMedicineReminder(prescription, slot, medicines || []);
  } catch (err) {
    console.error('[Reminder] send-reminder WhatsApp error:', err.message, err.details || '');
    throw err;
  }
}

async function handleSendFeedback(job) {
  const { prescriptionId } = job.data;
  const prescription = await loadPrescriptionForReminders(prescriptionId);

  if (!prescription) {
    console.warn('[Reminder] send-feedback skipped: prescription missing', prescriptionId);
    return;
  }
  if (prescription.status === 'Cancelled') {
    console.warn('[Reminder] send-feedback skipped: cancelled', prescriptionId);
    return;
  }

  const to = resolvePatientPhone(prescription);
  if (!to) {
    console.error('[Reminder] send-feedback failed: no patient phone', prescriptionId);
    throw new Error('Patient phone number not available');
  }

  try {
    await notifyPrescriptionReminderFeedback(prescription);
  } catch (err) {
    console.error('[Reminder] send-feedback WhatsApp error:', err.message, err.details || '');
    throw err;
  }

  await Prescription.findOneAndUpdate(
    { _id: prescription._id, status: { $ne: 'Cancelled' } },
    { $set: { dosageCompletionSentAt: new Date() } },
  );

  console.log('[Reminder] Dosage completion feedback sent', prescriptionId);
}

/**
 * @returns {Promise<import('bullmq').Worker|undefined>}
 */
async function startReminderWorker() {
  if (env.REMINDER_WORKER_DISABLED === '1' || env.REMINDER_WORKER_DISABLED === 'true') {
    console.log('[Reminder] Worker not started (REMINDER_WORKER_DISABLED)');
    return undefined;
  }

  if (workerInstance) {
    return workerInstance;
  }

  const redisOk = await checkRedisReachable();
  if (!redisOk) {
    const where = env.REDIS_URL ? 'REDIS_URL' : `${env.REDIS_HOST}:${env.REDIS_PORT}`;
    console.error(
      '[Reminder] Redis is not reachable at',
      where,
      '— BullMQ worker not started. Start Redis (e.g. docker run -d -p 6379:6379 redis:7-alpine) or set REDIS_URL in .env.',
    );
    return undefined;
  }

  workerConnection = createRedisConnection();

  workerInstance = new Worker(
    QUEUE_NAME,
    async (job) => {
      const started = Date.now();
      console.log('[Reminder] Job start', { id: job.id, name: job.name, attemptsMade: job.attemptsMade });

      try {
        if (job.name === JOB_SEND_REMINDER) {
          await handleSendReminder(job);
        } else if (job.name === JOB_SEND_FEEDBACK) {
          await handleSendFeedback(job);
        } else {
          console.warn('[Reminder] Unknown job name', job.name);
        }
        console.log('[Reminder] Job completed', {
          id: job.id,
          name: job.name,
          ms: Date.now() - started,
        });
      } catch (err) {
        console.error('[Reminder] Job failed', {
          id: job.id,
          name: job.name,
          message: err.message,
          stack: env.NODE_ENV === 'development' ? err.stack : undefined,
        });
        throw err;
      }
    },
    {
      connection: workerConnection,
      concurrency: Math.max(1, parseInt(process.env.REMINDER_WORKER_CONCURRENCY || '10', 10)),
      limiter: {
        max: 100,
        duration: 1000,
      },
    },
  );

  let lastWorkerErrLog = 0;
  workerInstance.on('error', (err) => {
    const now = Date.now();
    if (now - lastWorkerErrLog > 15_000) {
      lastWorkerErrLog = now;
      console.error('[Reminder] Worker error:', err.message);
    }
  });

  console.log('[Reminder] BullMQ worker listening', {
    queue: QUEUE_NAME,
    concurrency: Math.max(1, parseInt(process.env.REMINDER_WORKER_CONCURRENCY || '10', 10)),
    testMode: isReminderTestMode(),
  });

  return workerInstance;
}

async function stopReminderWorker() {
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
  startReminderWorker,
  stopReminderWorker,
};
