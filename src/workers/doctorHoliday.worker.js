const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const Doctor = require('../models/doctor.model');
const env = require('../config/env');
const {
  QUEUE_NAME,
  createRedisConnection,
  checkRedisReachable,
} = require('../queues/doctorHoliday.queue');
const {
  JOB_HOLIDAY_START,
  JOB_HOLIDAY_END,
} = require('../services/doctorHolidayJobs.service');
const { isNowInsideAnyHoliday } = require('../utils/doctorHoliday');
const { logDoctorHolidayJob } = require('../utils/doctorHolidayJobLog');

let workerInstance = null;
let workerConnection = null;

async function handleHolidayStart(job) {
  const { doctorId, holidaySubId } = job.data;
  const hid = String(holidaySubId);
  const doc = await Doctor.findById(doctorId);
  if (!doc) {
    logDoctorHolidayJob('job_execution_skipped', {
      jobType: JOB_HOLIDAY_START,
      bullJobId: job.id,
      doctorId: String(doctorId),
      holidaySubId: hid,
      reason: 'doctor_not_found',
    });
    console.warn('[DoctorHoliday] start skipped: doctor missing', doctorId);
    return;
  }
  const stillThere = (doc.holidays || []).some((h) => String(h._id) === hid);
  if (!stillThere) {
    logDoctorHolidayJob('job_execution_skipped', {
      jobType: JOB_HOLIDAY_START,
      bullJobId: job.id,
      doctorId: String(doctorId),
      holidaySubId: hid,
      reason: 'holiday_removed_before_run',
    });
    console.log('[DoctorHoliday] start skipped: holiday removed', doctorId, hid);
    return;
  }
  doc.status = 'Off Duty';
  await doc.save();
  logDoctorHolidayJob('job_executed', {
    jobType: JOB_HOLIDAY_START,
    bullJobId: job.id,
    doctorId: String(doctorId),
    holidaySubId: hid,
    outcome: 'status_set_off_duty',
  });
  console.log('[DoctorHoliday] status → Off Duty', { doctorId, holidaySubId: hid });
}

async function handleHolidayEnd(job) {
  const { doctorId, holidaySubId } = job.data;
  let hid;
  try {
    hid = new mongoose.Types.ObjectId(String(holidaySubId));
  } catch {
    logDoctorHolidayJob('job_execution_skipped', {
      jobType: JOB_HOLIDAY_END,
      bullJobId: job.id,
      doctorId: String(doctorId),
      reason: 'invalid_holiday_sub_id',
      holidaySubId: String(holidaySubId),
    });
    console.warn('[DoctorHoliday] end skipped: invalid holidaySubId', holidaySubId);
    return;
  }

  const pull = await Doctor.updateOne(
    { _id: doctorId },
    { $pull: { holidays: { _id: hid } } },
  );
  if (!pull.matchedCount) {
    logDoctorHolidayJob('job_execution_skipped', {
      jobType: JOB_HOLIDAY_END,
      bullJobId: job.id,
      doctorId: String(doctorId),
      holidaySubId: String(hid),
      reason: 'doctor_not_found',
    });
    console.warn('[DoctorHoliday] end skipped: doctor missing', doctorId);
    return;
  }

  const fresh = await Doctor.findById(doctorId).lean();
  if (!fresh) {
    logDoctorHolidayJob('job_execution_skipped', {
      jobType: JOB_HOLIDAY_END,
      bullJobId: job.id,
      doctorId: String(doctorId),
      holidaySubId: String(hid),
      reason: 'doctor_missing_after_pull',
    });
    return;
  }

  const nextStatus = isNowInsideAnyHoliday(fresh.holidays || []) ? 'Off Duty' : 'On Duty';
  await Doctor.updateOne({ _id: doctorId }, { $set: { status: nextStatus } });

  logDoctorHolidayJob('job_executed', {
    jobType: JOB_HOLIDAY_END,
    bullJobId: job.id,
    doctorId: String(doctorId),
    holidaySubId: String(hid),
    outcome: 'holiday_removed',
    newStatus: nextStatus,
  });
  console.log('[DoctorHoliday] holiday removed; status →', nextStatus, {
    doctorId: String(doctorId),
    holidaySubId: String(hid),
  });
}

/**
 * @returns {Promise<import('bullmq').Worker|undefined>}
 */
async function startDoctorHolidayWorker() {
  if (env.REMINDER_WORKER_DISABLED === '1' || env.REMINDER_WORKER_DISABLED === 'true') {
    console.log('[DoctorHoliday] Worker not started (REMINDER_WORKER_DISABLED)');
    return undefined;
  }

  if (workerInstance) {
    return workerInstance;
  }

  const redisOk = await checkRedisReachable();
  if (!redisOk) {
    const where = env.REDIS_URL ? 'REDIS_URL' : `${env.REDIS_HOST}:${env.REDIS_PORT}`;
    console.error(
      '[DoctorHoliday] Redis is not reachable at',
      where,
      '— worker not started.',
    );
    return undefined;
  }

  workerConnection = createRedisConnection();

  workerInstance = new Worker(
    QUEUE_NAME,
    async (job) => {
      const t0 = Date.now();
      const { doctorId, holidaySubId } = job.data || {};
      logDoctorHolidayJob('job_picked', {
        jobType: job.name,
        bullJobId: job.id,
        doctorId: doctorId != null ? String(doctorId) : undefined,
        holidaySubId: holidaySubId != null ? String(holidaySubId) : undefined,
        attemptsMade: job.attemptsMade,
      });
      console.log('[DoctorHoliday] Job start', {
        id: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade,
      });
      try {
        if (job.name === JOB_HOLIDAY_START) {
          await handleHolidayStart(job);
        } else if (job.name === JOB_HOLIDAY_END) {
          await handleHolidayEnd(job);
        }
        logDoctorHolidayJob('job_finished', {
          jobType: job.name,
          bullJobId: job.id,
          doctorId: doctorId != null ? String(doctorId) : undefined,
          holidaySubId: holidaySubId != null ? String(holidaySubId) : undefined,
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        logDoctorHolidayJob('job_failed', {
          jobType: job.name,
          bullJobId: job.id,
          doctorId: doctorId != null ? String(doctorId) : undefined,
          holidaySubId: holidaySubId != null ? String(holidaySubId) : undefined,
          durationMs: Date.now() - t0,
          error: err.message,
        });
        throw err;
      }
    },
    { connection: workerConnection },
  );

  let lastErrLog = 0;
  workerInstance.on('error', (err) => {
    const now = Date.now();
    if (now - lastErrLog > 15_000) {
      lastErrLog = now;
      console.error('[DoctorHoliday] Worker error:', err.message);
    }
  });

  console.log('[DoctorHoliday] BullMQ worker listening', { queue: QUEUE_NAME });
  return workerInstance;
}

async function stopDoctorHolidayWorker() {
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
  startDoctorHolidayWorker,
  stopDoctorHolidayWorker,
};
