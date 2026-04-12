const path = require('path');
const fs = require('fs');
const multer = require('multer');
const env = require('../config/env');

const UPLOAD_DIR = path.join(env.UPLOADS_ROOT, 'hospitals');
const USER_UPLOAD_DIR = path.join(env.UPLOADS_ROOT, 'users');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Ensure upload directories exist
for (const dir of [UPLOAD_DIR, USER_UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createLogoLikeStorage(destinationDir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, destinationDir),
    filename: (req, file, cb) => {
      const ext = (file.mimetype === 'image/jpeg' ? '.jpg' : path.extname(file.originalname)) || '.jpg';
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
      cb(null, name);
    },
  });
}

const storage = createLogoLikeStorage(UPLOAD_DIR);
const userProfileStorage = createLogoLikeStorage(USER_UPLOAD_DIR);

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (JPEG, PNG, GIF, WebP)'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

const userProfileUpload = multer({
  storage: userProfileStorage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

/** Accept common field names from browsers / UI libraries (Ant Design often uses `file`). */
const hospitalLogoFields = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'file', maxCount: 1 },
  { name: 'image', maxCount: 1 },
]);

/**
 * Optional image upload for hospital logo (multipart only).
 * Populates `req.file` from the first matching field: logo | file | image.
 */
const optionalHospitalLogo = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return next();
  }
  hospitalLogoFields(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large (max 5MB)' });
      }
      if (err.message && err.message.includes('Only image')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      return next(err);
    }
    const files = req.files || {};
    req.file = files.logo?.[0] || files.file?.[0] || files.image?.[0];
    next();
  });
};

/** Same field names as hospital logo; files go to uploads/users/. */
const userProfilePicFields = userProfileUpload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'file', maxCount: 1 },
  { name: 'image', maxCount: 1 },
]);

/**
 * Profile picture upload (multipart required). Populates `req.file` from logo | file | image.
 */
const requireUserProfilePic = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return res.status(400).json({
      success: false,
      message: 'Content-Type must be multipart/form-data with an image file',
    });
  }
  userProfilePicFields(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large (max 5MB)' });
      }
      if (err.message && err.message.includes('Only image')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      return next(err);
    }
    const files = req.files || {};
    req.file = files.logo?.[0] || files.file?.[0] || files.image?.[0];
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Image file required (field name: logo, file, or image)',
      });
    }
    next();
  });
};

module.exports = {
  optionalHospitalLogo,
  requireUserProfilePic,
  UPLOAD_DIR,
  USER_UPLOAD_DIR,
};
