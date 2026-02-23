const path = require('path');
const fs = require('fs');
const multer = require('multer');

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'hospitals');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (file.mimetype === 'image/jpeg' ? '.jpg' : path.extname(file.originalname)) || '.jpg';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    cb(null, name);
  },
});

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

/**
 * Optional single file upload for field 'logo'.
 * Use only when Content-Type is multipart/form-data; otherwise call next() without parsing.
 */
const optionalHospitalLogo = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return next();
  }
  upload.single('logo')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large (max 5MB)' });
      }
      if (err.message && err.message.includes('Only image')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      return next(err);
    }
    next();
  });
};

module.exports = {
  optionalHospitalLogo,
  UPLOAD_DIR,
};
