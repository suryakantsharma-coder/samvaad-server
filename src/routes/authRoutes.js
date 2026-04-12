const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { requireUserProfilePic } = require('../middleware/upload');
const { allowOnlyProfileFields, updateMeProfile } = require('../validators/auth.validator');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

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
