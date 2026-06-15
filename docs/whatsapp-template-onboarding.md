# WhatsApp template onboarding (4 templates)

Template **names** come from server `.env` only. The assign API creates Meta templates using fixed bodies in `src/services/metaWhatsAppTemplates.js`.

## Required .env

```env
APPOINTMENT_TEMPLATE_NAME=go_appointment_confirmation_message_1
APPOINTMENT_TEMPLATE_LANG=en_US

PRESCRIPTION_TEMPLATE_NAME=go_prescription_created_message_1
PRESCRIPTION_TEMPLATE_LANG=en_US

MEDICINE_TEMPLATE_NAME=go_medicines_reminder_message_1
MEDICINE_TEMPLATE_LANG=en_US

# 4th template (course completed) — any one of these env keys:
FINAL_MEDICINE_REMINDER_TEMPLATE_NAME=go_dosage_completion_message_1
# or legacy:
DOSAGE_COMPLETION_TEMPLATE_NAME=go_dosage_completion_message_1
FINAL_MEDICINE_REMINDER_TEMPLATE_LANG=en_US
```

| Env var | API key |
|---------|---------|
| `APPOINTMENT_TEMPLATE_NAME` | `appointmentConfirmation` |
| `PRESCRIPTION_TEMPLATE_NAME` | `postOpdPrescription` |
| `MEDICINE_TEMPLATE_NAME` | `medicineReminder` |
| `FINAL_MEDICINE_REMINDER_TEMPLATE_NAME` or `DOSAGE_COMPLETION_TEMPLATE_NAME` | `finalMedicineReminder` |

## Onboarding curl (no `templates` in body)

```bash
curl --location 'http://localhost:3000/api/whatsapp-template-assignment' \
--header 'Authorization: Bearer <SAMVAAD_JWT>' \
--header 'Content-Type: application/json' \
--data '{
  "hospitalId": "698db7d0747cdef3ecafbf2e",
  "phone_number_id": "<META_PHONE_NUMBER_ID>"
}'
```

Restart the server after changing `.env`.
