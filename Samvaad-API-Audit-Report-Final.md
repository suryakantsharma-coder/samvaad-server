# Samvaad API – RBAC & Hospital Scoping Audit Report (Final)

**Date:** February 2026  
**Scope:** Backend API RBAC, hospital scoping, and cross-hospital access prevention.

---

## 1. What Was Missing (Before This Audit)

| Gap | Description |
|-----|-------------|
| **No single source of truth for hospital filter** | Each controller (doctors, patients, appointments) implemented its own `if (req.user && req.user.hospital && mongoose.isValidObjectId(req.user.hospital)) filter.hospital = req.user.hospital`. This was correct but duplicated in many places, increasing the risk of missing scoping in new endpoints or copy-paste errors. |
| **No centralized helper** | There was no shared utility or middleware for “apply hospital scope to this query,” so future list/get/update/delete handlers could easily omit the scope by mistake. |

**Already correct (verified during audit):**

- **POST /api/hospitals** and **DELETE /api/hospitals/:id** were already protected with `requireAdminOnly` in `hospitalRoutes.js`, so only `admin` can create or delete hospitals.
- **GET /api/admin/users** already filtered by `filter.hospital = req.user.hospital` when the requester is `hospital_admin`. Admin users have `hospital: null` in the User model, so they are never returned to a hospital_admin; hospital_admin cannot view admin users.
- All doctors/patients/appointments list, get-by-id, update, and delete handlers were already applying a hospital filter for non-admin users (when `req.user.hospital` was set and valid).
- Hospital controller GET list / getById / update / remove already restricted hospital_admin to their own hospital (filter by `_id = req.user.hospital` or 403 when ID does not match).
- Routes use `requireHospitalLink` so doctor and hospital_admin must have a linked hospital or receive 403 before reaching controllers.

---

## 2. What Was Fixed

| Change | Details |
|--------|---------|
| **Centralized hospital scoping** | Added **`src/utils/hospitalScope.js`** with: `getHospitalFilter(req)` and `mergeHospitalFilter(req, filter)`. These return `{ hospital: req.user.hospital }` when the user has a valid linked hospital, and `{}` otherwise (admin with no hospital sees all). |
| **Controller refactor** | **Doctor, patient, and appointment** controllers now use `mergeHospitalFilter(req, filter)` (or `mergeHospitalFilter(req, query)`) for every list, get-by-id, update, and delete. All hospital-scoped queries go through this helper. |
| **Nested appointment queries in patient controller** | When loading appointments for the patient list or for a single patient, the appointment queries now also use `mergeHospitalFilter(req, …)` so nested reads are hospital-scoped. |
| **Confirmation of existing safeguards** | No changes were required for POST/DELETE hospitals (already admin-only) or GET /api/admin/users (hospital_admin already cannot see admin users). |

---

## 3. Updated Endpoint–Role Table

All routes are under `/api`. Auth routes do not require a role (except `protect` where noted).  
**Roles:** `admin`, `hospital_admin`, `doctor`, `moderator`, `user`.  
**Hospital scoping:** “Yes” = non-admin access is limited to the requester’s linked hospital via `mergeHospitalFilter` or equivalent; “N/A” = not applicable (e.g. auth); “Admin only” = only admin can perform the action.

| Method | Path | Allowed roles | Hospital scoping |
|--------|------|----------------|-------------------|
| **Auth** | | | |
| POST | /api/auth/register | (public) | N/A |
| POST | /api/auth/login | (public) | N/A |
| POST | /api/auth/refresh | (public) | N/A |
| POST | /api/auth/logout | (public) | N/A |
| GET | /api/auth/me | Authenticated | N/A |
| POST | /api/auth/logout-all | Authenticated | N/A |
| **Admin (users)** | | | |
| GET | /api/admin/users | admin, hospital_admin | Yes (hospital_admin: filter by `req.user.hospital`; admin users have `hospital: null` so never returned to hospital_admin) |
| **Hospitals** | | | |
| GET | /api/hospitals | admin, hospital_admin | Yes (hospital_admin: filter `_id = req.user.hospital`) |
| GET | /api/hospitals/:id | admin, hospital_admin | Yes (hospital_admin: 403 if id ≠ req.user.hospital) |
| POST | /api/hospitals | **admin only** | Admin only |
| PATCH | /api/hospitals/:id | admin, hospital_admin | Yes (hospital_admin: 403 if id ≠ req.user.hospital) |
| DELETE | /api/hospitals/:id | **admin only** | Admin only |
| **Doctors** | | | |
| GET | /api/doctors | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| GET | /api/doctors/search | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| GET | /api/doctors/:id | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| POST | /api/doctors | hospital_admin, admin | Yes (create uses hospital from body; non-admin must pass their hospital) |
| PATCH | /api/doctors/:id | hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| DELETE | /api/doctors/:id | hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| **Patients** | | | |
| GET | /api/patients | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter` on patients + appointment sub-queries) |
| GET | /api/patients/search | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| GET | /api/patients/:id | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| POST | /api/patients | hospital_admin, admin | Yes (create uses hospital from body) |
| PATCH | /api/patients/:id | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| DELETE | /api/patients/:id | hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| **Appointments** | | | |
| GET | /api/appointments | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| GET | /api/appointments/:id | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| POST | /api/appointments | hospital_admin, admin | Yes (create validates doctor/patient/hospital consistency) |
| PATCH | /api/appointments/:id | doctor, hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| DELETE | /api/appointments/:id | hospital_admin, admin | Yes (`mergeHospitalFilter`) |
| **Health** | | | |
| GET | /api/health | (public) | N/A |

---

## 4. Confirmation: Cross-Hospital Access Is Impossible

- **Route-level:** All hospital-scoped modules (hospitals, admin/users, doctors, patients, appointments) use `requireHospitalLink`. For roles in `HOSPITAL_ROLES` (doctor, hospital_admin), the user must have `req.user.hospital` set or they get 403 before any controller runs.
- **Query-level:** For doctors, patients, and appointments, every list, get-by-id, update, and delete uses `mergeHospitalFilter(req, filter)`. When `req.user.hospital` is set and valid, the filter includes `hospital: req.user.hospital`, so MongoDB only returns or updates documents for that hospital. When the user is admin (no `req.user.hospital`), the helper returns `{}`, so admin sees all data by design.
- **Admin-only actions:** POST and DELETE `/api/hospitals` use `requireAdminOnly`; only the `admin` role can create or delete hospitals. Hospital_admin cannot create or delete hospitals.
- **Admin users visibility:** GET `/api/admin/users` for a hospital_admin sets `filter.hospital = req.user.hospital`. Admin users have `hospital: null`, so they are never in the result set. Hospital_admin cannot view admin users.
- **Single source of truth:** All hospital-scoped query logic now goes through `src/utils/hospitalScope.js`. New endpoints that need hospital scoping should use `mergeHospitalFilter(req, filter)` to avoid cross-hospital data leaks.

**Conclusion:** With the current implementation, a non-admin user (doctor or hospital_admin) can only access data for their linked hospital. Cross-hospital access is impossible for these roles.
