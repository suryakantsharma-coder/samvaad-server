const express = require('express');
const authRoutes = require('./authRoutes');
const adminRoutes = require('./adminRoutes');
const hospitalRoutes = require('./hospitalRoutes');
const doctorRoutes = require('./doctorRoutes');
const patientRoutes = require('./patientRoutes');
const appointmentRoutes = require('./appointmentRoutes');
const prescriptionRoutes = require('./prescriptionRoutes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/hospitals', hospitalRoutes);
router.use('/doctors', doctorRoutes);
router.use('/patients', patientRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/prescriptions', prescriptionRoutes);

router.get('/health', (req, res) => {
  res.json({ success: true, app: 'samvaad', timestamp: new Date().toISOString() });
});

module.exports = router;
