const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { requireUserProfilePic } = require('../middleware/upload');
const {
  allowOnlyProfileFields,
  updateMeProfile,
  forgotPasswordRules,
  resetPasswordRules,
} = require('../validators/auth.validator');

const router = express.Router();

// Public auth: no JWT, no role checks (same as register/login).
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post(
  '/forgot-password',
  forgotPasswordRules,
  validate,
  authController.forgotPassword
);
router.post('/reset-password', resetPasswordRules, validate, authController.resetPassword);

router.use(protect);
router.get('/me', authController.me);
router.patch(
  '/me',
  allowOnlyProfileFields,
  updateMeProfile,
  validate,
  authController.updateMe
);
router.post('/me/profile-picture', requireUserProfilePic, authController.uploadProfilePicture);
router.post('/logout-all', authController.logoutAll);

module.exports = router;
