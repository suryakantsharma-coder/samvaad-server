/**
 * Meta message_templates payloads (NAMED params + examples + optional quick-reply buttons).
 * @see https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 */

function metaBodyComponent(text, namedParams) {
  return {
    type: "BODY",
    text,
    example: {
      body_text_named_params: namedParams.map(({ param_name, example }) => ({
        param_name,
        example,
      })),
    },
  };
}

function metaQuickReplyButtons(labels) {
  return {
    type: "BUTTONS",
    buttons: labels.map((text) => ({ type: "QUICK_REPLY", text })),
  };
}

function metaTemplatePayloadForKey(templateKey, templateName, languageCode) {
  const common = {
    name: templateName,
    category: "UTILITY",
    language: languageCode || "en_US",
    parameter_format: "NAMED",
  };

  switch (templateKey) {
    case "appointmentConfirmation":
      return {
        ...common,
        components: [
          metaBodyComponent(
            "Your appointment is confirmed, {{patient_name}}!\n\n⏱️ Date & Time: {{appointment_datetime}}\n🧑🏻‍⚕️ Doctor: {{doctor_name}}\n📍 Location: {{hospital_address}}\n Ref: {{patient_id}}\n\nIf you need to reschedule please select below option.",
            [
              { param_name: "patient_name", example: "John Doe" },
              { param_name: "appointment_datetime", example: "15 June 2026, 11:30 AM" },
              { param_name: "doctor_name", example: "Dr. Sharma" },
              { param_name: "hospital_address", example: "ABC Hospital, Delhi" },
              { param_name: "patient_id", example: "PAT-12345" },
            ]
          ),
          metaQuickReplyButtons(["Reschedule"]),
        ],
      };
    case "postOpdPrescription":
      return {
        ...common,
        components: [
          metaBodyComponent(
            "Hi {{patient_name}},\n\nYour prescription from {{doctor_name}} is ready.\n\n{{prescription_link}}\n\nPlease take your medicines as prescribed.\n\nWe'll stay in touch throughout your recovery.💙  \n\n🏥 {{hospital_name}} Care Team.",
            [
              { param_name: "patient_name", example: "John Doe" },
              { param_name: "doctor_name", example: "Dr. Sharma" },
              {
                param_name: "prescription_link",
                example: "https://example.com/prescription/123",
              },
              { param_name: "hospital_name", example: "ABC" },
            ]
          ),
        ],
      };
    case "medicineReminder":
      return {
        ...common,
        components: [
          metaBodyComponent(
            "Hi {{patient_name}},\n\nIt's time for your medicine.\n\n💊 {{medicine_details}}\n\nYour medication status will be recorded and shared with {{doctor_name}}.\n\nPlease select the appropriate option below. \n\n🏥 {{hospital_name}} Care Team.",
            [
              { param_name: "patient_name", example: "John Doe" },
              {
                param_name: "medicine_details",
                example: "Paracetamol 500mg | After Food | Breakfast",
              },
              { param_name: "doctor_name", example: "Dr. Sharma" },
              { param_name: "hospital_name", example: "ABC" },
            ]
          ),
          metaQuickReplyButtons(["Taken", "Not Yet"]),
        ],
      };
    case "finalMedicineReminder":
      return {
        ...common,
        components: [
          metaBodyComponent(
            "Hi {{patient_name}},\n\nYour prescribed medication course has been completed.\n\nPlease select your current recovery status using the options below.🤔 \n\n🏥 {{hospital_name}} Care Team.",
            [
              { param_name: "patient_name", example: "John Doe" },
              { param_name: "hospital_name", example: "ABC Hospital" },
            ]
          ),
          metaQuickReplyButtons(["Fully Recovered", "Not Yet"]),
        ],
      };
    default:
      return null;
  }
}

module.exports = {
  metaTemplatePayloadForKey,
};
