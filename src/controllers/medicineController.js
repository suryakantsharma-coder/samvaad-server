const Medicine = require('../models/medicine.model');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive collation. Combined with the `{ medicineName: 1 }` collation
 * index on the Medicine model, the prefix RANGE query below runs as an indexed
 * range scan (no full collection scan) and is case-insensitive.
 */
const NAME_CI_COLLATION = { locale: 'en', strength: 2 };

/**
 * Prefix (starts-with) filter on medicineName ONLY.
 * Uses a range [term, term + ￿) instead of a regex so it can use the
 * collation index. ￿ is the highest BMP code point, so it bounds any
 * string that starts with `term`. Returns {} for an empty term (browse all).
 * @param {string} q
 */
function buildNamePrefixFilter(q) {
  const term = (q || '').trim();
  if (!term) return {};
  return { medicineName: { $gte: term, $lt: `${term}￿` } };
}

/**
 * @route GET /api/medicines
 * Query: page, limit, optional type (case-insensitive substring match on medicine `type`).
 */
const getAll = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const filter = {};
    const typeQ = (req.query.type || '').trim();
    if (typeQ) {
      filter.type = { $regex: escapeRegex(typeQ), $options: 'i' };
    }

    const [medicines, total] = await Promise.all([
      Medicine.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Medicine.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        medicines,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @route GET /api/medicines/search?q=...
 * Prefix (starts-with) search on medicineName ONLY — case-insensitive.
 * Index-backed (collation range scan); does NOT search type/unit or any other field.
 */
const search = async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const filter = buildNamePrefixFilter(q);
    // Sort by medicineName so the collation index serves BOTH range + sort.
    const [medicines, total] = await Promise.all([
      Medicine.find(filter)
        .collation(NAME_CI_COLLATION)
        .sort({ medicineName: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Medicine.countDocuments(filter).collation(NAME_CI_COLLATION),
    ]);

    res.json({
      success: true,
      data: {
        medicines,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @route GET /api/medicines/:id
 */
const getById = async (req, res, next) => {
  try {
    const medicine = await Medicine.findById(req.params.id).lean();
    if (!medicine) {
      return res.status(404).json({ success: false, message: 'Medicine not found' });
    }
    res.json({ success: true, data: { medicine } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route POST /api/medicines
 */
const create = async (req, res, next) => {
  try {
    const { medicineName, type, unit } = req.body;
    const medicine = await Medicine.create({
      medicineName: String(medicineName).trim(),
      type: String(type).trim(),
      unit: String(unit).trim(),
    });
    res.status(201).json({ success: true, data: { medicine: medicine.toObject() } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route PATCH /api/medicines/:id
 */
const update = async (req, res, next) => {
  try {
    const updateData = {};
    if (req.body.medicineName !== undefined) updateData.medicineName = String(req.body.medicineName).trim();
    if (req.body.type !== undefined) updateData.type = String(req.body.type).trim();
    if (req.body.unit !== undefined) updateData.unit = String(req.body.unit).trim();

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one of: medicineName, type, unit',
      });
    }

    const medicine = await Medicine.findByIdAndUpdate(req.params.id, { $set: updateData }, {
      new: true,
      runValidators: true,
    }).lean();

    if (!medicine) {
      return res.status(404).json({ success: false, message: 'Medicine not found' });
    }
    res.json({ success: true, data: { medicine } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route DELETE /api/medicines/:id
 */
const remove = async (req, res, next) => {
  try {
    const medicine = await Medicine.findByIdAndDelete(req.params.id);
    if (!medicine) {
      return res.status(404).json({ success: false, message: 'Medicine not found' });
    }
    res.json({ success: true, message: 'Medicine deleted successfully' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  search,
  getById,
  create,
  update,
  remove,
};
