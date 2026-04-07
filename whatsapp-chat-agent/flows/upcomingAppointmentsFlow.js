const { getPatientsByPhone, getUpcomingAppointmentsByPhone } = require("../services/hospitalBackend");
const { FLOW_EXIT_HINT } = require("../utils/flowHints");

function formatDateTimeIST(d) {
  try {
    return new Date(d).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return String(d || "—");
  }
}

function formatAppointmentLine(a, i) {
  const patientName = a.patient?.fullName?.trim() || "Patient";
  const patientCode = a.patient?.patientId || "—";
  const doctorName = a.doctor?.fullName?.trim() || "Doctor";
  const when = formatDateTimeIST(a.appointmentDateTime);
  return `${i}) *${when}*\nPatient: ${patientName} (${patientCode})\nDoctor: ${doctorName}`;
}

async function startUpcomingAppointmentsFlow(_ctx, phone, hospitalId) {
  const patients = await getPatientsByPhone(phone, hospitalId);
  if (!patients.length) {
    return {
      reply:
        "No patient profile is linked to this WhatsApp number.\n\nPlease contact reception to update your phone number.",
      endFlow: true,
    };
  }

  const rows = await getUpcomingAppointmentsByPhone(phone, hospitalId, new Date());
  if (!rows.length) {
    return {
      reply: "No upcoming appointments are linked to this WhatsApp number.",
      endFlow: true,
    };
  }

  const lines = rows.map((a, i) => formatAppointmentLine(a, i + 1)).join("\n\n");
  return {
    reply: `*Your upcoming appointments*\n\n${FLOW_EXIT_HINT}\n\n${lines}`,
    endFlow: true,
  };
}

module.exports = {
  startUpcomingAppointmentsFlow,
};
