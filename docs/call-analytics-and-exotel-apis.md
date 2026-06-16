# Call Analytics and Exotel APIs

This document covers all newly created APIs for:

- Exotel call sync and CRUD storage
- Super Admin call analytics (hospital-wise and hospital detail)
- Admin/Hospital Admin own-hospital call analytics

## Base URL

- Local: `http://localhost:3000`

---

## Authentication and Roles

All endpoints require:

- `Authorization: Bearer <JWT_TOKEN>`

Role access:

- `/api/exotel-calls/*` -> `admin` and `super_admin`
- `/api/super-admin/call-analytics*` -> `super_admin` only
- `/api/admin/call-analytics` -> `admin`, `hospital_admin` (via `requireAdmin` middleware chain)

---

## Exotel Data Storage Notes

When Exotel calls are stored:

- Full payload is stored in `raw`
- `creditUsed` is calculated as:
  - `creditUsed = Math.ceil(duration / 60)`
  - Examples:
    - `45s -> 1`
    - `60s -> 1`
    - `61s -> 2`
    - `121s -> 3`

---

## 1) Exotel Sync APIs

### 1.1 Sync current month

`POST /api/exotel-calls/sync/current-month`

```bash
curl --location --request POST 'http://localhost:3000/api/exotel-calls/sync/current-month' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_SUPER_ADMIN>'
```

### 1.2 Sync specific month

`POST /api/exotel-calls/sync/month`

Body:

- `year` (required, 2000-2100)
- `month` (required, 1-12)
- `pageSize` (optional, 1-100)

```bash
curl --location --request POST 'http://localhost:3000/api/exotel-calls/sync/month' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_SUPER_ADMIN>' \
--header 'Content-Type: application/json' \
--data '{
  "year": 2026,
  "month": 6,
  "pageSize": 100
}'
```

### 1.3 Monthly summary

`GET /api/exotel-calls/summary?year=2026&month=6`

```bash
curl --location 'http://localhost:3000/api/exotel-calls/summary?year=2026&month=6' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_SUPER_ADMIN>'
```

---

## 2) Exotel CRUD APIs

### 2.1 Create one call record

`POST /api/exotel-calls`

```bash
curl --location --request POST 'http://localhost:3000/api/exotel-calls' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_SUPER_ADMIN>' \
--header 'Content-Type: application/json' \
--data '{
  "sid": "sample_sid_123",
  "accountSid": "samvaadai1m",
  "phoneNumber": "02245079032",
  "status": "completed",
  "direction": "inbound",
  "duration": 75,
  "raw": {
    "Sid": "sample_sid_123",
    "Duration": 75
  }
}'
```

### 2.2 List calls (paginated + filters)

`GET /api/exotel-calls?page=1&limit=20&syncMonth=2026-06&status=completed&direction=inbound&from=08383801256`

```bash
curl --location 'http://localhost:3000/api/exotel-calls?page=1&limit=20&syncMonth=2026-06&status=completed' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_SUPER_ADMIN>'
```

### 2.3 Get one call by Mongo id or `sid`

`GET /api/exotel-calls/:id`

```bash
curl --location 'http://localhost:3000/api/exotel-calls/sample_sid_123' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_SUPER_ADMIN>'
```

### 2.4 Update one call by Mongo id or `sid`

`PATCH /api/exotel-calls/:id`

```bash
curl --location --request PATCH 'http://localhost:3000/api/exotel-calls/sample_sid_123' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_SUPER_ADMIN>' \
--header 'Content-Type: application/json' \
--data '{
  "duration": 121,
  "status": "completed"
}'
```

### 2.5 Delete one call by Mongo id or `sid`

`DELETE /api/exotel-calls/:id`

```bash
curl --location --request DELETE 'http://localhost:3000/api/exotel-calls/sample_sid_123' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_SUPER_ADMIN>'
```

---

## 3) Super Admin Call Analytics APIs

### 3.1 Hospital-wise analytics

`GET /api/super-admin/call-analytics`

Optional query params:

- `year` + `month` (recommended for monthly view, e.g. `year=2026&month=6`)
- `startDate` (ISO date, e.g. `2026-06-01`)
- `endDate` (ISO date, e.g. `2026-06-30`)
- `hospitalId` (Mongo id)

If no dates or month are sent, the API defaults to the **current calendar month** (server TZ).

```bash
curl --location 'http://localhost:3000/api/super-admin/call-analytics?year=2026&month=6' \
--header 'Authorization: Bearer <JWT_SUPER_ADMIN>'
```

Sample response shape:

```json
{
  "success": true,
  "data": [
    {
      "hospitalId": "665f1f2b11aa22bb33cc44dd",
      "hospitalName": "ABC Hospital",
      "voiceAgentNumber": "+919999999999",
      "totalCalls": 120,
      "totalDuration": 4500,
      "totalCreditsUsed": 98,
      "answeredCalls": 90,
      "missedCalls": 30,
      "averageCallDuration": 37.5
    }
  ]
}
```

### 3.2 Single hospital analytics detail

`GET /api/super-admin/call-analytics/:hospitalId`

Supports:

- `year` + `month` (monthly view)
- `page`
- `limit`
- `startDate`
- `endDate`

```bash
curl --location 'http://localhost:3000/api/super-admin/call-analytics/<HOSPITAL_ID>?year=2026&month=6&page=1&limit=20' \
--header 'Authorization: Bearer <JWT_SUPER_ADMIN>'
```

---

## 4) Admin/Hospital Admin Call Analytics API

### 4.1 Own hospital analytics

`GET /api/admin/call-analytics`

Supports:

- `year` + `month` (defaults to current month if omitted)
- `page`
- `limit`
- `startDate`
- `endDate`

Call data is refreshed automatically every **24 hours** on the server (daily Exotel sync cron). The response includes `meta.exotelSync` with last sync time.

```bash
curl --location 'http://localhost:3000/api/admin/call-analytics?year=2026&month=6&page=1&limit=20' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_HOSPITAL_ADMIN>'
```

### 4.2 Exotel sync status (admin)

`GET /api/admin/exotel-sync-status`

```bash
curl --location 'http://localhost:3000/api/admin/exotel-sync-status' \
--header 'Authorization: Bearer <JWT_ADMIN_OR_HOSPITAL_ADMIN>'
```

Sample response shape:

```json
{
  "success": true,
  "data": {
    "hospitalId": "665f1f2b11aa22bb33cc44dd",
    "hospitalName": "ABC Hospital",
    "voiceAgentNumber": "+919999999999",
    "totals": {
      "totalCalls": 120,
      "totalDuration": 4500,
      "totalCreditsUsed": 98,
      "answeredCalls": 90,
      "missedCalls": 30,
      "averageCallDuration": 37.5
    },
    "calls": [],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 120,
      "totalPages": 6
    }
  }
}
```

---

## Environment Variables Required for Exotel Sync

Set in backend `.env`:

```env
EXOTEL_REGION=in
EXOTEL_ACCOUNT_SID=samvaadai1m
EXOTEL_API_KEY=your_exotel_api_key
EXOTEL_API_TOKEN=your_exotel_api_token
```

Optional:

```env
EXOTEL_MONTHLY_SYNC_CRON_DISABLED=1
EXOTEL_DAILY_SYNC_CRON_DISABLED=1
# Optional override (default: 0 2 * * * = every day at 02:00 server TZ)
EXOTEL_DAILY_SYNC_CRON_SCHEDULE=0 2 * * *
```

---

## Automatic Exotel sync (server cron)

| Cron | Schedule | Purpose |
|------|----------|---------|
| **Daily** | `0 2 * * *` (02:00, `TZ`/Asia/Kolkata) | Keeps **current month** call data fresh for **admin / hospital_admin** dashboards |
| **Monthly** | `10 0 1 * *` (1st of month, 00:10) | Full **monthly** reconciliation for **super_admin** reporting |

Disable with `EXOTEL_DAILY_SYNC_CRON_DISABLED=1` or `EXOTEL_MONTHLY_SYNC_CRON_DISABLED=1`.

Admin last sync info: `GET /api/admin/exotel-sync-status`

---

## Error Handling Notes

Common cases:

- `401` -> Missing/invalid/expired token
- `403` -> Role not allowed for endpoint
- `404` -> Hospital or call not found
- `400` -> Validation error in query/body

