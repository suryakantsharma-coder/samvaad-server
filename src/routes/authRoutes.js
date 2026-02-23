const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

router.use(protect);
router.get('/me', authController.me);
router.post('/logout-all', authController.logoutAll);

module.exports = router;
