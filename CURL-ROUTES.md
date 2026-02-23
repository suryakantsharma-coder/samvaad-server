# Samvaad API – cURL for all routes

Base URL: `http://localhost:3000` (override with `BASE` in your shell, e.g. `BASE=https://api.example.com`)

---

## User Roles (RBAC)

All roles used in the system (exact strings):

| Role             | String value    |
|------------------|-----------------|
| User             | `user`          |
| Doctor           | `doctor`        |
| Moderator        | `moderator`     |
| Hospital Admin   | `hospital_admin`|
| Admin            | `admin`         |

**Per-role behavior:**

- **user**
  - Can login and register (role defaults to `user` if omitted).
  - No hospital linked.
  - No access to admin, hospitals, doctors, patients, or appointments; only protected auth routes (e.g. `/auth/me`, `/auth/logout-all`).

- **doctor**
  - Can login and register only with a valid `hospitalId` (required at signup).
  - Has hospital linked (`user.hospital` set).
  - Access: **Doctors (read-only):** GET /api/doctors, GET /api/doctors/search, GET /api/doctors/:id (hospital-scoped). **Patients:** list/get/update (hospital-scoped); cannot create/delete. **Appointments:** list/get/update (hospital-scoped); cannot create/delete. No access to hospitals CRUD or admin users.

- **moderator**
  - Cannot self-register (403); must be created by an admin.
  - Must not have hospital linked (schema enforces null for admin/moderator).
  - **Not used by any route currently.** Role exists for future use; `requireModerator` middleware is available for moderator-level routes.

- **hospital_admin**
  - Can login and register only with a valid `hospitalId` (required at signup).
  - Has hospital linked.
  - Access: admin routes (list users scoped to their hospital). **Hospitals:** GET list (own only), GET by ID (own only), PATCH (own only). **Cannot create or delete hospitals** (admin only). Doctors/patients/appointments: full CRUD **scoped to their hospital**.

- **admin**
  - Cannot self-register (403); must be created by another admin.
  - Must not have hospital linked (schema enforces null for admin/moderator).
  - Access: all routes; only role that can **create** (POST) and **delete** (DELETE) hospitals. List all users, all hospitals; doctors/patients/appointments not filtered by hospital (sees all).

**Hospital roles (defined at sign-up):**  
The roles **doctor** and **hospital_admin** are *hospital roles*: they are linked to a single hospital at sign-up via `hospitalId`. That link defines their data scope: they **only ever see data from their linked hospital** (doctors, patients, appointments; hospital_admin also sees their one hospital and users in that hospital). They never see overall/global data. If a hospital role has no linked hospital, the API returns 403 on hospital-scoped routes. Register response for these roles includes `linkedHospital` and a message that they will only see data for that hospital.

**Hospital scoping (when user has `hospital`):**  
For doctors, patients, and appointments: LIST returns only that hospital’s data; GET BY ID returns 403/404 if the resource belongs to another hospital; CREATE uses `req.user.hospital` (body `hospital` ignored); UPDATE/DELETE only on resources belonging to the user’s hospital.

---

## Public

### Health check

```bash
curl -X GET "http://localhost:3000/api/health"
```

### Register

- **Roles:** Anyone can register. `role` is optional; one of: `user`, `doctor`, `hospital_admin`. Defaults to `user`. **Admin and moderator cannot self-register** (403); they must be created by an existing admin.
- **Hospital roles (doctor, hospital_admin):** These roles are **defined at sign-up** by providing **`hospitalId`** (required). The user is linked to that hospital and will **only see data from that hospital**—never overall data. The API enforces this on all hospital-scoped routes. Response includes `linkedHospital` (the hospital document) and a message that the user will only see data for this hospital. `hospitalId` must be a valid MongoDB ObjectId and must exist in the DB. Role `user` must NOT send `hospitalId`.

```bash
# Basic user (no hospital)
curl -X POST "http://localhost:3000/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"secret123","name":"Demo User","role":"user"}'

# Hospital admin (requires hospitalId – create hospital first via POST /api/hospitals)
curl -X POST "http://localhost:3000/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hospital.com","password":"secret123","name":"Hospital Admin","role":"hospital_admin","hospitalId":"HOSPITAL_OBJECT_ID"}'

# Doctor (requires hospitalId)
curl -X POST "http://localhost:3000/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"doc@hospital.com","password":"secret123","name":"Dr. Smith","role":"doctor","hospitalId":"HOSPITAL_OBJECT_ID"}'
```

### Login

```bash
curl -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"secret123"}'
```

Use `accessToken` and `refreshToken` from the response for protected and refresh calls.

### Refresh tokens

```bash
curl -X POST "http://localhost:3000/api/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"YOUR_REFRESH_TOKEN"}'
```

### Logout

```bash
curl -X POST "http://localhost:3000/api/auth/logout" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"YOUR_REFRESH_TOKEN"}'
```

---

## Protected (Bearer token required)

**Roles:** Any authenticated user (any role). Replace `YOUR_ACCESS_TOKEN` with the `accessToken` from login or refresh.

### Get current user

Returns `user` and `hospital`. If the user is linked to a hospital (`user.hospital` set), `hospital` is the hospital document or `null` if the hospital was deleted. If the user has no hospital, `hospital` is `null`. Does not crash on invalid/deleted hospital.

**Roles:** Any authenticated user.

```bash
curl -X GET "http://localhost:3000/api/auth/me" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Logout all devices

```bash
curl -X POST "http://localhost:3000/api/auth/logout-all" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Admin only (admin or hospital_admin role required)

All routes require `Authorization: Bearer YOUR_ACCESS_TOKEN`.

### List all users

**Roles:** admin, hospital_admin.

- **admin:** returns all users. **hospital_admin:** returns only users belonging to their hospital.

```bash
curl -X GET "http://localhost:3000/api/admin/users" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Hospitals

All hospital routes require `Authorization: Bearer YOUR_ACCESS_TOKEN`.

- **admin:** Only role that can **create** (POST) and **delete** (DELETE) hospitals. Can list all hospitals, get/update any hospital.
- **hospital_admin:** Can **only** list/get/update **their assigned hospital** (403 for any other ID). **Cannot create or delete hospitals.**

Create a hospital first (as **admin** via POST /api/hospitals), then use its `_id` as `hospitalId` when registering hospital_admin or doctor users.

### List hospitals (paginated)

**URL:** `GET /api/hospitals?page=1&limit=20`

- **admin:** Returns all hospitals.
- **hospital_admin:** Returns only the one hospital they are linked to.

```bash
curl -X GET "http://localhost:3000/api/hospitals?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Get hospital by ID

- **admin:** Can get any hospital by ID.
- **hospital_admin:** Can only get their own hospital (403 if they request another hospital’s ID).

```bash
curl -X GET "http://localhost:3000/api/hospitals/HOSPITAL_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Create hospital (admin only)

**Roles:** **admin only.** hospital_admin cannot create hospitals.

You can send either **JSON** or **multipart/form-data** (to upload a logo).

- **JSON:** Required fields: `name`, `phoneNumber`, `email`, `contactPerson`, `registrationNumber`, `address`, `city`, `pincode`, `url`. Optional: `phoneCountryCode` (default `+91`), `logoUrl`.
- **Multipart (upload photo):** Use form field `logo` for the image file. Max 5MB; allowed types: JPEG, PNG, GIF, WebP. Other fields as form fields. The uploaded file is stored and `logoUrl` is set to e.g. `/uploads/hospitals/filename.jpg` (served by the API at `BASE_URL/uploads/...`).

**Example – JSON (no photo):**

```bash
curl -X POST "http://localhost:3000/api/hospitals" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"City General Hospital",
    "phoneCountryCode":"+91",
    "phoneNumber":"5693343366",
    "email":"hospital@citygeneral.com",
    "contactPerson":"Dr. Raj Kumar",
    "registrationNumber":"GST123456789",
    "address":"123 Medical Lane",
    "city":"Mumbai",
    "pincode":"400001",
    "url":"https://citygeneral.com",
    "logoUrl":""
  }'
```

**Example – multipart/form-data (with logo upload):**

```bash
curl -X POST "http://localhost:3000/api/hospitals" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -F "name=City General Hospital" \
  -F "phoneCountryCode=+91" \
  -F "phoneNumber=5693343366" \
  -F "email=hospital@citygeneral.com" \
  -F "contactPerson=Dr. Raj Kumar" \
  -F "registrationNumber=GST123456789" \
  -F "address=123 Medical Lane" \
  -F "city=Mumbai" \
  -F "pincode=400001" \
  -F "url=https://citygeneral.com" \
  -F "logo=@/path/to/your/hospital-logo.png"
```

### Update hospital

**Roles:** admin or hospital_admin. **Hospital scoping:** hospital_admin can update only their own hospital (403 for other IDs).

Accepts **JSON** or **multipart/form-data**. To change the logo, send a file in the `logo` field.

**Example – JSON:**

```bash
curl -X PATCH "http://localhost:3000/api/hospitals/HOSPITAL_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"5693343367","address":"124 Medical Lane"}'
```

**Example – update logo only (multipart):**

```bash
curl -X PATCH "http://localhost:3000/api/hospitals/HOSPITAL_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -F "logo=@/path/to/new-logo.jpg"
```

### Delete hospital (admin only)

**Roles:** **admin only.** hospital_admin cannot delete hospitals.

```bash
curl -X DELETE "http://localhost:3000/api/hospitals/HOSPITAL_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Doctors

**Roles:** List/search/get by ID: **doctor**, hospital_admin, admin. Create/update/delete: **hospital_admin, admin only** (doctors have read-only access to the doctors module).

**Hospital scoping:** When the user has a `hospital`, LIST/GET return only that hospital’s doctors; GET by ID returns 404 if the doctor belongs to another hospital. CREATE forces `hospital` from `req.user.hospital` (body `hospital` is ignored). UPDATE/DELETE only affect doctors in the user’s hospital.

### List doctors (paginated)

```bash
curl -X GET "http://localhost:3000/api/doctors?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Search doctors by name

Case-insensitive partial match on doctor full name. Optional `page` and `limit` for pagination.

```bash
curl -X GET "http://localhost:3000/api/doctors/search?name=John&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Get doctor by ID

```bash
curl -X GET "http://localhost:3000/api/doctors/DOCTOR_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Create doctor

`doctorId` is auto-generated by the server in format `MD-YYYY-XXXXXX` (e.g. `MD-2025-000001`). Do not send `doctorId` in the body.

```bash
curl -X POST "http://localhost:3000/api/doctors" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Dr. John Doe","phoneNumber":"+1234567890","email":"john@clinic.com","designation":"Cardiologist","availability":"9 AM - 5 PM","status":"On Duty","utilization":65}'
```

### Update doctor

```bash
curl -X PATCH "http://localhost:3000/api/doctors/DOCTOR_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"On Break","utilization":70}'
```

### Delete doctor

```bash
curl -X DELETE "http://localhost:3000/api/doctors/DOCTOR_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Patients

**Roles:** List/search/get/update: doctor, hospital_admin, admin. Create/delete: hospital_admin, admin only. All require `Authorization: Bearer YOUR_ACCESS_TOKEN`.

**Hospital scoping:** When the user has a `hospital`, LIST/GET return only that hospital’s patients; GET by ID returns 404 for another hospital’s patient. CREATE forces `hospital` from `req.user.hospital` (body `hospital` ignored). UPDATE/DELETE only affect patients in the user’s hospital.

All patient GET endpoints (list, search, get by ID) include an `appointments` array on each patient, with each appointment populated with `doctor` (fullName, doctorId, designation).

### List patients (paginated)

```bash
curl -X GET "http://localhost:3000/api/patients?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Search patients by name

Case-insensitive partial match on patient full name. Optional `page` and `limit` for pagination.

```bash
curl -X GET "http://localhost:3000/api/patients/search?name=Jane&page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Get patient by ID

```bash
curl -X GET "http://localhost:3000/api/patients/PATIENT_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Create patient (hospital_admin or admin only)

`patientId` is auto-generated by the server in format `P-YYYY-000001` (e.g. `P-2025-000001`). Do not send `patientId` in the body.

```bash
curl -X POST "http://localhost:3000/api/patients" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Jane Smith","phoneNumber":"+9876543210","age":35,"gender":"Female","reason":"General checkup"}'
```

### Update patient

```bash
curl -X PATCH "http://localhost:3000/api/patients/PATIENT_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"age":36,"phoneNumber":"+9876543211"}'
```

### Delete patient (hospital_admin or admin only)

```bash
curl -X DELETE "http://localhost:3000/api/patients/PATIENT_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Appointments

**Roles:** List/get/update: doctor, hospital_admin, admin. Create/delete: hospital_admin, admin only. All require `Authorization: Bearer YOUR_ACCESS_TOKEN`.

**Hospital scoping:** When the user has a `hospital`, LIST/GET return only that hospital’s appointments; GET by ID returns 404 for another hospital’s appointment. CREATE: doctor and patient must exist and belong to the same hospital; `hospital` and `appointmentId` are set by the server (body ignored). UPDATE/DELETE only affect appointments in the user’s hospital.

### List appointments (paginated, filterable)

```bash
# All appointments
curl -X GET "http://localhost:3000/api/appointments?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Filter by doctor, patient, or status
curl -X GET "http://localhost:3000/api/appointments?doctorId=DOCTOR_ID&patientId=PATIENT_ID&status=Upcoming" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Get appointment by ID

```bash
curl -X GET "http://localhost:3000/api/appointments/APPOINTMENT_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Create appointment (hospital_admin or admin only)

`appointmentId` is auto-generated by the server in format `A-YYYY-000001` (e.g. `A-2025-000001`). Do not send `appointmentId` in the body. `type` must be one of: `hospital`, `zoom`, `visit`, `online`, `checkup`, `consultation`, `emergency` (default `hospital`). Doctor and patient must belong to the same hospital.

```bash
curl -X POST "http://localhost:3000/api/appointments" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"patient":"PATIENT_ID","doctor":"DOCTOR_ID","reason":"Follow-up check","status":"Upcoming","type":"hospital","appointmentDateTime":"2025-02-10T10:00:00.000Z"}'
```

### Update appointment

```bash
curl -X PATCH "http://localhost:3000/api/appointments/APPOINTMENT_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"Completed"}'
```

### Delete appointment (hospital_admin or admin only)

```bash
curl -X DELETE "http://localhost:3000/api/appointments/APPOINTMENT_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Quick test flow

```bash
# 1. Register (global admin – no hospital)
curl -s -X POST "http://localhost:3000/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123","name":"Admin","role":"admin"}'

# 2. Login and save tokens (bash)
RESP=$(curl -s -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}')
ACCESS=$(echo "$RESP" | jq -r '.data.accessToken')
REFRESH=$(echo "$RESP" | jq -r '.data.refreshToken')

# 3. Get current user (includes hospital if set)
curl -s -X GET "http://localhost:3000/api/auth/me" -H "Authorization: Bearer $ACCESS"

# 4. Create a hospital (admin only)
curl -s -X POST "http://localhost:3000/api/hospitals" \
  -H "Authorization: Bearer $ACCESS" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Hospital","phoneNumber":"1234567890","email":"test@hospital.com","contactPerson":"Admin","registrationNumber":"REG001","address":"1 Main St","city":"Mumbai","pincode":"400001","url":"https://test.com"}'

# 5. List hospitals and copy an _id, then register hospital_admin with that hospitalId
# curl -s -X GET "http://localhost:3000/api/hospitals" -H "Authorization: Bearer $ACCESS"
# Then: register with "role":"hospital_admin","hospitalId":"<HOSPITAL_ID>"

# 6. Admin: list users
curl -s -X GET "http://localhost:3000/api/admin/users" -H "Authorization: Bearer $ACCESS"
```
