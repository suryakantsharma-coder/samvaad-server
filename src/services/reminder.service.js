const { getReminderQueue } = require('../queues/reminder.queue');
const {
  SLOTS,
  getReminderAnchorDate,
  getScheduledDateTimeForSlot,
  computeDelayMs,
  getFeedbackScheduledAt,
} = require('../utils/time.util');

const JOB_SEND_REMINDER = 'send-reminder';
const JOB_SEND_FEEDBACK = 'send-feedback';

/**
 * Parse duration in days from medicine.duration (object or legacy string).
 * @param {*} duration
 * @returns {number|null} null means active for entire follow-up window
 */
function getMedicineDurationDays(duration) {
  if (duration == null) return null;
  if (typeof duration === 'object' && duration !== null && typeof duration.value === 'number') {
    const n = duration.value;
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = String(duration.unit || 'Days').toLowerCase();
    if (unit.startsWith('day')) {
      return Math.floor(n);
    }
    return Math.floor(n);
  }
  if (typeof duration === 'string') {
    const m = duration.match(/(\d+)/);
    if (m) return Math.max(1, parseInt(m[1], 10));
  }
  return null;
}

/**
 * @param {*} medicine
 * @param {number} dayOffset 0-based
 * @returns {boolean}
 */
function isMedicineActiveOnDay(medicine, dayOffset) {
  const days = getMedicineDurationDays(medicine.duration);
  if (days == null) return true;
  return dayOffset < days;
}

/**
 * @param {*} medicine
 * @param {'breakfast'|'lunch'|'dinner'} slot
 * @returns {boolean}
 */
function medicineHasSlot(medicine, slot) {
  const t = medicine.time;
  if (!t || typeof t !== 'object') return false;
  return Boolean(t[slot]);
}

/**
 * @param {*} medicine
 * @returns {{ name: string, dosage: string, intake?: string }}
 */
function compactMedicineForJob(medicine) {
  let dosageLabel = '';
  const d = medicine.dosage;
  if (d != null && typeof d === 'object' && typeof d.value === 'number') {
    dosageLabel = `${d.value}${d.unit || ''}`.trim();
  } else if (typeof d === 'string' && d.trim()) {
    dosageLabel = d.trim();
  } else if (d != null) {
    dosageLabel = String(d);
  }
  return {
    name: typeof medicine.name === 'string' ? medicine.name : String(medicine.name || ''),
    dosage: dosageLabel,
    intake: typeof medicine.intake === 'string' ? medicine.intake : '',
  };
}

/**
 * Schedule delayed reminder + feedback jobs for a newly created prescription.
 * @param {{ _id: import('mongoose').Types.ObjectId, medicines: any[], followUp?: { value?: number }, appointmentDate?: Date, createdAt?: Date, patientName?: string }} prescription — lean or doc
 * @returns {Promise<{ reminderJobs: number, feedbackScheduled: boolean }>}
 */
async function schedulePrescriptionReminders(prescription) {
  const queue = getReminderQueue();
  const followUpVal = prescription.followUp && typeof prescription.followUp.value === 'number'
    ? prescription.followUp.value
    : null;

  if (followUpVal == null || followUpVal <= 0) {
    console.warn(
      '[Reminder] Skipping schedule: invalid followUp.value',
      String(prescription._id),
    );
    return { reminderJobs: 0, feedbackScheduled: false };
  }

  const prescriptionId = String(prescription._id);
  const anchor = getReminderAnchorDate(prescription);
  const medicines = Array.isArray(prescription.medicines) ? prescription.medicines : [];
  const now = new Date();
  let reminderJobs = 0;

  for (let dayOffset = 0; dayOffset < followUpVal; dayOffset += 1) {
    for (const slot of SLOTS) {
      const activeMeds = medicines.filter(
        (m) => isMedicineActiveOnDay(m, dayOffset) && medicineHasSlot(m, slot),
      );
      if (activeMeds.length === 0) continue;

      const scheduledAt = getScheduledDateTimeForSlot(anchor, dayOffset, slot);
      const delay = computeDelayMs(scheduledAt, now);

      await queue.add(
        JOB_SEND_REMINDER,
        {
          prescriptionId,
          slot,
          medicines: activeMeds.map(compactMedicineForJob),
        },
        {
          delay,
          jobId: `reminder-${prescriptionId}-${dayOffset}-${slot}`,
        },
      );
      reminderJobs += 1;
    }
  }

  const feedbackAt = getFeedbackScheduledAt(anchor, followUpVal);
  const feedbackDelay = computeDelayMs(feedbackAt, now);

  await queue.add(
    JOB_SEND_FEEDBACK,
    { prescriptionId },
    {
      delay: feedbackDelay,
      jobId: `feedback-${prescriptionId}`,
    },
  );

  console.log(
    '[Reminder] Scheduled',
    reminderJobs,
    'reminder job(s) + feedback for prescription',
    prescriptionId,
  );

  return { reminderJobs, feedbackScheduled: true };
}

/**
 * @param {string|number} prescriptionId
 * @returns {Promise<{ reminderJobs: number, feedbackScheduled: boolean }>}
 */
async function schedulePrescriptionRemindersById(prescriptionId) {
  const Prescription = require('../models/prescription.model');
  const doc = await Prescription.findById(prescriptionId).lean();
  if (!doc) {
    throw new Error('Prescription not found');
  }
  return schedulePrescriptionReminders(doc);
}

/**
 * @param {'breakfast'|'lunch'|'dinner'} slot
 * @returns {string}
 */
function slotLabel(slot) {
  if (!slot || typeof slot !== 'string') return 'Reminder';
  return slot.charAt(0).toUpperCase() + slot.slice(1);
}

/**
 * Normalize dosage for display e.g. "50mg" → "50 mg", { value, unit } → "50 mg".
 * @param {string} dosageFromJob
 * @returns {string}
 */
function formatDosageForReminderLine(dosageFromJob) {
  const raw = String(dosageFromJob || '').trim();
  if (!raw) return '';
  const m = raw.match(/^([\d.,]+)\s*([a-zA-Zμ%]+)$/);
  if (m) {
    return `${m[1]} ${m[2]}`;
  }
  return raw;
}

/**
 * Intake text e.g. "After" → "After food" (matches prescription notify style).
 * @param {string} intake
 * @returns {string}
 */
function intakeWithFoodPhrase(intake) {
  const s = String(intake || '').trim();
  if (!s) return 'As directed';
  if (/food/i.test(s)) return s;
  return `${s} food`;
}

/**
 * One line: Coinsa (50 mg) - After food, Breakfast
 * @param {{ name: string, dosage?: string, intake?: string }} med
 * @param {string} slotLabelText Breakfast | Lunch | Dinner
 * @returns {_string}
 */
function buildMedicineReminderLine(med, slotLabelText) {
  const name = med.name && String(med.name).trim() ? String(med.name).trim() : 'Medicine';
  const dose = formatDosageForReminderLine(med.dosage);
  const dosePart = dose ? ` (${dose})` : '';
  const whenFood = intakeWithFoodPhrase(med.intake);
  return `${name}${dosePart} - ${whenFood}, ${slotLabelText}`;
}

/**
 * Full WhatsApp body for medicine reminder (plain text; same copy as approved template).
 *
 * Hello {patient_name},
 *
 * This is a reminder to take your medicines.
 *
 * {medicines lines}
 *
 * Please take your medicines as prescribed by your doctor. If you have already taken it, you may ignore this message.
 *
 * @param {string} patientName
 * @param {'breakfast'|'lunch'|'dinner'} slot
 * @param {{ name: string, dosage?: string, intake?: string }[]} medicines
 * @returns {string}
 */
/**
 * Body variable {{medicines}} for NAMED template (multiline list only).
 * @param {'breakfast'|'lunch'|'dinner'} slot
 * @param {{ name: string, dosage?: string, intake?: string }[]} medicines
 * @returns {string}
 */
function buildMedicineReminderTemplateMedicinesParam(slot, medicines) {
  const label = slotLabel(slot);
  return (Array.isArray(medicines) ? medicines : [])
    .map((m) => buildMedicineReminderLine(m, label))
    .join('\n');
}

function buildMedicineReminderWhatsAppBody(patientName, slot, medicines) {
  const name = patientName && String(patientName).trim() ? String(patientName).trim() : 'Patient';
  const label = slotLabel(slot);
  const list = (Array.isArray(medicines) ? medicines : []).map((m) => buildMedicineReminderLine(m, label));

  return [
    `Hello ${name},`,
    '',
    'This is a reminder to take your medicines.',
    '',
    ...list,
    '',
    'Please take your medicines as prescribed by your doctor. If you have already taken it, you may ignore this message.',
  ].join('\n');
}

/**
 * @deprecated Use buildMedicineReminderWhatsAppBody for outbound copy.
 */
function buildReminderMessage(patientName, slot, medicines) {
  return buildMedicineReminderWhatsAppBody(patientName, slot, medicines);
}

/**
 * @param {string} patientName
 * @returns {string}
 */
function buildFeedbackMessage(patientName) {
  const name = patientName && String(patientName).trim() ? String(patientName).trim() : 'Patient';
  return [
    `Dear ${name},`,
    '',
    'Your medication reminder course has ended.',
    'Please share quick feedback with your care team when convenient.',
    '',
    'Thank you for taking care of your health.',
  ].join('\n');
}

module.exports = {
  JOB_SEND_REMINDER,
  JOB_SEND_FEEDBACK,
  schedulePrescriptionReminders,
  schedulePrescriptionRemindersById,
  getMedicineDurationDays,
  isMedicineActiveOnDay,
  medicineHasSlot,
  compactMedicineForJob,
  slotLabel,
  formatDosageForReminderLine,
  intakeWithFoodPhrase,
  buildMedicineReminderLine,
  buildMedicineReminderTemplateMedicinesParam,
  buildMedicineReminderWhatsAppBody,
  buildReminderMessage,
  buildFeedbackMessage,
};
