const {
  getDoctorHolidayQueue,
  checkRedisReachable,
} = require('../queues/doctorHoliday.queue');
const {
  msUntilLocalStartOfHolidayDay,
  msUntilLocalMidnightAfterHolidayEnd,
} = require('../utils/doctorHoliday');
const { logDoctorHolidayJob } = require('../utils/doctorHolidayJobLog');

const JOB_HOLIDAY_START = 'doctor-holiday-start';
const JOB_HOLIDAY_END = 'doctor-holiday-end';

function jobIdStart(doctorId, holidaySubId) {
  return `dh-start-${doctorId}-${holidaySubId}`;
}

function jobIdEnd(doctorId, holidaySubId) {
  return `dh-end-${doctorId}-${holidaySubId}`;
}

/**
 * @param {string} jobId
 * @returns {Promise<void>}
 */
/**
 * @param {import('bullmq').Queue} queue
 * @param {string} jobId
 * @param {Record<string, unknown>} [meta]
 */
async function removeJobByIdIfExists(queue, jobId, meta = {}) {
  try {
    const job = await queue.getJob(jobId);
    if (job) {
      await job.remove();
      logDoctorHolidayJob('job_cancelled', { jobId, ...meta });
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('mongoose').Types.ObjectId|string} doctorId
 * @param {string} holidaySubId
 * @returns {Promise<void>}
 */
async function removeHolidayJobs(doctorId, holidaySubId) {
  const redisOk = await checkRedisReachable();
  if (!redisOk) return;
  const queue = getDoctorHolidayQueue();
  const sid = String(holidaySubId);
  const did = String(doctorId);
  const meta = { doctorId: did, holidaySubId: sid };
  await removeJobByIdIfExists(queue, jobIdStart(did, sid), { ...meta, jobType: JOB_HOLIDAY_START });
  await removeJobByIdIfExists(queue, jobIdEnd(did, sid), { ...meta, jobType: JOB_HOLIDAY_END });
}

/**
 * @param {import('mongoose').Document|object} doctor — must include _id and holidays[]
 * @returns {Promise<void>}
 */
async function scheduleDoctorHolidayJobsFromDoc(doctor) {
  const redisOk = await checkRedisReachable();
  if (!redisOk) {
    logDoctorHolidayJob('schedule_skipped', {
      reason: 'redis_unreachable',
      doctorId: String(doctor._id),
      hint: 'Start Redis or set REDIS_URL',
    });
    console.warn(
      '[DoctorHoliday] Redis unreachable — holiday status jobs not scheduled. Start Redis or set REDIS_URL.',
    );
    return;
  }

  const queue = getDoctorHolidayQueue();
  const did = String(doctor._id);
  const holidays = Array.isArray(doctor.holidays) ? doctor.holidays : [];

  for (const h of holidays) {
    if (!h || !h.startDate || !h.endDate || !h._id) continue;
    const subId = String(h._id);
    const delayStart = msUntilLocalStartOfHolidayDay(h.startDate);
    const delayEnd = msUntilLocalMidnightAfterHolidayEnd(h.endDate);
    const startJobId = jobIdStart(did, subId);
    const endJobId = jobIdEnd(did, subId);
    const runAtStart = new Date(Date.now() + delayStart).toISOString();
    const runAtEnd = new Date(Date.now() + delayEnd).toISOString();

    await queue.add(
      JOB_HOLIDAY_START,
      { doctorId: did, holidaySubId: subId },
      {
        jobId: startJobId,
        delay: delayStart,
      },
    );
    logDoctorHolidayJob('job_scheduled', {
      jobType: JOB_HOLIDAY_START,
      jobId: startJobId,
      doctorId: did,
      holidaySubId: subId,
      delayMs: delayStart,
      runAt: runAtStart,
      holidayStartDate: new Date(h.startDate).toISOString(),
      holidayEndDate: new Date(h.endDate).toISOString(),
    });

    await queue.add(
      JOB_HOLIDAY_END,
      { doctorId: did, holidaySubId: subId },
      {
        jobId: endJobId,
        delay: delayEnd,
      },
    );
    logDoctorHolidayJob('job_scheduled', {
      jobType: JOB_HOLIDAY_END,
      jobId: endJobId,
      doctorId: did,
      holidaySubId: subId,
      delayMs: delayEnd,
      runAt: runAtEnd,
      holidayStartDate: new Date(h.startDate).toISOString(),
      holidayEndDate: new Date(h.endDate).toISOString(),
    });
  }
}

/**
 * Drop jobs for removed sub-ids, then (re)schedule all current holidays.
 * @param {import('mongoose').Document|object} doctor
 * @param {string[]} previousHolidaySubIds
 * @returns {Promise<void>}
 */
async function syncDoctorHolidayJobs(doctor, previousHolidaySubIds) {
  const currentIds = (Array.isArray(doctor.holidays) ? doctor.holidays : [])
    .filter((h) => h && h._id)
    .map((h) => String(h._id));
  const curSet = new Set(currentIds);
  const removed = (previousHolidaySubIds || []).filter((id) => !curSet.has(String(id)));
  logDoctorHolidayJob('sync_started', {
    doctorId: String(doctor._id),
    previousHolidayCount: (previousHolidaySubIds || []).length,
    currentHolidayCount: currentIds.length,
    removedSubIds: removed,
  });
  for (const id of removed) {
    await removeHolidayJobs(doctor._id, id);
  }
  for (const id of currentIds) {
    await removeHolidayJobs(doctor._id, id);
  }
  await scheduleDoctorHolidayJobsFromDoc(doctor);
  logDoctorHolidayJob('sync_completed', {
    doctorId: String(doctor._id),
    scheduledHolidayCount: currentIds.length,
  });
}

module.exports = {
  JOB_HOLIDAY_START,
  JOB_HOLIDAY_END,
  removeHolidayJobs,
  scheduleDoctorHolidayJobsFromDoc,
  syncDoctorHolidayJobs,
};
