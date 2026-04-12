const HOSPITAL_POPULATE_FIELDS =
  'name phoneCountryCode phoneNumber email contactPerson registrationNumber address city pincode url logoUrl emergencyNumber receptionistNumber whatsappNumber reviewUrls';
const DOCTOR_POPULATE_FIELDS = 'fullName doctorId designation email phoneNumber availability';

/**
 * Populate patient, hospital, and appointment → doctor for prescription queries.
 * @param {import('mongoose').Query} query
 * @param {string} [patientSelect]
 */
function applyPrescriptionPopulate(query, patientSelect = 'fullName patientId phoneNumber') {
  return query
    .populate('patient', patientSelect)
    .populate('hospital', HOSPITAL_POPULATE_FIELDS)
    .populate({
      path: 'appointment',
      select: 'appointmentId reason appointmentDateTime status type doctor',
      populate: { path: 'doctor', select: DOCTOR_POPULATE_FIELDS },
    });
}

/** Attach doctor + hospital to each medicine entry (same refs for all rows on a prescription). */
function enrichMedicinesWithDoctorHospital(prescription) {
  if (!prescription || !Array.isArray(prescription.medicines)) return prescription;
  const doctor = prescription.appointment?.doctor ?? null;
  const hospital = prescription.hospital ?? null;
  return {
    ...prescription,
    medicines: prescription.medicines.map((m) => ({
      ...m,
      doctor,
      hospital,
    })),
  };
}

module.exports = {
  HOSPITAL_POPULATE_FIELDS,
  DOCTOR_POPULATE_FIELDS,
  applyPrescriptionPopulate,
  enrichMedicinesWithDoctorHospital,
};
