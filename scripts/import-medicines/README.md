# Medicine Bulk Importer

Bulk-import medicines from an Excel `.xlsx` file into MongoDB (`Medicine` collection),
built for large files (10k–100k+ rows) using a streaming reader and batched inserts.

## Files
- `import-medicines.js` — the importer (CLI).
- `config.js` — editable column mapping + defaults (change Excel headers here, not the code).

## Setup
Requires `exceljs` (already added to the project). On a fresh machine:
```bash
npm install
```
The script reuses the project's `MONGODB_URI` from `.env` via `src/config/db.js`.

## Usage
```bash
node scripts/import-medicines/import-medicines.js --file=/path/to/medicines.xlsx
```
Options:
| Flag | Default | Meaning |
|------|---------|---------|
| `--file=` | (required) | Path to the `.xlsx` file |
| `--batch=` | `1000` | Rows per `insertMany` flush |
| `--sheet=` | first sheet | Worksheet name to read |
| `--dry-run` | off | Parse/validate/dedupe + connect, but **no DB writes** |

Examples:
```bash
node scripts/import-medicines/import-medicines.js --file=meds.xlsx --batch=2000 --sheet="Sheet1"
node scripts/import-medicines/import-medicines.js --file=meds.xlsx --dry-run
```

## Column mapping
Edit `config.js` — map each schema field to your Excel column header (case-insensitive):
```js
const FIELD_MAPPING = {
  medicineName: "Medicine Name",
  type: "Type",
  unit: "Unit",
};
```
If a mapped column is missing from the file, the importer stops with a clear error
listing what it found vs. what it expected.

## Behaviour
- **Streaming**: reads row-by-row (low memory) — does not load the whole file.
- **Total/%/ETA**: a fast first pass counts rows so progress shows `Processed: N / TOTAL (P%)` + ETA.
- **Duplicates**: detected by `medicineName` (case-insensitive) against existing DB rows
  **and** earlier rows in the same file; duplicates are skipped and counted.
- **Validation**: rows missing any required field (`medicineName`/`type`/`unit`) are logged
  with row number + reason and counted as *failed* — they never stop the run.
- **Empty rows** (all three blank) are counted as *skipped*.
- **Batched inserts** via `insertMany({ ordered: false })` — a bad doc in a batch doesn't abort it.

## Sample output
```
[ImportMedicines] Reading file... /path/medicines.xlsx
[ImportMedicines] Total Rows: 52000
[ImportMedicines] Processed: 1000 / 52000 (1.9%) | imported 980 · duplicate 12 · skipped 3 · failed 5 | ETA 1m 12s
...
[ImportMedicines] ===== Import complete =====
[ImportMedicines] Imported       : 51120
[ImportMedicines] Duplicates     : 800
[ImportMedicines] Skipped (empty): 30
[ImportMedicines] Failed         : 50
[ImportMedicines] Time taken     : 1m 20s
```

## Tip
Run `--dry-run` first on a new file to verify the mapping and see the counts before writing.
