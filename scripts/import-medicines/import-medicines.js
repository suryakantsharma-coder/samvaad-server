#!/usr/bin/env node
/**
 * Bulk import medicines from an Excel (.xlsx) file into MongoDB.
 *
 * Reuses the project's existing patterns:
 *   - DB connection:  src/config/db.js  (connectDB + env.MONGODB_URI)
 *   - Model:          src/models/medicine.model.js  (Medicine)
 *
 * Designed for VERY large files (10k–100k+ rows):
 *   - Reads the sheet with exceljs's STREAMING reader (row-by-row, low memory).
 *   - Inserts in batches via insertMany({ ordered: false }).
 *   - Duplicates are detected with an in-memory Set of existing medicine names
 *     (one query up front) — no per-row DB lookups.
 *
 * Flow:
 *   1. Parse CLI args + validate the file.
 *   2. Connect to MongoDB (reuse connectDB).
 *   3. Preload existing medicine names → Set (for duplicate detection).
 *   4. Pass 1: stream the sheet just to COUNT data rows (for total + %).
 *   5. Pass 2: stream the sheet, map columns, validate, dedupe, batch-insert,
 *      printing live progress + ETA.
 *   6. Print a final summary and exit.
 *
 * Usage:
 *   node scripts/import-medicines/import-medicines.js --file=/path/to/medicines.xlsx
 *   node scripts/import-medicines/import-medicines.js --file=meds.xlsx --batch=2000 --sheet="Sheet1"
 *   node scripts/import-medicines/import-medicines.js --file=meds.xlsx --dry-run
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const mongoose = require("mongoose");

// Reuse existing project infrastructure.
const connectDB = require("../../src/config/db");
const Medicine = require("../../src/models/medicine.model");
const {
  FIELD_MAPPING,
  QTY_COLUMN,
  DEFAULT_TYPE,
  DEFAULT_BATCH_SIZE,
  DEFAULT_SHEET,
  PROGRESS_EVERY,
} = require("./config");

const LOG = "[ImportMedicines]";

// ─── CLI args ────────────────────────────────────────────────────────────────

/** Minimal --key=value parser. Returns { file, batch, sheet, dryRun }. */
function parseArgs(argv) {
  const out = {
    file: null,
    batch: DEFAULT_BATCH_SIZE,
    sheet: DEFAULT_SHEET,
    dryRun: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--file=")) out.file = arg.slice(7);
    else if (arg.startsWith("--batch=")) {
      const n = parseInt(arg.slice(8), 10);
      if (Number.isFinite(n) && n > 0) out.batch = n;
    } else if (arg.startsWith("--sheet=")) out.sheet = arg.slice(8);
  }
  return out;
}

// ─── Cell / header helpers ─────────────────────────────────────────────────────

/** Coerce any exceljs cell value (string, number, rich text, formula, …) to trimmed text. */
function cellText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (value.result != null) return String(value.result).trim();
    if (Array.isArray(value.richText)) {
      return value.richText
        .map((r) => (r && r.text) || "")
        .join("")
        .trim();
    }
    if (typeof value.hyperlink === "string") return value.hyperlink.trim();
  }
  return String(value).trim();
}

/** Normalised key for case-insensitive duplicate / header matching. */
function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

/**
 * Strip leading category breadcrumb from medicine names.
 * e.g. "Home > Stomach Care > Indigestion > Crocin 500mg Tablet" → "Crocin 500mg Tablet"
 */
function stripCategoryPrefix(name) {
  const parts = name.split(">");
  return parts[parts.length - 1].trim();
}

/** Common dose / volume units (case-insensitive). */
const KNOWN_UNIT = /^(mcg|mg|iu|ml|gm|g|kg|l|units?|tabs?|caps?)$/i;

function normalizeUnit(u) {
  const raw = String(u || "").trim().toLowerCase();
  if (raw === "iu") return "IU";
  if (raw === "g") return "gm";
  if (raw === "l") return "ml";
  return raw;
}

/**
 * Parse the Qty cell into { value, unit } for MongoDB.
 *
 * Rules:
 *   "20 mg"  → { value: "20", unit: "mg" }
 *   "20"     → { value: "20", unit: null }
 *   "mg"     → { value: "0",  unit: "mg" }
 *   ""       → { value: null, unit: null }
 *   non-numeric text → { value: "0", unit: null }
 *
 * @param {string|number|null|undefined} raw
 * @returns {{ value: string | null, unit: string | null }}
 */
function parseQtyField(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { value: null, unit: null };

  // Number + optional unit (e.g. "20 mg", "500gm", "10.5 ml")
  const numWithUnit = s.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z][a-zA-Z0-9/%.\-]*)\s*$/);
  if (numWithUnit) {
    return {
      value: numWithUnit[1],
      unit: normalizeUnit(numWithUnit[2]),
    };
  }

  // Number only
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    return { value: s, unit: null };
  }

  // Known unit only, no number → value 0
  if (KNOWN_UNIT.test(s)) {
    return { value: "0", unit: normalizeUnit(s) };
  }

  // Unrecognised text — no number, no known unit
  return { value: "0", unit: null };
}

/**
 * Build { field: columnIndex } from the header row using FIELD_MAPPING.
 * exceljs row.values is 1-indexed (index 0 is empty). Matching is case-insensitive.
 * Throws (fatal) if any mapped column is missing — the file would be unusable.
 * @param {Array} headerValues row.values from the header row
 * @returns {Record<string, number>}
 */
function buildHeaderIndex(headerValues) {
  const headerByNorm = new Map(); // normalised header text -> column index
  for (let i = 1; i < headerValues.length; i += 1) {
    const text = cellText(headerValues[i]);
    if (text) headerByNorm.set(norm(text), i);
  }
  const fieldToCol = {};
  const missing = [];
  const optionalFields = new Set(["type"]);

  for (const [field, header] of Object.entries(FIELD_MAPPING)) {
    const idx = headerByNorm.get(norm(header));
    if (idx == null) {
      if (optionalFields.has(field)) fieldToCol[field] = null;
      else missing.push(`${field} → "${header}"`);
    } else {
      fieldToCol[field] = idx;
    }
  }

  fieldToCol._qty = headerByNorm.get(norm(QTY_COLUMN)) ?? null;
  if (fieldToCol._qty == null) {
    missing.push(`Qty column → "${QTY_COLUMN}"`);
  }
  if (missing.length) {
    throw new Error(
      `Excel is missing mapped column(s): ${missing.join(", ")}. ` +
        `Found headers: ${[...headerByNorm.keys()].join(", ") || "(none)"}. ` +
        `Fix FIELD_MAPPING in scripts/import-medicines/config.js or the Excel headers.`,
    );
  }
  return fieldToCol;
}

// ─── Streaming helpers ─────────────────────────────────────────────────────────

/** Open a streaming reader and yield the target worksheet (by name, or the first). */
async function getWorksheetStream(filePath, sheetName, onWorksheet) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: "cache",
    worksheets: "emit",
  });
  let handled = false;
  for await (const worksheet of workbook) {
    if (handled) continue; // drain remaining sheets so the stream closes cleanly
    if (sheetName && norm(worksheet.name) !== norm(sheetName)) continue;
    handled = true;
    await onWorksheet(worksheet);
  }
  if (!handled) {
    throw new Error(
      sheetName
        ? `Worksheet "${sheetName}" not found in the file.`
        : "No worksheet found in the file.",
    );
  }
}

/** Pass 1 — count data rows (everything after the header row). */
async function countDataRows(filePath, sheetName) {
  let dataRows = 0;
  await getWorksheetStream(filePath, sheetName, async (worksheet) => {
    let isFirst = true;
    for await (const _row of worksheet) {
      if (isFirst) {
        isFirst = false; // header row — not counted
        continue;
      }
      dataRows += 1;
    }
  });
  return dataRows;
}

// ─── Progress ──────────────────────────────────────────────────────────────────

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function printProgress(stats, total, startedAt) {
  const pct = total > 0 ? ((stats.processed / total) * 100).toFixed(1) : "0.0";
  const elapsed = Date.now() - startedAt;
  const rate = stats.processed / (elapsed / 1000 || 1); // rows/sec
  const remaining =
    total > 0 && rate > 0 ? ((total - stats.processed) / rate) * 1000 : NaN;
  console.log(
    `${LOG} Processed: ${stats.processed} / ${total} (${pct}%) | ` +
      `imported ${stats.imported} · duplicate ${stats.duplicates} · ` +
      `skipped ${stats.skipped} · failed ${stats.failed} | ETA ${fmtDuration(remaining)}`,
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (!args.file) {
    console.error(
      `${LOG} Missing --file. Usage: node scripts/import-medicines/import-medicines.js --file=/path/to/medicines.xlsx`,
    );
    process.exit(1);
  }
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`${LOG} File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`${LOG} Reading file... ${filePath}`);
  console.log(
    `${LOG} Batch size: ${args.batch}${args.dryRun ? " | DRY RUN (no writes)" : ""}`,
  );

  // Connect (reuses env.MONGODB_URI). connectDB exits the process on failure.
  await connectDB();

  // Preload existing medicine names for duplicate detection (case-insensitive).
  console.log(`${LOG} Loading existing medicine names for duplicate check...`);
  const existing = new Set();
  const cursor = Medicine.find({}, { medicineName: 1, _id: 0 }).lean().cursor();
  for await (const doc of cursor) {
    if (doc.medicineName) existing.add(norm(doc.medicineName));
  }
  console.log(`${LOG} Existing medicines in DB: ${existing.size}`);

  // Pass 1 — total rows (so we can show % + ETA).
  const total = await countDataRows(filePath, args.sheet);
  console.log(`${LOG} Total Rows: ${total}`);
  if (total === 0) {
    console.log(`${LOG} Nothing to import.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const stats = {
    processed: 0,
    imported: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
  };
  const startedAt = Date.now();
  let batch = [];

  /** Flush the current batch with insertMany (ordered:false → partial failures don't abort). */
  async function flushBatch() {
    if (batch.length === 0) return;
    const docs = batch;
    batch = [];
    if (args.dryRun) {
      stats.imported += docs.length;
      return;
    }
    try {
      const inserted = await Medicine.insertMany(docs, { ordered: false });
      stats.imported += inserted.length;
    } catch (err) {
      // ordered:false → some docs may still have inserted.
      const insertedCount =
        (err && (err.insertedDocs?.length ?? err.result?.nInserted)) || 0;
      stats.imported += insertedCount;
      const failedCount = docs.length - insertedCount;
      stats.failed += failedCount;
      console.error(
        `${LOG} Batch insert error (${failedCount} failed): ${err.message}`,
      );
    }
  }

  // Pass 2 — stream, map, validate, dedupe, batch-insert.
  await getWorksheetStream(filePath, args.sheet, async (worksheet) => {
    let fieldToCol = null;
    let rowNumber = 0;

    for await (const row of worksheet) {
      rowNumber += 1;

      // First row = header → build the field→column map once.
      if (fieldToCol === null) {
        fieldToCol = buildHeaderIndex(row.values || []);
        continue;
      }

      stats.processed += 1;
      const values = row.values || [];

      const rawName = cellText(values[fieldToCol.medicineName]);
      const medicineName = rawName ? stripCategoryPrefix(rawName) : "";
      const typeCol =
        fieldToCol.type != null ? cellText(values[fieldToCol.type]) : "";
      const type = typeCol || DEFAULT_TYPE;

      const rawQty =
        fieldToCol._qty != null ? cellText(values[fieldToCol._qty]) : "";
      const { value, unit } = parseQtyField(rawQty);

      // Fully empty row → skip silently.
      if (!medicineName && !rawQty && !rawName) {
        stats.skipped += 1;
      } else {
        // Only medicineName is required; type falls back to DEFAULT_TYPE.
        const missing = [];
        if (!medicineName) missing.push("medicineName");

        if (missing.length) {
          stats.failed += 1;
          console.error(
            `${LOG} Row ${rowNumber}: skipped — missing ${missing.join(", ")}`,
          );
        } else {
          const key = norm(medicineName);
          if (existing.has(key)) {
            // Duplicate against DB or an earlier row in this file.
            stats.duplicates += 1;
          } else {
            existing.add(key); // prevent in-file duplicates too
            batch.push({ medicineName, type, value, unit });
            if (batch.length >= args.batch) await flushBatch();
          }
        }
      }

      if (stats.processed % PROGRESS_EVERY === 0)
        printProgress(stats, total, startedAt);
    }
  });

  await flushBatch(); // final partial batch
  printProgress(stats, total, startedAt);

  // ─── Summary ─────────────────────────────────────────────────────────────
  const elapsed = Date.now() - startedAt;
  console.log(`\n${LOG} ===== Import complete =====`);
  console.log(`${LOG} Total rows     : ${total}`);
  console.log(`${LOG} Processed      : ${stats.processed}`);
  console.log(
    `${LOG} Imported       : ${stats.imported}${args.dryRun ? " (dry run)" : ""}`,
  );
  console.log(`${LOG} Duplicates     : ${stats.duplicates}`);
  console.log(`${LOG} Skipped (empty): ${stats.skipped}`);
  console.log(`${LOG} Failed         : ${stats.failed}`);
  console.log(`${LOG} Time taken     : ${fmtDuration(elapsed)}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`${LOG} Fatal error:`, err && err.message ? err.message : err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
