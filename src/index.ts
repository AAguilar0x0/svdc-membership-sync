import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import 'dotenv/config'

import { readMemberCsv } from './csv.ts'
import { matchRow } from './match.ts'
import { buildOdIndex, loadOdPatients, loadOdPatientsFromFixture } from './od.ts'
import { summarize, writeReport, type ResolvedRow } from './report.ts'

/**
 * Give every row of the membership CSV an Open Dental PatNum.
 *
 * Read-only: one SELECT against the OD patient table, no writes anywhere. Enrolling
 * the matched patients is a separate step that runs only once this report is approved.
 */
const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'out' },
      fixture: { type: 'string' },
      'include-deleted': { type: 'boolean', default: false },
      'active-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const csvPath = positionals.at(0)
  if (values.help || csvPath === undefined) {
    printUsage()
    process.exit(values.help ? 0 : 1)
  }

  const resolvedCsv = resolve(csvPath)
  if (!existsSync(resolvedCsv)) throw new Error(`CSV not found: ${resolvedCsv}`)

  const odDbUrl = process.env.OD_DB_URL
  if (!odDbUrl && values.fixture === undefined) {
    throw new Error('OD_DB_URL is not set. Copy .env.example to .env and fill it in, or pass --fixture.')
  }

  // Collect source data
  const allRows = readMemberCsv(resolvedCsv)
  const rows = values['active-only'] ? allRows.filter((row) => row.isActive) : allRows
  if (rows.length === 0) throw new Error('No usable rows in the CSV.')

  console.log(`Read ${allRows.length} CSV row(s)${values['active-only'] ? `, ${rows.length} active` : ''}.`)
  console.log(
    values.fixture === undefined
      ? 'Reading Open Dental patients (SELECT only)…'
      : `Reading patient fixture ${values.fixture} (no DB connection)…`,
  )

  const patients =
    values.fixture === undefined
      ? await loadOdPatients(odDbUrl!, values['include-deleted'])
      : await loadOdPatientsFromFixture(resolve(values.fixture))
  console.log(`Loaded ${patients.length} OD patient record(s).`)

  // Match, then report — nothing is persisted anywhere
  const index = buildOdIndex(patients)
  const results = rows.map((row) => matchRow(row, index))

  const outDir = resolve(values.out)
  const { resolved, duplicateGroups } = writeReport(results, outDir)
  printSummary(resolved, duplicateGroups, patients.length, outDir)
}

const printUsage = () => {
  console.log(`
svdc-membership-sync — match membership CSV rows to Open Dental patient numbers

  pnpm match <members.csv> [options]

Options
  --out <dir>          where to write the report (default: out)
  --fixture <file>     match against a JSON patient fixture instead of the DB
                       (offline dry run — see sample/od-patients.sample.json)
  --active-only        only process rows whose Active column is truthy
  --include-deleted    also consider OD patients with PatStatus = Deleted
  -h, --help           show this

Requires OD_DB_URL in .env (see .env.example). Read-only — never writes to OD.
`)
}

const printSummary = (
  resolved: ResolvedRow[],
  duplicateGroups: Map<number, string>,
  odPatientCount: number,
  outDir: string,
) => {
  const summary = summarize(resolved, duplicateGroups)
  const pct = (n: number) => `${((n / summary.total) * 100).toFixed(1)}%`

  console.log(`
── Summary ──────────────────────────────────────
  CSV rows            ${summary.total}
  OD patients read    ${odPatientCount}

  matched             ${summary.matched}  (${pct(summary.matched)})
  ambiguous           ${summary.ambiguous}  (${pct(summary.ambiguous)})
  not found           ${summary.not_found}  (${pct(summary.not_found)})

  distinct PatNums    ${summary.distinctPatients}
  duplicate CSV rows  ${summary.duplicateRows}`)

  if (summary.collidingPatNums.length > 0) {
    console.log(`\n  ⚠ ${summary.collidingPatNums.length} PatNum(s) matched by more than one CSV row:`)
    for (const [patNum, uses] of summary.collidingPatNums.slice(0, 20)) {
      console.log(`    PatNum ${patNum} ← ${uses} rows`)
    }
  }

  console.log(`
  Wrote ${outDir}/review.csv, matched.csv, ambiguous.csv, not-found.csv

  A sizeable "not found" bucket is expected, not a bug — the membership roster and
  the patient list are maintained separately, so surfacing that gap is part of the
  point. Nothing has been written to Open Dental. Review these files before enrolling.
`)
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
