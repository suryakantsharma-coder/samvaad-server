const Appointment = require('../models/appointment.model');

/**
 * Unique appointmentId: A-YYYY-000001 (e.g. A-2026-000001).
 */
async function generateAppointmentId() {
  const year = new Date().getFullYear();
  const prefix = `A-${year}-`;
  const last = await Appointment.findOne({ appointmentId: new RegExp(`^${prefix}`) })
    .sort({ appointmentId: -1 })
    .select('appointmentId')
    .lean();
  const nextNum = last
    ? parseInt(last.appointmentId.slice(prefix.length), 10) + 1
    : 1;
  const suffix = String(nextNum).padStart(6, '0');
  return `${prefix}${suffix}`;
}

module.exports = { generateAppointmentId };
