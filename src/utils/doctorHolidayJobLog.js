/**
 * Structured logs for doctor holiday BullMQ jobs (schedule + execution).
 * grep: DoctorHolidayJob
 */

/**
 * @param {string} event
 * @param {Record<string, unknown>} [data]
 */
function logDoctorHolidayJob(event, data = {}) {
  const line = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };
  console.log('[DoctorHolidayJob]', JSON.stringify(line));
}

module.exports = {
  logDoctorHolidayJob,
};
