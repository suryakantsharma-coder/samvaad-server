const fs = require("fs").promises;
const path = require("path");
const env = require("../config/env");

const URL_PREFIX = "/uploads/hospitals/";

/**
 * Delete a previously stored hospital logo file on disk (only under UPLOADS_ROOT/hospitals).
 * Ignores external URLs and missing files.
 */
async function unlinkHospitalLogoIfStored(logoUrl) {
  if (!logoUrl || typeof logoUrl !== "string") return;
  const trimmed = logoUrl.trim();
  if (!trimmed.startsWith(URL_PREFIX)) return;
  const base = path.basename(trimmed);
  if (!base || base === "." || base === "..") return;
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) return;
  const abs = path.resolve(env.UPLOADS_ROOT, "hospitals", base);
  const root = path.resolve(env.UPLOADS_ROOT, "hospitals");
  if (!abs.startsWith(root)) return;
  try {
    await fs.unlink(abs);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[Hospital logo] unlink failed:", e.message);
    }
  }
}

/** Remove a just-uploaded multer file (e.g. validation or DB failure). */
async function unlinkMulterTempFile(file) {
  if (!file?.path) return;
  try {
    await fs.unlink(file.path);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[Hospital logo] orphan upload cleanup failed:", e.message);
    }
  }
}

module.exports = {
  unlinkHospitalLogoIfStored,
  unlinkMulterTempFile,
};
