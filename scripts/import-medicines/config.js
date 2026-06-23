/**
 * Configuration for the medicine bulk importer.
 * Edit this file to match your Excel file's column headers — the import logic
 * never needs to change.
 */

/**
 * Maps each Medicine schema field → the EXACT column header text in the Excel file.
 * Header matching is case-insensitive and whitespace-trimmed (see import script).
 *
 * `value` and `unit` are NOT mapped here — they are parsed from the Qty column
 * (see QTY_COLUMN), e.g. "20 mg" → value "20", unit "mg".
 */
const FIELD_MAPPING = {
  medicineName: "Product Name",
  /** Optional — if the column is missing, DEFAULT_TYPE is used. */
  type: "Type",
};

/** Excel column containing combined quantity, e.g. "20 mg", "500", "ml". */
const QTY_COLUMN = "Qty";

/** Used when the Type column is missing or empty. */
const DEFAULT_TYPE = "General";

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
  QTY_COLUMN,
  DEFAULT_TYPE,
  DEFAULT_BATCH_SIZE,
  DEFAULT_SHEET,
  PROGRESS_EVERY,
};
