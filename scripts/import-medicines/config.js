/**
 * Configuration for the medicine bulk importer.
 * Edit this file to match your Excel file's column headers — the import logic
 * never needs to change.
 */

/**
 * Maps each Medicine schema field → the EXACT column header text in the Excel file.
 * Header matching is case-insensitive and whitespace-trimmed (see import script),
 * but keep these close to the real headers for clarity.
 */
const FIELD_MAPPING = {
  medicineName: "name",
  type: "Product Form",
  unit: "Qty",
};

/** How many documents to accumulate before each insertMany flush. Override with --batch=. */
const DEFAULT_BATCH_SIZE = 1000;

/**
 * Which worksheet to read. `null` = the first worksheet in the workbook.
 * Override with --sheet="Sheet1".
 */
const DEFAULT_SHEET = null;

/** Print a progress line every N processed rows (also prints on every batch flush). */
const PROGRESS_EVERY = 1000;

module.exports = {
  FIELD_MAPPING,
  DEFAULT_BATCH_SIZE,
  DEFAULT_SHEET,
  PROGRESS_EVERY,
};
