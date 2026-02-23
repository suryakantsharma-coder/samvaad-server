# Samvaad API – Audit Report

**Date:** 2025-02-06  
**Scope:** Moderator clarification, doctor read-only doctors access, /api/auth/me hospital + safety, hospital admin create/delete restrictions, token security, user schema validation, documentation.

---

## 1. Full endpoint table

| Method | Endpoint | Protected | Roles | Hospital scoping |
|--------|----------|-----------|-------|------------------|
| GET | /api/health | No | — | — |
| POST | /api/auth/register | No | — | — |
| POST | /api/auth/login | No | — | — |
| POST | /api/auth/refresh | No | — | — |
| POST | /api/auth/logout | No | — | — |
| GET | /api/auth/me | Yes | Any | Returns user + hospital (null if deleted) |
| POST | /api/auth/logout-all | Yes | Any | — |
| GET | /api/admin/users | Yes | admin, hospital_admin | hospital_admin: own hospital only |
| GET | /api/hospitals | Yes | admin, hospital_admin | hospital_admin: own only |
| GET | /api/hospitals/:id | Yes | admin, hospital_admin | hospital_admin: own only, 403 else |
| POST | /api/hospitals | Yes | **admin only** | — |
| PATCH | /api/hospitals/:id | Yes | admin, hospital_admin | hospital_admin: own only, 403 else |
| DELETE | /api/hospitals/:id | Yes | **admin only** | — |
| GET | /api/doctors | Yes | **doctor**, hospital_admin, admin | By user.hospital when set |
| GET | /api/doctors/search | Yes | **doctor**, hospital_admin, admin | By user.hospital when set |
| GET | /api/doctors/:id | Yes | **doctor**, hospital_admin, admin | By user.hospital when set |
| POST | /api/doctors | Yes | hospital_admin, admin | hospital from req.user only |
| PATCH | /api/doctors/:id | Yes | hospital_admin, admin | By user.hospital when set |
| DELETE | /api/doctors/:id | Yes | hospital_admin, admin | By user.hospital when set |
| GET | /api/patients | Yes | doctor, hospital_admin, admin | By user.hospital when set |
| GET | /api/patients/search | Yes | doctor, hospital_admin, admin | By user.hospital when set |
| GET | /api/patients/:id | Yes | doctor, hospital_admin, admin | By user.hospital when set |
| POST | /api/patients | Yes | hospital_admin, admin | hospital from req.user only |
| PATCH | /api/patients/:id | Yes | doctor, hospital_admin, admin | By user.hospital when set |
| DELETE | /api/patients/:id | Yes | hospital_admin, admin | By user.hospital when set |
| GET | /api/appointments | Yes | doctor, hospital_admin, admin | By user.hospital when set |
| GET | /api/appointments/:id | Yes | doctor, hospital_admin, admin | By user.hospital when set |
| POST | /api/appointments | Yes | hospital_admin, admin | doctor/patient same hospital; hospital from context |
| PATCH | /api/appointments/:id | Yes | doctor, hospital_admin, admin | By user.hospital when set |
| DELETE | /api/appointments/:id | Yes | hospital_admin, admin | By user.hospital when set |

---

## 2. All roles and permissions

| Role | Can login/register | Hospital | Routes |
|------|--------------------|----------|--------|
| **user** | Yes (default) | No (null) | /auth/me, /auth/logout-all only |
| **doctor** | Yes (with hospitalId) | Required | Doctors: GET list, search, by ID (read-only). Patients: GET, PATCH. Appointments: GET, PATCH. All scoped to own hospital. |
| **moderator** | No (403 self-register) | Must be null | Not used by any route; reserved for future. |
| **hospital_admin** | Yes (with hospitalId) | Required | Admin users (own hospital). Hospitals: GET list/id, PATCH (own only). No POST/DELETE hospitals. Doctors/patients/appointments: full CRUD scoped to own hospital. |
| **admin** | No (403 self-register) | Must be null | All routes. Only role that can POST and DELETE hospitals. |

---

## 3. Hospital scoping verification results

- **Doctors:** LIST/search/GET by ID filter by `req.user.hospital` when present. CREATE uses `req.user.hospital` only (body stripped). UPDATE/DELETE use `filter.hospital = req.user.hospital`. **Verified.**
- **Patients:** Same pattern. **Verified.**
- **Appointments:** Same pattern; CREATE validates doctor.hospital === patient.hospital and sets appointment.hospital from context. **Verified.**
- **Hospitals:** GET list/GET by ID: hospital_admin sees only `_id: req.user.hospital`. PATCH/DELETE: hospital_admin restricted to own hospital in controller (POST/DELETE are admin-only at route level). **Verified.**
- **Admin users list:** hospital_admin filter `hospital: req.user.hospital`. **Verified.**

---

## 4. Token security verification

- **Refresh tokens stored:** Yes. `RefreshToken` model stores `token`, `user`, `expiresAt`, `userAgent`. Unique on token. Index on user; TTL index on expiresAt. **Verified.**
- **/logout:** Removes the single refresh token via `RefreshToken.deleteOne({ token })`. **Verified.**
- **/logout-all:** Removes all refresh tokens for the user via `RefreshToken.deleteMany({ user: userId })`. **Verified.**
- **Refresh endpoint:** Verifies JWT with `verifyRefreshToken`; looks up token in DB; rejects if not found (revoked) or user disabled; deletes old token and creates new one (rotation). **Verified.**
- **Fix applied:** Refresh endpoint now returns 401 for `TokenExpiredError` and `JsonWebTokenError` instead of 500 (authController.js).

---

## 5. All fixes applied (with file names)

| # | Fix | File(s) |
|---|-----|--------|
| 1 | Moderator: clarified in roles.js comment; RBAC doc updated (not used by any route). | `src/middleware/roles.js`, `CURL-ROUTES.md` |
| 2 | Doctor read-only doctors: GET /doctors, /doctors/search, /doctors/:id use requireStaff; POST/PATCH/DELETE use requireAdmin. | `src/routes/doctorRoutes.js` |
| 3 | /api/auth/me returns user + hospital; hospital null if deleted or not linked; no crash on invalid hospital. | `src/controllers/authController.js` |
| 4 | POST and DELETE hospitals: admin only (requireAdminOnly). GET/PATCH: requireAdmin (hospital_admin scoped in controller). | `src/routes/hospitalRoutes.js`, `src/middleware/roles.js` |
| 5 | Refresh endpoint: 401 for TokenExpiredError and JsonWebTokenError. | `src/controllers/authController.js` |
| 6 | User schema: doctor/hospital_admin require hospital (pre-save); admin/moderator have hospital cleared. Added phoneNumber, lastLoginAt, emailVerified. | `src/models/User.js` |
| 7 | Login updates lastLoginAt on user. | `src/services/authService.js` |
| 8 | CURL-ROUTES.md: RBAC updated (doctor read-only doctors, moderator unused, hospital_admin no create/delete hospitals). /auth/me behavior and hospital response documented. Hospitals POST/DELETE marked admin only. | `CURL-ROUTES.md` |

---

## 6. Remaining recommended improvements

- **Moderator:** Either assign concrete routes to moderator (e.g. content moderation) or remove from ROLES and registration block if not needed.
- **Refresh token rotation:** Current implementation deletes old token and creates new one; consider short overlap or family IDs if strict one-time-use is required across devices.
- **Rate limiting:** Consider rate limiting on /auth/login and /auth/refresh to reduce brute-force and token abuse.
- **emailVerified:** No endpoint yet to set or verify email; consider verification flow and setting emailVerified.
- **Hospital DELETE:** If hospital is deleted, consider soft-delete or cascading rules for linked users/doctors/patients/appointments (currently not implemented).

---

**Report generated after full task completion. All changes saved; code compiles.**
