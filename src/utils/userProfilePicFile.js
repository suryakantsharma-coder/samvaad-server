const fs = require("fs").promises;
const path = require("path");
const env = require("../config/env");

const URL_PREFIX = "/uploads/users/";

/**
 * Delete a previously stored user profile picture on disk (only under UPLOADS_ROOT/users).
 * Ignores external URLs and missing files.
 */
async function unlinkUserProfilePicIfStored(profilePicUrl) {
  if (!profilePicUrl || typeof profilePicUrl !== "string") return;
  const trimmed = profilePicUrl.trim();
  if (!trimmed.startsWith(URL_PREFIX)) return;
  const base = path.basename(trimmed);
  if (!base || base === "." || base === "..") return;
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) return;
  const abs = path.resolve(env.UPLOADS_ROOT, "users", base);
  const root = path.resolve(env.UPLOADS_ROOT, "users");
  if (!abs.startsWith(root)) return;
  try {
    await fs.unlink(abs);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[User profile pic] unlink failed:", e.message);
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
      console.error("[User profile pic] orphan upload cleanup failed:", e.message);
    }
  }
}

module.exports = {
  unlinkUserProfilePicIfStored,
  unlinkMulterTempFile,
};
