const express = require('express');
const authRoutes = require('./authRoutes');
const adminRoutes = require('./adminRoutes');
const hospitalRoutes = require('./hospitalRoutes');
const doctorRoutes = require('./doctorRoutes');
const patientRoutes = require('./patientRoutes');
const appointmentRoutes = require('./appointmentRoutes');
const prescriptionRoutes = require('./prescriptionRoutes');
const livekitRoutes = require('./livekitRoutes');
const whatsappRoutes = require('./whatsappRoutes');
const teleCallerRoutes = require('./teleCallerRoutes');
const paymentRoutes = require('./paymentRoutes');
const razorpayRoutes = require('../razorpay/razorpayRoutes');
const publicRoutes = require('./publicRoutes');
const medicineRoutes = require('./medicineRoutes');

const router = express.Router();

router.use('/public', publicRoutes);
router.use('/medicines', medicineRoutes);
router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/hospitals', hospitalRoutes);
router.use('/doctors', doctorRoutes);
router.use('/patients', patientRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/prescriptions', prescriptionRoutes);
router.use('/livekit', livekitRoutes);
router.use('/whatsapp', whatsappRoutes);
router.use('/tele-caller', teleCallerRoutes);
router.use('/payments', paymentRoutes);
router.use('/razorpay', razorpayRoutes);

router.get('/health', (req, res) => {
  res.json({ success: true, app: 'samvaad', timestamp: new Date().toISOString() });
});

module.exports = router;
