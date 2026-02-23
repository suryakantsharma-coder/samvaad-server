# Samvaad API – Endpoint Audit Report

**Date:** 2025-02-06  
**Scope:** Role list (RBAC), endpoint verification, hospital scoping, appointment integrity, register rules, documentation updates.

---

## 1. Endpoints checked

| Module        | Endpoint / Route                          | Method | Protected | Role check        | Hospital scoping |
|---------------|-------------------------------------------|--------|-----------|--------------------|------------------|
| auth          | /api/auth/register                        | POST   | No        | N/A                | N/A              |
| auth          | /api/auth/login                           | POST   | No        | N/A                | N/A              |
| auth          | /api/auth/refresh                         | POST   | No        | N/A                | N/A              |
| auth          | /api/auth/logout                          | POST   | No        | N/A                | N/A              |
| auth          | /api/auth/me                              | GET    | Yes       | Any                | N/A              |
| auth          | /api/auth/logout-all                      | POST   | Yes       | Any                | N/A              |
| admin         | /api/admin/users                         | GET    | Yes       | admin, hospital_admin | Yes (hospital_admin: own hospital only) |
| hospitals     | /api/hospitals                            | GET    | Yes       | admin, hospital_admin | Yes (admin: all; hospital_admin: own only) |
| hospitals     | /api/hospitals/:id                        | GET    | Yes       | admin, hospital_admin | Yes (hospital_admin: own only, 403 else) |
| hospitals     | /api/hospitals                            | POST   | Yes       | admin, hospital_admin | N/A              |
| hospitals     | /api/hospitals/:id                        | PATCH  | Yes       | admin, hospital_admin | Yes (hospital_admin: own only – **fixed**) |
| hospitals     | /api/hospitals/:id                        | DELETE | Yes       | admin, hospital_admin | Yes (hospital_admin: own only – **fixed**) |
| doctors       | /api/doctors                              | GET    | Yes       | admin, hospital_admin | Yes (when user.hospital) |
| doctors       | /api/doctors/search                       | GET    | Yes       | admin, hospital_admin | Yes (when user.hospital) |
| doctors       | /api/doctors/:id                          | GET    | Yes       | admin, hospital_admin | Yes (404 if other hospital) |
| doctors       | /api/doctors                              | POST   | Yes       | admin, hospital_admin | Yes (hospital from req.user; body stripped – **fixed**) |
| doctors       | /api/doctors/:id                          | PATCH  | Yes       | admin, hospital_admin | Yes (filter by hospital) |
| doctors       | /api/doctors/:id                          | DELETE | Yes       | admin, hospital_admin | Yes (filter by hospital) |
| patients      | /api/patients                             | GET    | Yes       | doctor, hospital_admin, admin | Yes (when user.hospital) |
| patients      | /api/patients/search                      | GET    | Yes       | doctor, hospital_admin, admin | Yes (when user.hospital) |
| patients      | /api/patients/:id                         | GET    | Yes       | doctor, hospital_admin, admin | Yes (404 if other hospital) |
| patients      | /api/patients                             | POST   | Yes       | hospital_admin, admin | Yes (hospital from req.user; body stripped – **fixed**) |
| patients      | /api/patients/:id                         | PATCH  | Yes       | doctor, hospital_admin, admin | Yes (filter by hospital) |
| patients      | /api/patients/:id                         | DELETE | Yes       | hospital_admin, admin | Yes (filter by hospital) |
| appointments  | /api/appointments                         | GET    | Yes       | doctor, hospital_admin, admin | Yes (when user.hospital) |
| appointments  | /api/appointments/:id                     | GET    | Yes       | doctor, hospital_admin, admin | Yes (404 if other hospital) |
| appointments  | /api/appointments                         | POST   | Yes       | hospital_admin, admin | Yes (doctor/patient same hospital; hospital + appointmentId from server – **fixed**) |
| appointments  | /api/appointments/:id                     | PATCH  | Yes       | doctor, hospital_admin, admin | Yes (filter by hospital) |
| appointments  | /api/appointments/:id                     | DELETE | Yes       | hospital_admin, admin | Yes (filter by hospital) |

---

## 2. Scoping issues found and fixed

- **Hospitals PATCH/DELETE:** hospital_admin could previously update/delete any hospital by ID. **Fix:** In `hospitalController.update` and `hospitalController.remove`, added a check: if role is `hospital_admin`, allow only when `req.params.id === req.user.hospital`; otherwise return 403.
- **Doctor/Patient CREATE body:** `hospital` could be sent in the request body. **Fix:** In `doctorController.create` and `patientController.create`, `hospital` is deleted from the body before create; hospital is always taken from `req.user.hospital`.
- **Appointment CREATE body:** `appointmentId` and `hospital` could be sent in the body. **Fix:** In `appointmentController.create`, both are deleted from the body before create; `appointmentId` is generated and `hospital` is derived from doctor/patient/user context.

---

## 3. Role-access mismatches found and fixed

- **Register – admin/moderator:** Any client could register with `role: "admin"` or `role: "moderator"`. **Fix:** In `authService.register`, if role is `admin` or `moderator`, throw 403 with message "Cannot self-register as admin or moderator". Auth controller now returns 403 and 400 with appropriate messages.
- **Register – hospitalId validation:** `hospitalId` for doctor/hospital_admin was not validated as a Mongo ObjectId before `Hospital.findById`. **Fix:** In `authService.register`, added `mongoose.isValidObjectId(hospitalId)` check; if invalid, return 400 "hospitalId must be a valid Mongo ObjectId".

---

## 4. Appointment integrity (verified)

- Doctor exists: checked via `Doctor.findById(req.body.doctor)`; 404 if not found.
- Patient exists: checked via `Patient.findById(req.body.patient)`; 404 if not found.
- doctor.hospital === patient.hospital: checked with `doctorExists.hospital && patientExists.hospital && !doctorExists.hospital.equals(patientExists.hospital)` → 400 "Doctor and patient must belong to the same hospital".
- appointment.hospital: set from `doctorExists.hospital || patientExists.hospital || req.user.hospital`; hospital context required (400 if missing).
- appointmentId: generated by `generateAppointmentId()`; request body `appointmentId` and `hospital` are stripped before create.

---

## 5. Register rules (verified and fixed)

- role defaults to `"user"`: yes (`role = ROLES.USER` in authService).
- doctor and hospital_admin MUST include hospitalId: yes; 400 if missing.
- hospitalId must be a valid Mongo ObjectId: **added** `mongoose.isValidObjectId(hospitalId)`.
- hospitalId must exist in DB: yes (`Hospital.findById`; 400 "Hospital not found" if null).
- user role does NOT require hospitalId: yes (only doctor and hospital_admin require it).
- Prevent random admin (and moderator) registration: **added** 403 when role is admin or moderator.

---

## 6. Documentation updates (CURL-ROUTES.md)

- **User Roles (RBAC):** New section near the top listing all five roles (`user`, `doctor`, `moderator`, `hospital_admin`, `admin`) with: can login/register, hospital linked or not, which routes they can access. Hospital scoping behavior summarized.
- **Register:** Updated to state admin/moderator cannot self-register; hospitalId must be valid ObjectId and exist; user role does not require hospitalId.
- **GET /api/hospitals:** Added explicit curl example: `GET "http://localhost:3000/api/hospitals?page=1&limit=20"` with Bearer token.
- **Per-endpoint:** For Protected, Admin, Hospitals (list/get/create/update/delete), Doctors, Patients, Appointments: added or clarified **Roles** and **Hospital scoping** for each section.

---

## 7. Summary

- **Endpoints checked:** 28 (auth, admin, hospitals, doctors, patients, appointments).
- **Scoping issues fixed:** 3 (hospital update/delete for hospital_admin; doctor/patient create body hospital; appointment create body appointmentId/hospital).
- **Role-access fixes:** 2 (block admin/moderator self-register; validate hospitalId as ObjectId).
- **CURL-ROUTES.md:** Updated and saved with RBAC section, register rules, GET hospitals example, and role + hospital scoping for each relevant section.
