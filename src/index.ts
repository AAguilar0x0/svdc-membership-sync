import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import 'dotenv/config'

import { readMemberCsv } from './csv.ts'
import { matchRow, type MatchResult, type MatchStatus } from './match.ts'
import {
  activeChartsOnly,
  buildOdIndex,
  loadActiveDiscountSubs,
  loadActiveDiscountSubsFromFixture,
  loadOdPatients,
  loadOdPatientsFromFixture,
  type ActiveSubs,
} from './od.ts'
import { PLAN_VERDICT_LABELS, type PlanVerdict } from './plans.ts'
import { checkPlans, summarize, summarizePlans, writeReport, type ResolvedRow } from './report.ts'

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
      'subs-fixture': { type: 'string' },
      'include-deleted': { type: 'boolean', default: false },
      'active-only': { type: 'boolean', default: false },
      'active-charts-only': { type: 'boolean', default: false },
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

  // Against a patient fixture with no subscription fixture the plan check goes dark rather
  // than reporting every member as unenrolled, which is a wrong answer that looks right.
  const planCheckEnabled = values.fixture === undefined || values['subs-fixture'] !== undefined
  const subs: ActiveSubs = !planCheckEnabled
    ? { byPatNum: new Map(), multipleActive: [] }
    : values['subs-fixture'] === undefined
      ? await loadActiveDiscountSubs(odDbUrl!)
      : await loadActiveDiscountSubsFromFixture(resolve(values['subs-fixture']))

  if (planCheckEnabled) console.log(`Loaded ${subs.byPatNum.size} active discount subscription(s).`)

  // Match twice — every chart, and active charts only. Both are cheap, and the question
  // asked of this tool is not "which is right" but "how much difference does it make",
  // which needs the two splits side by side rather than one of them and an assertion.
  const activePatients = activeChartsOnly(patients)
  const allIndex = buildOdIndex(patients)
  const activeIndex = buildOdIndex(activePatients)
  const allResults = rows.map((row) => matchRow(row, allIndex))
  const activeResults = rows.map((row) => matchRow(row, activeIndex))
  printChartFilterComparison(allResults, activeResults, patients.length, activePatients.length)

  const results = values['active-charts-only'] ? activeResults : allResults

  const outDir = resolve(values.out)
  const { resolved, duplicateGroups, checks } = writeReport(results, outDir, new Map(), subs, planCheckEnabled)
  printSummary(resolved, duplicateGroups, patients.length, outDir)
  if (checks) printPlanSummary(checks)
}

const printUsage = () => {
  console.log(`
svdc-membership-sync — match membership CSV rows to Open Dental patient numbers

  pnpm match <members.csv> [options]

Options
  --out <dir>          where to write the report (default: out)
  --fixture <file>     match against a JSON patient fixture instead of the DB
                       (offline dry run — see sample/od-patients.sample.json)
  --subs-fixture <f>   discountplansub fixture to run the plan check offline
                       (see sample/od-discount-subs.sample.json). Against the DB the
                       plan check always runs; with --fixture and no subs it goes dark
                       rather than reporting every member as unenrolled.
  --active-only        only process rows whose Active column is truthy (CSV side)
  --active-charts-only only consider OD patients with PatStatus = Patient (OD side).
                       Both splits are printed either way; this picks which one is written
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

/**
 * Both candidate sets, side by side. Restricting to active charts can only ever move rows
 * out of matched — the question is how many, and whether the ones it drops were matches
 * anybody wanted. On this practice's data that is a handful; on a roster that has drifted
 * for years it might not be, which is why it is measured rather than assumed.
 */
const printChartFilterComparison = (
  allResults: MatchResult[],
  activeResults: MatchResult[],
  patientCount: number,
  activePatientCount: number,
) => {
  const count = (results: MatchResult[], status: MatchStatus) => results.filter((r) => r.status === status).length
  const delta = (n: number) => (n === 0 ? '' : n > 0 ? `  (+${n})` : `  (${n})`)
  const line = (status: MatchStatus, label: string) => {
    const before = count(allResults, status)
    const after = count(activeResults, status)
    return `  ${label.padEnd(20)}${String(before).padStart(4)} →${String(after).padStart(5)}${delta(after - before)}`
  }

  console.log(`
── Active charts only? ──────────────────────────
  candidate patients  ${String(patientCount).padStart(4)} →${String(activePatientCount).padStart(5)}${delta(activePatientCount - patientCount)}

${line('matched', 'matched')}
${line('ambiguous', 'ambiguous')}
${line('not_found', 'not found')}

  Left column is every chart except Deleted; right is PatStatus = Patient only.
  Rows that stop matching are members sitting on an inactive or archived chart — a
  real finding either way, but one the chart-status column can no longer explain once
  the candidate is filtered out. ${'--active-charts-only'} picks the right-hand run.`)
}

/**
 * The plan check, read-only. `correct` means no action — we do not touch effective dates
 * on people who are already right — and everything that is not a clean instruction is
 * listed separately, so the actionable number is never inflated by rows nobody has read.
 */
const printPlanSummary = (checks: ReturnType<typeof checkPlans>) => {
  const summary = summarizePlans(checks)
  const line = (verdict: PlanVerdict) => `  ${PLAN_VERDICT_LABELS[verdict].padEnd(18)}${summary[verdict]}`

  console.log(`── Discount plan check ──────────────────────────
${line('correct')}
${line('wrong_plan')}
${line('no_sub')}

  needs a human
${line('unmapped_od_plan')}
${line('conflict')}
${line('unknown_csv_plan')}
${line('ineligible')}

  actionable          ${summary.actionable}  (wrong plan + no sub, conflicts excluded)`)

  if (summary.unknownPlanStrings.length > 0) {
    console.log(`
  ⚠ ${summary.unknownPlanStrings.length} plan string(s) not in the mapping table — these rows
    cannot be checked, and the table needs updating before this run means anything:`)
    for (const value of summary.unknownPlanStrings) console.log(`    "${value}"`)
  }

  console.log('\n  Read-only. Nothing about a plan has been written to Open Dental.\n')
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
