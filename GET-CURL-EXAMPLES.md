# All GET endpoints – cURL examples

Use your access token: `-H "Authorization: Bearer YOUR_ACCESS_TOKEN"`  
Base URL: `http://localhost:3000` (replace with your API base if different).

---

## Public

```bash
# Health check
curl -X GET "http://localhost:3000/api/health"
```

---

## Auth (protected)

```bash
# Current user + linked hospital
curl -X GET "http://localhost:3000/api/auth/me" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Admin (admin, hospital_admin)

```bash
# List users (hospital_admin: only their hospital’s users)
curl -X GET "http://localhost:3000/api/admin/users" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Hospitals (admin, hospital_admin)

```bash
# List hospitals (paginated)
curl -X GET "http://localhost:3000/api/hospitals?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Search hospitals – match any of: name, address, city, pincode, phoneNumber, email, contactPerson, registrationNumber
curl -X GET "http://localhost:3000/api/hospitals/search?q=mumbai&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Get hospital by ID
curl -X GET "http://localhost:3000/api/hospitals/HOSPITAL_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Doctors (doctor, hospital_admin, admin)

```bash
# List doctors (paginated)
curl -X GET "http://localhost:3000/api/doctors?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Search doctors – match any of: fullName, doctorId, phoneNumber, email, designation, availability, status (use q or name)
curl -X GET "http://localhost:3000/api/doctors/search?q=cardio&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

curl -X GET "http://localhost:3000/api/doctors/search?name=John&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Get doctor by ID
curl -X GET "http://localhost:3000/api/doctors/DOCTOR_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Patients (doctor, hospital_admin, admin)

Response includes **overall**: `{ totalPatients, totalAppointments }` (hospital-scoped totals).  
**counts**: `{ all, today, tomorrow }` (today/tomorrow = patients with an appointment on that day).  
Optional **filter**: `all` (default) | `today` | `tomorrow`.  
Optional **date range**: `fromDate`, `toDate` (ISO date, e.g. `YYYY-MM-DD`) – patients with an appointment in that range.

```bash
# List all patients (with counts: all, today, tomorrow)
curl -X GET "http://localhost:3000/api/patients?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List – filter: patients who have an appointment today
curl -X GET "http://localhost:3000/api/patients?filter=today&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List – filter: patients who have an appointment tomorrow
curl -X GET "http://localhost:3000/api/patients?filter=tomorrow&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List – date range (patients with appointment between fromDate and toDate, e.g. last 30 days)
curl -X GET "http://localhost:3000/api/patients?fromDate=2025-11-01&toDate=2025-11-30&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Search patients – match any of: fullName, patientId, phoneNumber, reason, gender (use q or name)
curl -X GET "http://localhost:3000/api/patients/search?q=john&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

curl -X GET "http://localhost:3000/api/patients/search?name=Jane&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Get patient by ID
curl -X GET "http://localhost:3000/api/patients/PATIENT_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Appointments (doctor, hospital_admin, admin)

Response includes **overall**: `{ totalAppointments, totalPatients }` (hospital-scoped totals).  
**counts**: `{ all, today, tomorrow }`.  
Optional **filter**: `all` (default) | `today` | `tomorrow`.  
Optional **date range**: `fromDate`, `toDate` (ISO date, e.g. `YYYY-MM-DD`).

```bash
# List all appointments (with counts: all, today, tomorrow)
curl -X GET "http://localhost:3000/api/appointments?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List – filter: today only
curl -X GET "http://localhost:3000/api/appointments?filter=today&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List – filter: tomorrow only
curl -X GET "http://localhost:3000/api/appointments?filter=tomorrow&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List – date range (e.g. 1 Nov – 30 Nov, or last 30 days)
curl -X GET "http://localhost:3000/api/appointments?fromDate=2025-11-01&toDate=2025-11-30&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# List – optional doctorId, patientId, status
curl -X GET "http://localhost:3000/api/appointments?doctorId=DOCTOR_ID&patientId=PATIENT_ID&status=Upcoming&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Search appointments – match any of: appointmentId, reason, status, type, or patient/doctor name or id
curl -X GET "http://localhost:3000/api/appointments/search?q=Upcoming&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Get appointment by ID
curl -X GET "http://localhost:3000/api/appointments/APPOINTMENT_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Quick reference

| Method | Endpoint | Query / notes |
|--------|----------|----------------|
| GET | `/api/health` | Public |
| GET | `/api/auth/me` | Auth |
| GET | `/api/admin/users` | Admin |
| GET | `/api/hospitals` | `page`, `limit` |
| GET | `/api/hospitals/search` | `q`, `page`, `limit` |
| GET | `/api/hospitals/:id` | — |
| GET | `/api/doctors` | `page`, `limit` |
| GET | `/api/doctors/search` | `q` or `name`, `page`, `limit` |
| GET | `/api/doctors/:id` | — |
| GET | `/api/patients` | `filter`, `fromDate`, `toDate`, `page`, `limit`; response has `counts` |
| GET | `/api/patients/search` | `q` or `name`, `page`, `limit` |
| GET | `/api/patients/:id` | — |
| GET | `/api/appointments` | `filter`, `fromDate`, `toDate`, `doctorId`, `patientId`, `status`, `page`, `limit`; response has `counts` |
| GET | `/api/appointments/search` | `q`, `page`, `limit` |
| GET | `/api/appointments/:id` | — |
