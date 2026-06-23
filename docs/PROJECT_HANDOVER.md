# Samvaad AI — Project Handover Document

**Version:** 1.0.0
**Date:** June 23, 2026
**Prepared by:** Technical Documentation Team
**Classification:** Confidential

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-06-23 | Technical Team | Initial handover document |

---

## Table of Contents

1. Executive Summary
2. System Architecture
3. Technology Stack
4. Folder Structure
5. Environment Configuration
6. Database Documentation
7. API Documentation
8. Authentication & Authorization
9. Third-Party Integrations
10. Deployment Guide
11. Infrastructure Documentation
12. Monitoring & Logging
13. Testing
14. Known Issues
15. Backup & Recovery
16. Security Considerations
17. Operational Runbook
18. Future Enhancements
19. Appendix

---

## 1. Executive Summary

### Project Name
**Samvaad AI** (`samvaad-server`)

### Purpose
Samvaad AI is a full-stack Hospital Management and AI Voice Booking Agent platform. It enables hospitals to manage patients, doctors, appointments, and prescriptions through a REST API, and automates patient appointment booking via an AI-powered voice agent that answers phone calls in Hindi and English.

### Business Objective
- Reduce hospital receptionist workload by automating appointment booking via voice AI
- Deliver post-booking confirmation, prescription reminders, and medicine reminders via WhatsApp
- Provide hospitals with a unified dashboard for patient records, revenue, and analytics
- Enable automated payment collection and payout management

### Key Features

| Feature | Description |
|---------|-------------|
| AI Voice Booking Agent | LiveKit + OpenAI Realtime API phone agent; books appointments, speaks Hindi & English |
| WhatsApp Notifications | Appointment confirmations, prescriptions, medicine reminders via Meta Cloud API |
| Appointment Management | Full CRUD with slot availability, doctor schedules, and calendar integration |
| Medicine Reminders | BullMQ-scheduled WhatsApp reminders at breakfast/lunch/dinner times |
| Prescription Management | Digital prescriptions with WhatsApp delivery and patient portal link |
| Payment Integration | Razorpay payment collection with webhook verification and payout tracking |
| Multi-Hospital Support | Complete data isolation per hospital; role-based access across hospitals |
| Call Queue System | Phone queue with hold music, transfer messages, and LiveKit SIP integration |
| Google Calendar | Doctor appointment sync via Google OAuth 2.0 and Google Meet links |
| Exotel Call Analytics | Monthly call log sync and analytics for inbound/outbound calls |

### Current Status
**Production** — deployed on a Linux VPS (DigitalOcean Droplet) managed by PM2. The voice agent, queue worker, API server, and reminder worker run as four independent PM2 processes.

---

## 2. System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INTERNET / CALLERS                            │
│                                                                       │
│   Phone Call ──► Exotel/SIP ──► LiveKit ──► Voice Agent              │
│   WhatsApp ─────────────────────────────► API Server                  │
│   Dashboard ────────────────────────────► API Server                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │    VPS (Droplet)     │
                   │                     │
                   │  ┌───────────────┐  │
                   │  │  samvaad-api  │  │ ◄── REST API (port 3000)
                   │  │  (Express.js) │  │
                   │  └───────┬───────┘  │
                   │          │          │
                   │  ┌───────▼───────┐  │
                   │  │ samvaad-      │  │ ◄── LiveKit Voice Agent
                   │  │ livekit-worker│  │     (port 8081)
                   │  └───────────────┘  │
                   │                     │
                   │  ┌───────────────┐  │
                   │  │ samvaad-queue │  │ ◄── Phone Queue Worker
                   │  │ -worker       │  │     (port 8082)
                   │  └───────────────┘  │
                   │                     │
                   │  ┌───────────────┐  │
                   │  │ samvaad-      │  │ ◄── Medicine Reminder Worker
                   │  │ reminder-     │  │
                   │  │ worker        │  │
                   │  └───────────────┘  │
                   │                     │
                   │  ┌───────────────┐  │
                   │  │   MongoDB     │  │ ◄── Primary Database
                   │  └───────────────┘  │
                   │                     │
                   │  ┌───────────────┐  │
                   │  │    Redis      │  │ ◄── BullMQ Job Queues
                   │  └───────────────┘  │
                   └─────────────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  SAMVAAD-API (Express.js)                                            │
│                                                                       │
│  Routes → Controllers → Services → Models (Mongoose)                 │
│                                                                       │
│  Embedded Workers (dev) / Standalone PM2 processes (production):     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │ Reminder Worker   ── BullMQ ── Redis ── WhatsApp Cloud   │       │
│  │ Appointment Worker── BullMQ ── Redis ── WhatsApp Cloud   │       │
│  │ Doctor Holiday Worker ── BullMQ ── Redis                  │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                       │
│  Cron Jobs:                                                           │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │ Hourly Payout Cron   (node-cron)                         │       │
│  │ Exotel Monthly Sync  (node-cron)                         │       │
│  └──────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  SAMVAAD-LIVEKIT-WORKER (LiveKit Agents SDK v1.2)                   │
│                                                                       │
│  SIP Call ──► Silero VAD ──► Sarvam STT ──► OpenAI Realtime         │
│                          └──► OpenAI Realtime (fallback STT)         │
│  OpenAI Realtime ──► Tool Handlers ──► MongoDB (appointments)        │
│                 └──► Sarvam TTS ──► SIP playback                     │
│                                                                       │
│  Post-Call: OpenAI GPT-4 extraction ──► Appointment update           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  SAMVAAD-QUEUE-WORKER (LiveKit Agents SDK v1.2)                     │
│                                                                       │
│  Incoming Call ──► Hold Music ──► Queue ──► Transfer to Agent        │
│                                         └──► Transfer Message        │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow — Appointment Booking via Voice

```
1. Patient calls hospital phone number
         │
         ▼
2. Exotel/SIP routes call to LiveKit room
         │
         ▼
3. Queue Worker (if LIVEKIT_QUEUE_ENABLED) plays hold music
         │
         ▼
4. LiveKit Worker accepts call; Silero VAD detects speech
         │
         ▼
5. Sarvam STT (or OpenAI STT) transcribes caller audio
         │
         ▼
6. OpenAI Realtime model processes text; calls tools:
   - list_available_slots  ──► MongoDB
   - search_doctors        ──► MongoDB
   - create_appointment    ──► MongoDB + BullMQ queue
         │
         ▼
7. Tool result → Sarvam TTS → audio playback to caller
         │
         ▼
8. BullMQ job triggers WhatsApp confirmation to patient
         │
         ▼
9. Post-call: GPT-4 extracts unstructured info → MongoDB
```

### External Integrations

| Service | Role |
|---------|------|
| OpenAI Realtime API | Voice agent brain (gpt-realtime-mini-2025-12-15) |
| OpenAI GPT-4.1 | Post-call data extraction |
| Sarvam AI | Hindi/English STT and TTS |
| LiveKit Cloud | WebRTC/SIP voice infrastructure |
| Meta WhatsApp Cloud API | Outbound WhatsApp messages |
| WhatsAPI (optional) | Self-hosted WhatsApp alternative |
| Razorpay | Payment collection and webhooks |
| Google Calendar API | Appointment event creation + Meet links |
| Exotel | SIP telephony and call analytics |
| Mailtrap | Transactional email (password reset, welcome) |
| Redis | BullMQ job queues (reminders, confirmations) |
| MongoDB | Primary database |
| Cloudflare Tunnel | Optional: local dev HTTPS tunnel |

---

## 3. Technology Stack

### Backend

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | ≥18.x |
| Framework | Express.js | ^4.22.1 |
| Database ODM | Mongoose | ^8.7.0 |
| Job Queues | BullMQ | ^5.72.1 |
| Redis Client | ioredis | ^5.10.1 |
| Auth | jsonwebtoken | ^9.0.2 |
| Password Hashing | bcryptjs | ^2.4.3 |
| Rate Limiting | express-rate-limit | ^8.2.1 |
| Validation | express-validator + zod | ^7.3.1 / ^3.25.76 |
| File Upload | multer | ^2.0.2 |
| Cron | node-cron | ^3.0.3 |

### AI / Voice Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Voice Agent SDK | @livekit/agents | ^1.2.1 |
| OpenAI Plugin | @livekit/agents-plugin-openai | ^1.2.1 |
| VAD (Voice Activity Detection) | @livekit/agents-plugin-silero | 1.2.2 |
| Noise Cancellation | @livekit/noise-cancellation-node | ^0.1.9 |
| LiveKit Server SDK | livekit-server-sdk | ^2.15.0 |
| OpenAI SDK | openai | ^6.21.0 |
| Sarvam AI SDK | sarvamai | ^1.1.7 |

### Third-Party APIs

| Component | Library/SDK |
|-----------|-------------|
| Google APIs | googleapis ^171.4.0 |
| Razorpay | razorpay ^2.9.6 |
| Excel Import | exceljs ^4.4.0 |
| HTTP Forms | form-data ^4.0.5 |

### Frontend
Not Found in Codebase — this repository is the backend API only. A separate frontend (Vite/React, running at `http://localhost:5173` in development) is referenced in CORS settings but is not part of this repo.

### Database

| Component | Detail |
|-----------|--------|
| Type | MongoDB (Atlas or self-hosted) |
| ODM | Mongoose 8.x |
| Collections | 18 collections (see Section 6) |
| Caching | Redis (via ioredis) for BullMQ queues |

### Infrastructure

| Component | Detail |
|-----------|--------|
| Process Manager | PM2 (4 processes) |
| Hosting | Linux VPS (DigitalOcean Droplet) |
| Timezone | Asia/Kolkata (IST) enforced via TZ env |
| Tunneling (dev) | Cloudflare Tunnel (`cloudflared`) |
| Static Files | Express static at `/uploads` |
| CI/CD | Not Found in Codebase |
| SSL | Not Found in Codebase (Nginx/Caddy assumed upstream) |

---

## 4. Folder Structure

```
samvaad-server/
├── index.js                          # Main entry: starts API + embedded workers
├── ecosystem.config.cjs              # PM2 production process definitions
├── package.json
│
├── src/                              # API server source
│   ├── app.js                        # Express app setup: CORS, middleware, routes
│   ├── config/
│   │   ├── db.js                     # MongoDB connection (connectDB)
│   │   └── env.js                    # All environment variables with defaults
│   ├── constants/
│   │   └── roles.js                  # ROLES enum + ROLE_HIERARCHY + helpers
│   ├── controllers/                  # Request handlers (one per resource)
│   │   ├── appointmentController.js
│   │   ├── authController.js
│   │   ├── doctorController.js
│   │   ├── hospitalController.js
│   │   ├── hospitalSettingsController.js
│   │   ├── medicineController.js     # Prefix search on medicineName
│   │   ├── patientController.js
│   │   ├── paymentController.js
│   │   ├── prescription.controller.js
│   │   └── ...
│   ├── middleware/
│   │   ├── auth.js                   # JWT protect + optionalAuth
│   │   ├── roles.js                  # requireAdmin, requireStaff, etc.
│   │   └── hospitalSettingsAccess.js
│   ├── models/                       # Mongoose schemas
│   │   ├── User.js
│   │   ├── RefreshToken.js
│   │   ├── appointment.model.js
│   │   ├── doctor.model.js
│   │   ├── hospital.model.js
│   │   ├── hospitalSettings.model.js
│   │   ├── medicine.model.js
│   │   ├── observation.model.js
│   │   ├── patient.model.js
│   │   ├── paymentHistory.model.js
│   │   ├── paymentTransaction.model.js
│   │   ├── payoutList.model.js
│   │   ├── prescription.model.js
│   │   ├── whatsapp.model.js
│   │   ├── whatsappOnboarding.model.js
│   │   └── whatsappTemplateAssignment.model.js
│   ├── routes/                       # Express route definitions
│   │   ├── index.js                  # Route aggregator
│   │   ├── authRoutes.js
│   │   ├── appointmentRoutes.js
│   │   ├── doctorRoutes.js
│   │   ├── hospitalRoutes.js
│   │   ├── medicineRoutes.js
│   │   ├── patientRoutes.js
│   │   ├── prescriptionRoutes.js
│   │   ├── whatsappRoutes.js
│   │   └── ...
│   ├── services/                     # Business logic / external API clients
│   │   ├── appointmentWhatsAppNotify.js   # WhatsApp appointment confirmation
│   │   ├── appointmentConfirmationDispatch.js  # BullMQ enqueue
│   │   ├── reminder.service.js            # Medicine reminder scheduling
│   │   ├── reminderWhatsAppNotify.js      # WhatsApp reminder messages
│   │   ├── whatsappCloud.js              # Meta Cloud API client
│   │   ├── googleMeet.service.js
│   │   └── ...
│   ├── queues/                       # BullMQ queue definitions
│   │   ├── reminder.queue.js
│   │   ├── appointmentConfirmation.queue.js
│   │   └── doctorHoliday.queue.js
│   ├── workers/                      # BullMQ worker processors
│   │   ├── reminder.worker.js        # Sends medicine reminders
│   │   ├── appointmentConfirmation.worker.js
│   │   ├── doctorHoliday.worker.js
│   │   └── reminderWorkerEntry.js    # Standalone entry for PM2
│   ├── cron/
│   │   ├── hourlyPayout/             # Hourly payout aggregation cron
│   │   └── exotel/                   # Monthly Exotel call sync cron
│   └── agent/                        # AI agent support files
│       ├── hospitalPrompt.js         # Dynamic system prompt with IST date/time
│       ├── realtimeToolHandlers.js   # Tool implementations (book, search, slots)
│       ├── realtimeTools.js          # Tool definitions for OpenAI
│       └── hospitalInstructionCache.js
│
├── livekit-agent/                    # Voice Agent process
│   ├── main.js                       # Agent entry point (LiveKit defineAgent)
│   ├── agent.js                      # Core agent logic + tool result sanitizer
│   ├── phoneQueueWorker.js           # Queue worker process
│   ├── sarvamStt.js                  # Sarvam STT adapter
│   ├── sarvamTts.js                  # Sarvam TTS adapter
│   ├── endPhoneCall.js               # Auto-hangup after booking
│   ├── postCallPipeline.js           # GPT-4 post-call extraction
│   ├── agentEnv.js                   # Env helpers (parseEnvMs, etc.)
│   ├── callLogger.js                 # Call transcript logging
│   └── queue/                        # Queue audio/config files
│       ├── queueAudio.js             # Hold + transfer messages
│       ├── queueConfig.js
│       └── queueService.js
│
├── scripts/
│   ├── import-medicines/             # Bulk Excel medicine importer
│   │   ├── import-medicines.js       # Main importer (streaming, batched)
│   │   └── config.js                 # Column mapping configuration
│   └── start-cloudflare-tunnel.js    # Cloudflare tunnel helper
│
├── docs/                             # Project documentation
│   └── PROJECT_HANDOVER.md           # This document
│
├── uploads/                          # Hospital logos + uploaded files
│
└── ai/                               # AI extraction helpers
    ├── prompts/extractionPrompt.js
    └── services/
        ├── extractAppointment.js
        └── processAppointment.js
```

---

## 5. Environment Configuration

All variables are loaded from a `.env` file in the project root via `dotenv`.

### Core Server

| Variable | Purpose | Required |
|----------|---------|----------|
| `NODE_ENV` | `production` / `development` | Optional (default: `development`) |
| `PORT` | API HTTP port | Optional (default: `3000`) |
| `TZ` | Server timezone | Optional (default: `Asia/Kolkata`) |
| `MONGODB_URI` | MongoDB connection string | **Required** |
| `UPLOADS_ROOT` | Filesystem path for uploaded files | Optional (default: `./uploads`) |
| `UPLOADS_CORS_ORIGINS` | Comma-separated frontend origins for CORS | Optional |

### Authentication

| Variable | Purpose | Required |
|----------|---------|----------|
| `JWT_ACCESS_SECRET` | Signs access tokens | **Required in production** |
| `JWT_REFRESH_SECRET` | Signs refresh tokens | **Required in production** |
| `JWT_ACCESS_EXPIRY` | Access token TTL | Optional (default: `15m`) |
| `JWT_REFRESH_EXPIRY` | Refresh token TTL | Optional (default: `7d`) |
| `JWT_PASSWORD_RESET_SECRET` | Signs password-reset tokens | Optional |

### Redis / BullMQ

| Variable | Purpose | Required |
|----------|---------|----------|
| `REDIS_URL` | Full Redis URL (overrides HOST/PORT/PASSWORD) | Optional |
| `REDIS_HOST` | Redis hostname | Optional (default: `127.0.0.1`) |
| `REDIS_PORT` | Redis port | Optional (default: `6379`) |
| `REDIS_PASSWORD` | Redis auth password | Optional |

### WhatsApp (Meta Cloud API)

| Variable | Purpose | Required |
|----------|---------|----------|
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | Meta permanent access token | **Required** |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | Meta phone number ID | **Required** |
| `WHATSAPP_CLOUD_API_VERSION` | Graph API version | Optional (default: `v21.0`) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Webhook verification token | **Required** |
| `APPOINTMENT_TEMPLATE_NAME` | Approved appointment template name | **Required** |
| `APPOINTMENT_TEMPLATE_LANG` | Template language code | Optional (default: `en_US`) |
| `APPOINTMENT_TEMPLATE_PARAM_FORMAT` | `named` or `positional` | Optional (default: `named`) |
| `PRESCRIPTION_TEMPLATE_NAME` | Prescription notification template | Optional |
| `MEDICINE_TEMPLATE_NAME` | Medicine reminder template | Optional |
| `DOSAGE_COMPLETION_TEMPLATE_NAME` | Dosage completion template | Optional |
| `DOSAGE_FOLLOWUP_NOT_YET_TEMPLATE_NAME` | Follow-up not yet template | Optional |
| `WHATSAPP_PRESCRIPTION_URL_BASE` | Base URL for prescription deep links | Optional |

### WhatsAPI (Self-hosted WhatsApp — alternative)

| Variable | Purpose | Required |
|----------|---------|----------|
| `WHATSAPI_BASE_URL` | WhatsAPI server URL | Optional |
| `WHATSAPI_TOKEN` | WhatsAPI auth token | Optional |
| `WHATSAPI_INSTANCE_KEY` | WhatsAPI instance key | Optional |

### Medicine Reminders

| Variable | Purpose | Required |
|----------|---------|----------|
| `REMINDER_SYSTEM_ENABLED` | Global kill-switch (`0` to disable) | Optional (default: ON) |
| `REMINDER_TIMEZONE` | IANA timezone for reminder scheduling | Optional (default: `Asia/Kolkata`) |
| `BREAKFAST_TIME` | Breakfast reminder window `HH:MM-HH:MM` | Optional (default: `08:00-09:00`) |
| `LUNCH_TIME` | Lunch reminder window | Optional (default: `13:00-14:00`) |
| `DINNER_TIME` | Dinner reminder window | Optional (default: `20:00-21:00`) |
| `REMINDER_WORKER_DISABLED` | Set `1` to disable embedded worker | Optional |
| `REMINDER_TEST_MODE` | Fast test mode (hourly cycles) | Optional |

### LiveKit Voice Agent

| Variable | Purpose | Required |
|----------|---------|----------|
| `LIVEKIT_URL` | LiveKit server WebSocket URL | **Required** |
| `LIVEKIT_API_KEY` | LiveKit API key | **Required** |
| `LIVEKIT_API_SECRET` | LiveKit API secret | **Required** |
| `OPENAI_API_KEY` | OpenAI API key (Realtime + GPT-4) | **Required** |
| `SARVAM_API_KEY` | Sarvam AI API key (STT + TTS) | Optional |
| `SARVAM_STT_STREAMING` | `0` = batch REST, `1` = streaming WS | Optional (default: `0`) |
| `OPENAI_REALTIME_MODEL` | Realtime model ID | Optional (default: `gpt-realtime-mini-2025-12-15`) |
| `OPENAI_LLM_MODEL` | GPT model for post-call extraction | Optional (default: `gpt-4.1`) |
| `LIVEKIT_WORKER_DISABLED` | Set `1` to skip LiveKit worker in API process | Optional |
| `QUEUE_WORKER_DISABLED` | Set `1` to skip queue worker in API process | Optional |
| `LIVEKIT_QUEUE_ENABLED` | Enable phone queue worker | Optional |
| `AGENT_NAME` | Agent room prefix | Optional (default: `phone-agent`) |
| `AGENT_COMPACT_HOSPITAL_PROMPT` | Shorter system prompt in production | Optional |

### Payments (Razorpay)

| Variable | Purpose | Required |
|----------|---------|----------|
| `RAZORPAY_KEY_ID` | Razorpay public key | **Required for payments** |
| `RAZORPAY_KEY_SECRET` | Razorpay secret key | **Required for payments** |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook HMAC secret | **Required for payments** |

### Google

| Variable | Purpose | Required |
|----------|---------|----------|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID | **Required for Calendar** |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret | **Required for Calendar** |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL | **Required for Calendar** |
| `GOOGLE_CALENDAR_ID` | Calendar ID (`primary` or email) | Optional (default: `primary`) |
| `FRONTEND_GOOGLE_OAUTH_RETURN_URL` | Frontend redirect after OAuth | Optional |

### Email (Mailtrap)

| Variable | Purpose | Required |
|----------|---------|----------|
| `MAILTRAP_API_KEY` | Mailtrap sending API key | **Required for email** |
| `MAIL_FROM` | Sender address (e.g. `hello@demomailtrap.co`) | **Required for email** |
| `DASHBOARD_URL` | Dashboard URL for welcome emails | Optional |
| `API_PUBLIC_URL` | API public URL for reset links | Optional |

### Exotel

| Variable | Purpose | Required |
|----------|---------|----------|
| `EXOTEL_ACCOUNT_SID` | Exotel account SID | **Required for Exotel** |
| `EXOTEL_API_KEY` | Exotel API key | **Required for Exotel** |
| `EXOTEL_API_TOKEN` | Exotel API token | **Required for Exotel** |
| `EXOTEL_REGION` | `in` (India) or `sg` | Optional (default: `in`) |

### Facebook / Meta (WhatsApp onboarding)

| Variable | Purpose | Required |
|----------|---------|----------|
| `FACEBOOK_APP_ID` | Meta App ID | **Required for WA onboarding** |
| `FACEBOOK_APP_SECRET` | Meta App secret | **Required for WA onboarding** |

---

## 6. Database Documentation

All collections use MongoDB via Mongoose. The database name is derived from `MONGODB_URI`.

---

### Collection: `users`

**Purpose:** Authentication accounts for all portal users (hospital admins, doctors, tele-callers, super admins).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `_id` | ObjectId | Auto | |
| `name` | String | Yes | Full name |
| `email` | String | Yes | Unique |
| `password` | String | Yes | bcrypt hashed |
| `role` | String (enum) | Yes | See roles below |
| `hospital` | ObjectId → Hospital | No | Required for hospital roles |
| `doctorProfile` | ObjectId → Doctor | No | For doctor users |
| `isActive` | Boolean | Yes | Account enabled flag |
| `profilePicture` | String | No | URL |
| `createdAt` | Date | Auto | |

**Roles:** `user`, `doctor`, `tele_caller`, `moderator`, `hospital_admin`, `admin`, `super_admin`

**Indexes:** `{ role: 1 }`, `{ doctorProfile: 1 }` (unique, sparse)

---

### Collection: `refreshtokens`

**Purpose:** Tracks active refresh tokens for JWT rotation and multi-device logout.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `token` | String | Yes | Raw refresh token |
| `user` | ObjectId → User | Yes | |
| `expiresAt` | Date | Yes | TTL index auto-deletes expired |

**Indexes:** `{ user: 1 }`, `{ expiresAt: 1 }` (TTL — auto-expires)

---

### Collection: `hospitals`

**Purpose:** Hospital accounts. Each hospital is the root data scope.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | Yes | Hospital display name |
| `address` | String | Yes | |
| `city` | String | Yes | |
| `state` | String | Yes | |
| `pincode` | String | Yes | |
| `phone` | String | Yes | |
| `email` | String | Yes | |
| `logoUrl` | String | No | Uploaded logo path |
| `whatsappPhone` | String | Yes | Hospital WhatsApp number |
| `doctorAvailableHours` | Object | Yes | `{ from, to }` |
| `slotDurationMinutes` | Number | Yes | Default appointment slot |
| `services` | [String] | Yes | |

---

### Collection: `doctors`

**Purpose:** Doctor profiles linked to a hospital.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `hospital` | ObjectId → Hospital | No | |
| `name` | String | Yes | |
| `specialization` | String | Yes | |
| `qualification` | String | Yes | |
| `phone` | String | Yes | |
| `email` | String | Yes | |
| `status` | Enum | Yes | `On Duty`, `On Break`, `Off Duty`, `On Leave` |
| `availableFrom` | Number | Yes | Hour (24h) |
| `availableTo` | Number | Yes | Hour (24h) |
| `holidayDates` | [{ startDate, endDate }] | No | Date ranges off |
| `consultationFee` | Number | No | |

---

### Collection: `patients`

**Purpose:** Patient records per hospital.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `hospital` | ObjectId → Hospital | No | |
| `name` | String | Yes | |
| `phone` | String | Yes | 10-digit |
| `age` | Number | Yes | |
| `weight` | Number | No | kg |
| `gender` | Enum | Yes | `Male`, `Female`, `Other` |
| `address` | String | Yes | |

---

### Collection: `appointments`

**Purpose:** Core booking record.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `hospital` | ObjectId → Hospital | No | |
| `patient` | ObjectId → Patient | Yes | |
| `doctor` | ObjectId → Doctor | Yes | |
| `appointmentId` | String | No | Display ID (e.g. `APT-0001`) |
| `status` | Enum | Yes | `Today`, `Upcoming`, `Completed`, `Cancelled` |
| `type` | Enum | No | `opd`, `video_call`, `phone_call` |
| `scheduledAt` | Date | Yes | ISO UTC |
| `notes` | String | No | |
| `payment` | ObjectId → PaymentHistory | No | |

**Indexes:** Compound index on `{ hospital, patient, doctor, scheduledAt }`

---

### Collection: `prescriptions`

**Purpose:** Digital prescriptions created by doctors.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `hospital` | ObjectId → Hospital | No | |
| `patient` | ObjectId → Patient | Yes | |
| `appointment` | ObjectId → Appointment | No | |
| `prescriptionId` | String | No | Display ID |
| `date` | Date | No | |
| `followUp` | `{ value, unit }` | No | e.g. `{ value: 7, unit: "days" }` |
| `medicines` | [MedicineEntry] | Yes | See below |

**MedicineEntry fields:** `name`, `dosage`, `frequency`, `duration`, `intake`, `meals { breakfast, lunch, dinner }`, `notes`

---

### Collection: `medicines`

**Purpose:** Master medicine catalog for prescription autocomplete and reminders.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `medicineName` | String | Yes | |
| `type` | String | Yes | Dosage form (Tablet, Capsule, Syrup…) |
| `value` | String | No | Numeric dose (e.g. `500`) |
| `unit` | String | No | Measurement unit (e.g. `mg`, `ml`) |

**Indexes:**
- `{ medicineName: 1 }`
- `{ createdAt: -1 }`
- `{ medicineName: 1 }` with collation `{ locale: 'en', strength: 2 }` — **name: `medicineName_ci_prefix`** — enables fast prefix (starts-with) search

---

### Collection: `hospitalsettings`

**Purpose:** Per-hospital feature toggles.

| Field | Type | Notes |
|-------|------|-------|
| `hospital` | ObjectId → Hospital | |
| `whatsapp.isEnabled` | Boolean | Master WhatsApp switch |
| `whatsapp.appointment` | Boolean | Appointment notifications |
| `whatsapp.prescription` | Boolean | Prescription notifications |
| `whatsapp.medicinesReminder` | Boolean | Medicine reminder switch |
| `teleCaller.isEnabled` | Boolean | Tele-caller module |

---

### Collection: `whatsapps`

**Purpose:** WhatsApp Business Account credentials per hospital (Meta Cloud).

| Field | Type | Notes |
|-------|------|-------|
| `hospital` | ObjectId → Hospital | |
| `waba_id` | String | WhatsApp Business Account ID |
| `phone_number_id` | String | Meta phone number ID |
| `access_token` | String | Meta permanent token |
| `api_version` | String | Graph API version |

---

### Collection: `whatsapptemplateassignments`

**Purpose:** Maps hospital to approved WhatsApp template names.

| Field | Type | Notes |
|-------|------|-------|
| `hospital` | ObjectId | |
| `language` | String | `en_US`, `hi`, etc. |
| `templateKeys.appointmentConfirmation` | String | Template name |
| `templateKeys.postOpdPrescription` | String | |
| `templateKeys.medicineReminder` | String | |
| `templateKeys.dosageCompletion` | String | |
| `templateKeys.dosageFollowupNotYet` | String | |

---

### Collection: `paymenthistories`

**Purpose:** Records of Razorpay payment captures linked to hospitals/patients.

| Field | Type | Notes |
|-------|------|-------|
| `razorpayOrderId` | String | |
| `razorpayPaymentId` | String | |
| `amount` | Number | Paise |
| `currency` | String | `INR` |
| `status` | Enum | `captured`, `failed`, `pending` |
| `hospital` | ObjectId | |
| `patient` | ObjectId | |
| `doctor` | ObjectId | |

---

### Collection: `paymenttransactions`

**Purpose:** Reconciliation of payment transactions; supports tele-caller and Razorpay webhook sources.

---

### Collection: `payoutlists`

**Purpose:** Monthly payout summaries per hospital.

| Field | Type | Notes |
|-------|------|-------|
| `hospitalId` | String | |
| `hospital` | ObjectId | |
| `startDate` | Date | Period start |
| `endDate` | Date | Period end |
| `amount` | Number | |
| `status` | Enum | `draft`, `paid` |

**Unique index:** `{ hospitalId, startDate, endDate }`

---

### Collection: `observations`

**Purpose:** Clinical observations/notes for a patient visit.

| Field | Type | Notes |
|-------|------|-------|
| `hospital` | ObjectId | |
| `patientId` | ObjectId → Patient | |
| `entries` | [{ text, recordedAt }] | |

---

### Collection: `exotelcalls`

**Purpose:** Synced Exotel call records for analytics.

Key fields: `sid`, `callSid`, `from`, `to`, `status`, `direction`, `duration`, `creditUsed`, `startTime`, `syncMonth`

---

### Collection: `googleoauthtokens`

**Purpose:** Google OAuth 2.0 access + refresh tokens per hospital (for Calendar integration).

**Unique index:** `{ hospital: 1, provider: 1 }`

---

### Collection: `whatsapponboardings`

**Purpose:** Tracks WhatsApp Business onboarding steps per hospital.

---

## 7. API Documentation

Base URL: `https://<your-domain>/api`
All endpoints require `Authorization: Bearer <accessToken>` unless marked **Public**.

### Authentication Routes — `/api/auth`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/auth/register` | Public | Register new user |
| POST | `/auth/login` | Public | Login; returns access + refresh tokens |
| POST | `/auth/refresh` | Public | Exchange refresh token for new access token |
| POST | `/auth/logout` | Public | Invalidate refresh token |
| POST | `/auth/forgot-password` | Public | Send password-reset email |
| POST | `/auth/reset-password` | Public | Reset password with token |
| GET | `/auth/me` | Protected | Get current user profile |
| PATCH | `/auth/me` | Protected | Update profile |
| POST | `/auth/me/profile-picture` | Protected | Upload profile picture |
| POST | `/auth/logout-all` | Protected | Revoke all refresh tokens |

**Login Request:**
```json
POST /api/auth/login
{ "email": "admin@hospital.com", "password": "secret123" }
```
**Login Response:**
```json
{
  "success": true,
  "data": {
    "user": { "_id": "...", "name": "Admin", "role": "hospital_admin" },
    "accessToken": "eyJ...",
    "refreshToken": "eyJ..."
  }
}
```

---

### Hospital Routes — `/api/hospitals`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/hospitals` | Admin | List all hospitals (paginated) |
| GET | `/hospitals/search` | Admin | Search hospitals by name |
| GET | `/hospitals/:id` | Admin | Get hospital by ID |
| POST | `/hospitals` | Super Admin | Create hospital |
| PATCH | `/hospitals/:id` | Admin | Update hospital |
| DELETE | `/hospitals/:id` | Super Admin | Delete hospital |

---

### Doctor Routes — `/api/doctors`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/doctors` | Staff | List doctors (paginated) |
| GET | `/doctors/names` | Staff | Lightweight list (name + ID only) |
| GET | `/doctors/search` | Staff | Search by name |
| GET | `/doctors/by-email` | Staff | Find by email |
| GET | `/doctors/:id` | Staff | Get doctor by ID |
| POST | `/doctors` | Admin | Create doctor |
| PATCH | `/doctors/:id` | Admin | Update doctor |
| DELETE | `/doctors/:id` | Admin | Remove doctor |

---

### Patient Routes — `/api/patients`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/patients` | Staff / TeleCaller | List patients (paginated) |
| GET | `/patients/search` | Staff | Search by name |
| GET | `/patients/:id` | Staff | Get patient details |
| GET | `/patients/:id/overview` | Staff | Patient overview (appointments + prescriptions) |
| POST | `/patients` | Admin | Create patient |
| PATCH | `/patients/:id` | Staff | Update patient |
| DELETE | `/patients/:id` | Admin | Delete patient |

---

### Appointment Routes — `/api/appointments`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/appointments` | Staff | List appointments (paginated, filterable) |
| GET | `/appointments/search` | Staff | Search appointments |
| GET | `/appointments/:id` | Staff | Get appointment |
| POST | `/appointments` | Admin | Create appointment |
| PATCH | `/appointments/:id` | Staff | Update appointment |
| DELETE | `/appointments/:id` | Admin | Delete appointment |

---

### Prescription Routes — `/api/prescriptions`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/prescriptions` | Staff | List prescriptions |
| GET | `/prescriptions/search` | Staff | Search prescriptions |
| GET | `/prescriptions/:id` | Staff | Get prescription |
| POST | `/prescriptions` | Staff | Create prescription |
| PATCH | `/prescriptions/:id` | Staff | Update prescription |
| DELETE | `/prescriptions/:id` | Staff | Delete prescription |

---

### Medicine Routes — `/api/medicines`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/medicines` | Public | List all medicines (paginated) |
| GET | `/medicines/search?q=<prefix>` | Public | **Prefix search on medicineName only** |
| GET | `/medicines/:id` | Public | Get medicine by ID |
| POST | `/medicines` | Protected | Create medicine |
| PATCH | `/medicines/:id` | Protected | Update medicine |
| DELETE | `/medicines/:id` | Protected | Delete medicine |

**Search example:**
```
GET /api/medicines/search?q=Para&limit=10
```
Returns medicines whose `medicineName` **starts with** "Para" (case-insensitive), e.g. Paracetamol, Paracip.

---

### WhatsApp Routes — `/api/whatsapp`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/whatsapp/webhook` | Public | Meta webhook verification |
| POST | `/whatsapp/webhook` | Public | Receive incoming WhatsApp messages |
| GET | `/whatsapp/config` | Protected | Get hospital WA config |
| PUT | `/whatsapp/config` | Protected | Update hospital WA config |
| POST | `/whatsapp` | Protected | Create WA configuration |
| POST | `/whatsapp/callback` | Public | Meta OAuth callback |

---

### Queue Routes — `/api/queue`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/queue/status` | Public | Queue health status |
| POST | `/queue/webhook` | Public | LiveKit webhook receiver |

---

### LiveKit Routes — `/api/livekit`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/livekit/token` | Protected | Generate LiveKit room token |
| POST | `/livekit/token` | Protected | Generate token (POST body) |

---

### Payment Routes — `/api/payments`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/payments` | Protected | List payments for hospital |
| GET | `/payments/search` | Protected | Search payments |

---

### Dashboard Route — `/api/dashboard`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/dashboard` | Protected | Hospital summary statistics |

---

### Health Check

```
GET /api/health  →  { "success": true, "app": "samvaad", "timestamp": "..." }
```

---

## 8. Authentication & Authorization

### Login Flow

```
1. Client sends POST /api/auth/login with email + password
2. Server verifies bcrypt hash
3. Server issues:
   - accessToken  (JWT, 15 min, in response body)
   - refreshToken (JWT, 7 days, in response body + HttpOnly cookie)
4. Client stores accessToken in memory, refreshToken in cookie
5. Every request: Authorization: Bearer <accessToken>
6. On 401: client calls POST /api/auth/refresh → new accessToken
7. Logout: POST /api/auth/logout → refreshToken invalidated in DB
```

### Role Hierarchy (lowest to highest)

```
user < doctor < tele_caller < moderator < hospital_admin < admin < super_admin
```

### Permission Map

| Role | Capability |
|------|-----------|
| `super_admin` | All operations, cross-hospital |
| `admin` | Hospital CRUD, all data within hospital |
| `hospital_admin` | Hospital data management (own hospital) |
| `moderator` | Read/write most data, no delete |
| `doctor` | Own hospital data, prescriptions |
| `tele_caller` | Patient list, limited actions |
| `user` | Minimal access |

### Token Management

- **Access tokens**: Short-lived (15 min), signed with `JWT_ACCESS_SECRET`
- **Refresh tokens**: 7-day, stored in `refreshtokens` collection with TTL index
- **Rotation**: Each refresh call issues a new access token; refresh token persists until logout
- **Logout-all**: Deletes all refresh tokens for the user

### Security Measures

- Passwords hashed with bcryptjs
- Rate limiting via `express-rate-limit`
- ObjectId validation on all `:id` params
- CORS restricted to allowed origins
- Razorpay webhooks verified with HMAC-SHA256
- WhatsApp webhooks verified with verify token
- Google OAuth state signed with HMAC

---

## 9. Third-Party Integrations

### 1. LiveKit

| | |
|-|-|
| **Purpose** | WebRTC/SIP infrastructure for voice agent and phone queue |
| **SDK** | `@livekit/agents` v1.2.x, `livekit-server-sdk` v2.15.x |
| **Credentials** | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| **Setup** | Create a LiveKit Cloud account → create a project → configure SIP trunk → point Exotel to LiveKit SIP URI |
| **Failure handling** | `webSocketErrorGuard.js` patches uncaught WebSocket errors; PM2 `autorestart: true` restarts crashed workers |

### 2. OpenAI

| | |
|-|-|
| **Purpose** | Realtime voice conversation (gpt-realtime-mini) + post-call extraction (GPT-4.1) |
| **SDK** | `openai` ^6.21.0, `@livekit/agents-plugin-openai` |
| **Credentials** | `OPENAI_API_KEY` |
| **Setup** | Create OpenAI platform account → generate API key → set in `.env` |
| **Failure handling** | Tool errors return descriptive messages; post-call pipeline has try/catch |

### 3. Sarvam AI

| | |
|-|-|
| **Purpose** | Hindi + English speech-to-text and text-to-speech |
| **SDK** | `sarvamai` ^1.1.7 |
| **Credentials** | `SARVAM_API_KEY` |
| **Setup** | Register at sarvam.ai → get API key → set in `.env` |
| **Key setting** | `SARVAM_STT_STREAMING=0` (batch REST mode) — streaming WebSocket rejected `saaras:v3` model |
| **Failure handling** | Falls back to OpenAI STT if `SARVAM_API_KEY` not set |

### 4. Meta WhatsApp Cloud API

| | |
|-|-|
| **Purpose** | Appointment confirmations, prescription links, medicine reminders |
| **Credentials** | `WHATSAPP_CLOUD_ACCESS_TOKEN`, `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| **Setup** | Meta Business Suite → Create WhatsApp Business App → Get permanent token → Configure webhook at `/api/whatsapp/webhook` with verify token → Submit message templates for approval |
| **Template format** | Set `APPOINTMENT_TEMPLATE_PARAM_FORMAT=named` or `positional` to match how the template was created in Meta |
| **Failure handling** | BullMQ retries (5 attempts, exponential backoff); `graphSendMessages()` surfaces `error.error_data.details` |

### 5. Razorpay

| | |
|-|-|
| **Purpose** | Online payment collection from patients |
| **SDK** | `razorpay` ^2.9.6 |
| **Credentials** | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| **Setup** | Razorpay Dashboard → Account → API Keys → generate; Webhooks → add endpoint `/api/razorpay/webhook` → copy signing secret |
| **Failure handling** | Webhook HMAC verified; payments logged with status `pending` until `captured` |

### 6. Google Calendar

| | |
|-|-|
| **Purpose** | Create Google Meet video appointments; sync to doctor calendars |
| **Credentials** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| **Setup** | GCP Console → Enable Calendar API → Create OAuth 2.0 credentials → Set redirect URI → Admin authorizes via `/api/public/google-auth` → Token stored in `googleoauthtokens` |
| **Failure handling** | Token refresh handled automatically by `googleapis` |

### 7. Exotel

| | |
|-|-|
| **Purpose** | SIP telephony (inbound calls to voice agent) + call analytics |
| **Credentials** | `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN` |
| **Setup** | Exotel account → ExoPhone → configure to route to LiveKit SIP URI → API credentials in `.env` |
| **Sync** | Monthly cron syncs call records via `POST /api/exotel-calls/sync/current-month` |

### 8. Mailtrap

| | |
|-|-|
| **Purpose** | Transactional email: password reset, welcome emails |
| **Credentials** | `MAILTRAP_API_KEY`, `MAIL_FROM` |
| **Setup** | Mailtrap account → Sending → Domains → verify domain → API tokens → copy to `MAILTRAP_API_KEY` |

---

## 10. Deployment Guide

### Development Environment Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd samvaad-server

# 2. Install dependencies
npm install

# 3. Create environment file
cp .env.example .env
# Edit .env with your credentials

# 4. Start MongoDB locally (or use Atlas URI in .env)
# MongoDB must be running before starting the server

# 5. Start Redis locally
redis-server

# 6. Start API server (all workers embedded)
npm run dev

# 7. Start LiveKit voice agent (separate terminal)
npm run livekit:dev

# 8. Start phone queue worker (separate terminal, if needed)
npm run queue:dev

# 9. API only (no workers)
npm run dev:api-only
```

### Production Deployment on VPS (DigitalOcean Droplet)

```bash
# 1. SSH into the droplet
ssh root@<droplet-ip>

# 2. Pull latest code
cd /path/to/samvaad-server
git pull origin main

# 3. Install/update dependencies
npm ci

# 4. Ensure .env is configured (production values)
nano .env

# 5. Start all PM2 processes
npm run pm2:prod
# or
pm2 start ecosystem.config.cjs

# 6. Save PM2 process list (survives reboots)
pm2 save
pm2 startup  # follow the printed command

# 7. Verify all processes are running
pm2 status
pm2 logs
```

### PM2 Process Management

```bash
# View all processes
pm2 status

# View logs
pm2 logs samvaad-api
pm2 logs samvaad-livekit-worker
pm2 logs samvaad-queue-worker
pm2 logs samvaad-reminder-worker

# Restart a specific process
pm2 restart samvaad-api
pm2 restart samvaad-reminder-worker

# Restart all
pm2 restart all

# Update env and restart (CRITICAL — dotenv does not override PM2 env)
pm2 delete samvaad-api
pm2 start ecosystem.config.cjs --only samvaad-api

# Stop all
pm2 stop all
```

### Rollback Procedure

```bash
# 1. Identify the last working commit
git log --oneline -10

# 2. Checkout previous commit
git checkout <commit-hash>

# 3. Reinstall dependencies (if package.json changed)
npm ci

# 4. Restart PM2 processes
pm2 restart all
```

---

## 11. Infrastructure Documentation

### PM2 Processes

| Process Name | Script | Port | Purpose |
|-------------|--------|------|---------|
| `samvaad-api` | `index.js` | 3000 | REST API server |
| `samvaad-livekit-worker` | `livekit-agent/main.js` | 8081 | Voice booking agent |
| `samvaad-queue-worker` | `livekit-agent/phoneQueueWorker.js` | 8082 | Phone hold queue |
| `samvaad-reminder-worker` | `src/workers/reminderWorkerEntry.js` | — | Medicine reminders |

**Worker isolation in production:**
- `samvaad-api` sets `LIVEKIT_WORKER_DISABLED=1`, `QUEUE_WORKER_DISABLED=1`, `REMINDER_WORKER_DISABLED=1`
- Each worker runs as an independent PM2 process (not embedded in the API)

### Reverse Proxy
Not Found in Codebase — Nginx or Caddy is expected upstream to:
- Terminate SSL (HTTPS → HTTP to port 3000)
- Set `X-Forwarded-For` headers

### Cloudflare Tunnel (Development)

```bash
# Start tunnel (maps local port to a public URL)
npm run tunnel
```

Requires `cloudflared` installed and `CLOUDFLARE_DOMAIN` in `.env`.

### File Storage

Static file uploads (hospital logos, profile pictures) stored at `./uploads/` (configurable via `UPLOADS_ROOT`). Served via Express static at `/uploads/*`.

---

## 12. Monitoring & Logging

### Log Locations

```bash
# PM2 log files (on VPS)
pm2 logs              # tail all logs
pm2 logs samvaad-api  # tail API logs
~/.pm2/logs/samvaad-api-out.log   # stdout
~/.pm2/logs/samvaad-api-error.log # stderr
```

### Log Levels

Controlled by `LOG_LEVEL` environment variable:
- **Production:** `LOG_LEVEL=warn` (set in `ecosystem.config.cjs` for all voice workers)
- **Development:** default info/debug (all logs visible)

The verbose agent startup banner is gated by `AGENT_VERBOSE_CONNECTION_LOGS`:
- Auto-enabled in `NODE_ENV !== production`
- Explicitly set with `AGENT_VERBOSE_CONNECTION_LOGS=1`

### Monitoring Tools
Not Found in Codebase — no external APM (Datadog, New Relic, etc.) is configured. PM2's built-in monitoring can be viewed with:

```bash
pm2 monit     # Real-time CPU/memory dashboard
pm2 status    # Process status table
```

### Error Tracking
Not Found in Codebase — no Sentry or similar integration. All errors are logged to PM2 log files.

---

## 13. Testing

### Unit Tests
Not Found in Codebase — `npm test` script prints "Error: no test specified".

### Integration Tests
Not Found in Codebase.

### Manual Testing Procedures

#### Test API Health
```bash
curl https://<your-domain>/api/health
# Expected: { "success": true, "app": "samvaad" }
```

#### Test Voice Agent
1. Call the configured Exotel number
2. Agent should answer in English/Hindi
3. Say "I want to book an appointment"
4. Agent should ask for doctor preference and time
5. Confirm appointment; check WhatsApp for confirmation

#### Test Medicine Reminders (Test Mode)
```bash
# In .env:
REMINDER_TEST_MODE=1  # Fast: breakfast at +2min, lunch at +25min, dinner at +48min

pm2 restart samvaad-reminder-worker
pm2 logs samvaad-reminder-worker
```

#### Test Medicine Import (Dry Run)
```bash
node scripts/import-medicines/import-medicines.js \
  --file=/path/to/medicines.xlsx \
  --dry-run
```

---

## 14. Known Issues

| Issue | Severity | Notes |
|-------|----------|-------|
| No automated test suite | High | No unit or integration tests exist |
| PM2 env override issue | Medium | `dotenv` does not override PM2 env; must use `pm2 delete + pm2 start --update-env` to change env vars |
| Sarvam STT streaming | Medium | `saaras:v3` model rejected by streaming WebSocket endpoint; must keep `SARVAM_STT_STREAMING=0` |
| WhatsApp template format | Medium | `APPOINTMENT_TEMPLATE_PARAM_FORMAT` must match exactly how template was created in Meta or `(#100) Invalid parameter` error occurs |
| No reverse proxy config | Low | SSL termination assumed but not documented in repo |
| No CI/CD pipeline | Low | Manual deploy via `git pull + pm2 restart` |
| No error tracking service | Low | Errors only in PM2 logs |
| Medicine model `unit` field was `required: true` | Resolved | Changed to `required: false` to allow medicines without explicit units |

---

## 15. Backup & Recovery

### Database Backup

```bash
# MongoDB Atlas: enable automated backups in Atlas UI (recommended)

# Self-hosted MongoDB — manual backup:
mongodump --uri="<MONGODB_URI>" --out=/backup/$(date +%Y-%m-%d)

# Compress backup
tar -czf /backup/samvaad-$(date +%Y-%m-%d).tar.gz /backup/$(date +%Y-%m-%d)
```

### Restore Process

```bash
# Restore from dump
mongorestore --uri="<MONGODB_URI>" /backup/2026-06-23/

# Or restore specific collection
mongorestore --uri="<MONGODB_URI>" \
  --db samvaad \
  --collection appointments \
  /backup/2026-06-23/samvaad/appointments.bson
```

### Redis Backup

Redis data is ephemeral job queue state. On restart, pending BullMQ jobs are re-queued from existing data. No formal backup required unless durable job history is needed.

### Disaster Recovery Steps

```bash
# 1. Provision new VPS
# 2. Install Node.js (≥18), npm, PM2, Redis
npm install -g pm2

# 3. Clone repository
git clone <repo-url> /opt/samvaad-server
cd /opt/samvaad-server

# 4. Restore .env
# (store .env securely — not in git)

# 5. Install dependencies
npm ci

# 6. Start processes
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup

# 7. Restore MongoDB from backup
mongorestore --uri="$MONGODB_URI" /backup/latest/
```

---

## 16. Security Considerations

### Sensitive Areas

| Area | Risk | Mitigation |
|------|------|-----------|
| `.env` file | Contains all secrets | Never commit to git; store encrypted externally |
| JWT secrets | Weak defaults in dev | **Change both secrets in production** |
| WhatsApp access token | Permanent Meta token | Rotate if compromised; store only in `.env` |
| OpenAI API key | Billing risk | Monitor usage; set spend limits in OpenAI dashboard |
| Razorpay keys | Financial risk | Use test keys in dev; never commit live keys |
| MongoDB URI | Full DB access | Use Atlas IP allowlist; dedicated DB user |
| Patient data | HIPAA/healthcare sensitivity | Restrict DB access; encrypt at rest if required |

### Access Control

- Role hierarchy enforced on every protected route via `requireAdmin`, `requireStaff`, etc.
- Hospital-scoped roles (`doctor`, `hospital_admin`, `tele_caller`) can only access their own hospital's data
- Refresh tokens stored in DB — revocable at any time

### Recommended Security Improvements

1. **Add a test suite** with coverage for auth and appointment endpoints
2. **Configure Nginx with SSL** — currently assumed but not in repo
3. **Add Sentry** or similar for real-time error tracking
4. **Enable MongoDB Atlas IP allowlist** — restrict to VPS IP only
5. **Set up secret rotation** for JWT secrets and API keys (quarterly)
6. **Add audit logging** — track who created/modified appointments
7. **Rate limit per hospital** — current rate limiting is global

---

## 17. Operational Runbook

### Restart All Services After Code Deploy

```bash
git pull origin main
npm ci
pm2 restart all
pm2 status  # verify all are online
```

### Update Environment Variables

```bash
# Edit .env on the server
nano .env

# CRITICAL: Must delete + re-start (not just restart)
# because PM2 ecosystem env overrides .env values
pm2 delete samvaad-api
pm2 start ecosystem.config.cjs --only samvaad-api
# Repeat for other processes if their env changed
```

### View Real-Time Logs

```bash
pm2 logs                          # all processes
pm2 logs samvaad-livekit-worker   # voice agent only
pm2 logs --lines 200 samvaad-api  # last 200 lines
```

### Medicine Reminder — Force Test

```bash
# 1. Add REMINDER_TEST_MODE=1 to .env
# 2. Restart reminder worker
pm2 restart samvaad-reminder-worker
pm2 logs samvaad-reminder-worker
# Should see reminders firing within minutes
# 3. Remove REMINDER_TEST_MODE when done
```

### Resolve Exotel Port Conflict (EADDRINUSE 8081)

Both voice workers default to LiveKit health port 8081. The queue worker must use 8082:

```bash
# Verify QUEUE_WORKER_HTTP_PORT is not set to 8081
# In ecosystem.config.cjs, queue worker should have no port override
# (defaults to 8082 via parseEnvInt('QUEUE_WORKER_HTTP_PORT', 8082))
pm2 restart samvaad-queue-worker
```

### Bulk Import Medicines

```bash
# Dry run first
node scripts/import-medicines/import-medicines.js \
  --file=/path/to/medicines.xlsx \
  --dry-run

# Full import
node scripts/import-medicines/import-medicines.js \
  --file=/path/to/medicines.xlsx \
  --batch=1000

# Drop existing and re-import (if needed)
node -e "
require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  await mongoose.connection.collection('medicines').drop();
  console.log('Dropped');
  await mongoose.disconnect();
});
"
node scripts/import-medicines/import-medicines.js --file=/path/to/medicines.xlsx
```

### Rotate JWT Secrets

```bash
# 1. Generate new secrets
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 2. Update .env
# JWT_ACCESS_SECRET=<new-secret>
# JWT_REFRESH_SECRET=<new-secret>

# 3. This logs out ALL users (refresh tokens still exist but new tokens can't be verified)
# Consider a maintenance window or communicate to users

# 4. Restart API
pm2 delete samvaad-api
pm2 start ecosystem.config.cjs --only samvaad-api
```

### Trigger Exotel Sync Manually

```bash
curl -X POST https://<your-domain>/api/exotel-calls/sync/current-month \
  -H "Authorization: Bearer <superAdminToken>"
```

### Check Queue Status

```bash
curl https://<your-domain>/api/queue/status
```

---

## 18. Future Enhancements

| Priority | Enhancement | Notes |
|----------|------------|-------|
| High | Automated test suite | Unit + integration tests; currently zero coverage |
| High | CI/CD pipeline | GitHub Actions: test → lint → deploy on merge to main |
| High | Error tracking | Integrate Sentry for real-time alerting |
| Medium | Multi-language voice agent | Extend beyond Hindi/English (Tamil, Telugu, Kannada) |
| Medium | SMS fallback | When WhatsApp delivery fails, fall back to SMS (Twilio/Exotel SMS) |
| Medium | Doctor app | Separate mobile/web app for doctors to manage schedules |
| Medium | Patient portal | Self-service portal for patients to view prescriptions, appointments |
| Medium | HIPAA/healthcare compliance | Encryption at rest, audit logs, access reviews |
| Low | Docker containerization | Dockerfile + docker-compose for reproducible deployments |
| Low | Horizontal scaling | Redis-backed session store + PM2 cluster mode |
| Low | Analytics dashboard | Call volume, booking conversion rate, reminder delivery rate |
| Low | Calendar sync for patients | Send appointment to patient's Google/Apple Calendar |

---

## 19. Appendix

### Glossary

| Term | Meaning |
|------|---------|
| STT | Speech-to-Text — converts caller audio to text |
| TTS | Text-to-Speech — converts agent response to audio |
| VAD | Voice Activity Detection — detects when caller is speaking |
| SIP | Session Initiation Protocol — telephony protocol used by Exotel + LiveKit |
| BullMQ | Redis-backed job queue library for Node.js |
| IST | Indian Standard Time (Asia/Kolkata, UTC+5:30) |
| WABA | WhatsApp Business Account |
| OPD | Out-Patient Department (appointment type) |
| PM2 | Production Process Manager for Node.js |
| LiveKit | Open-source WebRTC infrastructure for real-time audio/video |

### Useful Commands

```bash
# Check Node version
node --version  # should be ≥18

# Check PM2 version
pm2 --version

# List all PM2 processes
pm2 list

# Monitor CPU/memory
pm2 monit

# Generate PM2 startup script
pm2 startup

# Save current PM2 process list
pm2 save

# Reload without downtime (API only — voice workers need full restart)
pm2 reload samvaad-api

# Check MongoDB connection
node -e "require('dotenv').config(); const mongoose = require('mongoose'); \
mongoose.connect(process.env.MONGODB_URI).then(() => { \
  console.log('Connected'); mongoose.disconnect(); })"

# Check Redis connection
redis-cli ping  # should return PONG

# View BullMQ job counts (if bull-board not installed)
node -e "
const { Queue } = require('bullmq');
const q = new Queue('medicine-reminders', { connection: { host: '127.0.0.1', port: 6379 }});
q.getJobCounts().then(c => { console.log(c); q.close(); });
"
```

### External References

| Resource | URL |
|----------|-----|
| LiveKit Agents SDK Docs | https://docs.livekit.io/agents/ |
| OpenAI Realtime API | https://platform.openai.com/docs/guides/realtime |
| Sarvam AI Docs | https://docs.sarvam.ai |
| Meta WhatsApp Cloud API | https://developers.facebook.com/docs/whatsapp/cloud-api |
| Razorpay API Docs | https://razorpay.com/docs/api |
| BullMQ Docs | https://docs.bullmq.io |
| Mongoose Docs | https://mongoosejs.com/docs |
| PM2 Docs | https://pm2.keymetrics.io/docs |

### Contact Information

Not Found in Codebase — contact details to be provided by the project owner.

---

*End of Document*

**Version 1.0.0 | Samvaad AI | Confidential**
