# Samvaad AI Server — Environment Variables Reference

> **Note:** Never commit real secrets to version control. Replace all placeholder values with your actual credentials before running the server. Keys marked **Required** must be set; **Optional** keys have sensible defaults.

---

## 1. App Configuration

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `NODE_ENV` | Runtime environment | `development` / `production` | Required |
| `PORT` | HTTP server port | `3000` | Required |

---

## 2. Database

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `MONGODB_URI` | MongoDB connection string (Atlas or self-hosted) | `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/<db>?appName=samvaad-server` | Required |

---

## 3. JWT / Authentication

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `JWT_ACCESS_SECRET` | Secret used to sign access tokens (min 32 chars, random hex recommended) | `<random-256-bit-hex>` | Required |
| `JWT_REFRESH_SECRET` | Secret used to sign refresh tokens (min 32 chars, random hex recommended) | `<random-256-bit-hex>` | Required |
| `JWT_ACCESS_EXPIRY` | Access token lifetime | `15m` | Required |
| `JWT_REFRESH_EXPIRY` | Refresh token lifetime | `7d` | Required |

---

## 4. OpenAI

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `OPENAI_API_KEY` | OpenAI API key for LLM calls | `sk-proj-...` | Required |

---

## 5. Noise Reduction

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `USE_NOISE_REDUCTION` | Enable/disable audio noise reduction | `true` / `false` | Optional |
| `NOISE_GATE_THRESHOLD` | Noise gate amplitude threshold (0–255) | `180` | Optional |

---

## 6. LiveKit (Voice Agent)

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `LIVEKIT_URL` | LiveKit server WebSocket URL | `wss://<your-project>.livekit.cloud` | Required |
| `LIVEKIT_API_KEY` | LiveKit API key | `APIxxxxxxxxxxxxxxx` | Required |
| `LIVEKIT_API_SECRET` | LiveKit API secret | `<livekit-api-secret>` | Required |
| `AGENT_NAME` | Name of the primary phone agent worker | `phone-agent` | Required |

---

## 7. Sarvam AI (TTS & ASR)

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `SARVAM_API_KEY` | Sarvam AI API key | `sk_xxxxxxxx_...` | Required |
| `SARVAM_TTS_MIN_BUFFER` | Minimum TTS audio buffer size (ms) | `40` | Optional |
| `SARVAM_TTS_PACE` | TTS speech pace multiplier | `1.2` | Optional |
| `SARVAM_TTS_SAMPLE_RATE` | TTS audio sample rate (Hz) | `16000` | Optional |
| `SARVAM_TTS_FRAME_MS` | TTS audio frame duration (ms) | `20` | Optional |

---

## 8. WhatsApp / Facebook

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `FACEBOOK_APP_ID` | Facebook App ID (from Meta Developer Console) | `<facebook-app-id>` | Required |
| `FACEBOOK_APP_SECRET` | Facebook App Secret | `<facebook-app-secret>` | Required |
| `FACEBOOK_WHATSAPP_CONFIGURATION_ID` | WhatsApp phone number configuration ID | `<whatsapp-config-id>` | Required |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Custom verify token for WhatsApp webhook setup | `<random-string>` | Required |
| `WHATSAPP_PRESCRIPTION_URL_BASE` | Base URL for prescription public links sent via WhatsApp | `https://dashboard.samvaadai.com/public/prescriptions/` | Required |

---

## 9. WhatsApp Message Templates

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `PRESCRIPTION_TEMPLATE_NAME` | Approved Meta template name for prescriptions | `go_prescription_created_message_1` | Required |
| `PRESCRIPTION_TEMPLATE_LANG` | Language code for prescription template | `en_US` | Required |
| `APPOINTMENT_TEMPLATE_NAME` | Approved Meta template name for appointments | `go_appointment_confirmation_message_1` | Required |
| `APPOINTMENT_TEMPLATE_LANG` | Language code for appointment template | `en_US` | Required |
| `MEDICINE_TEMPLATE_NAME` | Approved Meta template name for medicine reminders | `go_medicines_reminder_message_1` | Required |
| `MEDICINE_TEMPLATE_LANG` | Language code for medicine reminder template | `en_US` | Required |
| `DOSAGE_COMPLETION_TEMPLATE_NAME` | Approved Meta template for dosage completion | `go_dosage_completion_message_1` | Required |
| `DOSAGE_COMPLETION_TEMPLATE_LANG` | Language code for dosage completion template | `en_US` | Required |
| `DOSAGE_FOLLOWUP_NOT_YET_TEMPLATE_NAME` | Approved Meta template for dosage follow-up (not yet taken) | `go_dosage_followup_not_yet_message_1` | Required |
| `DOSAGE_FOLLOWUP_NOT_YET_TEMPLATE_LANG` | Language code for dosage follow-up template | `en_US` | Required |

---

## 10. Tele-callers

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `TELECALLER_BOOKING_LINK` | Base URL for tele-caller booking portal | `https://dashboard.samvaadai.com/telecaller/` | Optional |

---

## 11. Razorpay (Payments)

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `RAZORPAY_KEY_ID` | Razorpay Key ID (Dashboard → API Keys) | `rzp_live_...` | Required |
| `RAZORPAY_KEY_SECRET` | Razorpay Key Secret | `<razorpay-key-secret>` | Required |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay Webhook signing secret (Dashboard → Webhooks → Secret) | `<razorpay-webhook-secret>` | Required |

---

## 12. Google Calendar / OAuth

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID | `xxxxxxxxx.apps.googleusercontent.com` | Required |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret | `GOCSPX-...` | Required |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL (must match Google Console) | `https://api.samvaadai.com/auth/google/callback` | Required |
| `RONTEND_GOOGLE_OAUTH_RETURN_URL` | Frontend URL to redirect after Google OAuth success | `https://dashboard.samvaadai.com/settings` | Required |

> **Note:** `RONTEND_GOOGLE_OAUTH_RETURN_URL` is missing the leading `F` — this is a known typo in the codebase. Do not rename without updating all references.

---

## 13. Cron Jobs

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `PAYOUT_CRON_USE_CURRENT_MONTH` | Use current month for payout cron calculations (`1` = yes) | `1` | Optional |

---

## 14. Email (SMTP & Mailtrap)

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `API_PUBLIC_URL` | Public base URL of this API server | `https://api.samvaad.in` | Required |
| `SMTP_HOST` | SMTP server hostname | `smtp.gmail.com` | Required |
| `SMTP_PORT` | SMTP server port | `587` | Required |
| `SMTP_SECURE` | Use TLS (`true`) or STARTTLS (`false`) | `false` | Required |
| `SMTP_USER` | SMTP login username / email | `support@samvaadai.com` | Required |
| `SMTP_PASS` | SMTP login password or app password | `<smtp-app-password>` | Required |
| `MAILTRAP_API_KEY` | Mailtrap Sending API key (for transactional emails) | `<mailtrap-api-key>` | Required |
| `MAIL_FROM` | Sender name and address for outgoing emails | `Samvaad AI<support@samvaadai.com>` | Required |
| `MAILTRAP_EMAIL_CATEGORY` | Mailtrap inbox category label | `Integration Test` | Optional |

---

## 15. App Settings

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `AVG_PATIENT_CHECKUP_DURATION` | Average appointment duration in minutes (used for scheduling) | `10` | Optional |
| `UPLOADS_CORS_ORIGINS` | Comma-separated list of allowed CORS origins for file uploads | `https://dashboard.samvaadai.com,http://localhost:5173` | Required |

---

## 16. Exotel (Telephony)

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `EXOTEL_API_KEY` | Exotel API key | `<exotel-api-key>` | Required |
| `EXOTEL_API_TOKEN` | Exotel API token | `<exotel-api-token>` | Required |
| `EXOTEL_ACCOUNT_SID` | Exotel account SID / subdomain prefix | `<exotel-account-sid>` | Required |
| `EXOTEL_SUBDOMAIN` | Exotel API subdomain | `api.in.exotel.com` | Required |

---

## 17. Redis (Call Queue & Reminder Worker)

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `REDIS_URL` | Redis connection URL | `redis://127.0.0.1:6379` | Required |

---

## 18. LiveKit Call Queue

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `LIVEKIT_QUEUE_ENABLED` | Enable call queue worker (`1` = enabled) | `1` | Optional |
| `QUEUE_MAX_CONCURRENT_CALLS` | Maximum simultaneous active calls | `2` | Optional |
| `QUEUE_MAX_SIZE` | Maximum number of callers waiting in queue | `10` | Optional |
| `QUEUE_AGENT_NAME` | LiveKit agent name for the queue worker | `phone-queue` | Optional |
| `PHONE_AGENT_NAME` | LiveKit agent name for the active call handler | `phone-agent` | Optional |

---

## 19. Hold Audio

| Key | Description | Example Value | Required |
|-----|-------------|---------------|----------|
| `QUEUE_HOLD_AUDIO_ENABLED` | Play hold music while caller waits in queue | `true` / `false` | Optional |
| `QUEUE_HOLD_AUDIO_FILE` | Absolute path to a `.wav` hold music file | `/path/to/hold-music.wav` | Optional |
| `QUEUE_HOLD_AUDIO_VOLUME` | Hold audio volume (0.0 – 1.0) | `0.60` | Optional |
| `QUEUE_REASSURANCE_INTERVAL_SECONDS` | Seconds between TTS reassurance messages to queued callers | `60` | Optional |

---

## Quick Setup Checklist

- [ ] Copy `.env.example` (or this document) to `.env`
- [ ] Set `NODE_ENV`, `PORT`, `MONGODB_URI`
- [ ] Generate strong random values for `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`
- [ ] Add `OPENAI_API_KEY`
- [ ] Configure LiveKit (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`)
- [ ] Add `SARVAM_API_KEY`
- [ ] Set up Facebook / WhatsApp credentials
- [ ] Configure Razorpay keys (use `rzp_test_` prefix for staging)
- [ ] Set up Google OAuth credentials
- [ ] Configure SMTP / Mailtrap for email
- [ ] Add Exotel telephony credentials
- [ ] Ensure Redis is running and set `REDIS_URL`
