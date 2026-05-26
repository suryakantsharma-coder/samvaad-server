const mongoose = require('mongoose');
const Observation = require('../models/observation.model');
const Patient = require('../models/patient.model');
const { mergeHospitalFilter, getLinkedHospitalForResponse } = require('../utils/hospitalScope');

const normalizeObservationEntry = (entry) => ({
  text: String(entry.text || '').trim(),
  time: entry.time ? new Date(entry.time) : new Date(),
});

const ensurePatientInScope = async (req, patientId) => {
  const patientFilter = { _id: patientId };
  mergeHospitalFilter(req, patientFilter);
  return Patient.findOne(patientFilter).select('_id hospital').lean();
};

/**
 * @route POST /api/observations
 * Create observation document for patient (one document per patient).
 */
const create = async (req, res, next) => {
  try {
    const { patientId } = req.body;
    const patient = await ensurePatientInScope(req, patientId);
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const filter = { patientId: new mongoose.Types.ObjectId(String(patientId)) };
    mergeHospitalFilter(req, filter);
    const existing = await Observation.findOne(filter).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Observation already exists for this patient',
      });
    }

    const entries = Array.isArray(req.body.observations)
      ? req.body.observations.map(normalizeObservationEntry)
      : [];

    const observation = await Observation.create({
      patientId,
      hospital: patient.hospital || undefined,
      observations: entries,
    });

    res.status(201).json({ success: true, data: { observation: observation.toObject() } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route PATCH /api/observations/:id
 * Replace observations array for a document.
 */
const update = async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body.observations)
      ? req.body.observations.map(normalizeObservationEntry)
      : [];

    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);
    const observation = await Observation.findOneAndUpdate(
      filter,
      { $set: { observations: entries } },
      { new: true, runValidators: true }
    ).lean();

    if (!observation) {
      return res.status(404).json({ success: false, message: 'Observation not found' });
    }

    res.json({ success: true, data: { observation } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route POST /api/observations/:id/entries
 * Add a single observation entry into observations[].
 */
const addEntry = async (req, res, next) => {
  try {
    const entry = normalizeObservationEntry(req.body);
    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);

    const observation = await Observation.findOneAndUpdate(
      filter,
      { $push: { observations: entry } },
      { new: true, runValidators: true }
    ).lean();

    if (!observation) {
      return res.status(404).json({ success: false, message: 'Observation not found' });
    }

    res.json({ success: true, data: { observation } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route GET /api/observations/search?patientId=...
 * Search/get observation by patientId.
 */
const searchByPatientId = async (req, res, next) => {
  try {
    const filter = { patientId: new mongoose.Types.ObjectId(String(req.query.patientId)) };
    mergeHospitalFilter(req, filter);
    const observation = await Observation.findOne(filter).lean();

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { observation: observation || null },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @route DELETE /api/observations/:id
 */
const remove = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);
    const observation = await Observation.findOneAndDelete(filter).lean();
    if (!observation) {
      return res.status(404).json({ success: false, message: 'Observation not found' });
    }

    res.json({ success: true, message: 'Observation deleted successfully' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  create,
  update,
  addEntry,
  searchByPatientId,
  remove,
};
