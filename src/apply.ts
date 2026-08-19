import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parse } from 'csv-parse/sync'
import 'dotenv/config'

import { readMemberCsv } from './csv.ts'
import { matchRow } from './match.ts'
import { OdApi, loadOdApiConfig, type OdApiOutcome } from './od-api.ts'
import {
  buildOdIndex,
  loadActiveDiscountSubs,
  loadOdPatients,
  openOdConnection,
  readActiveSubsForPatient,
  type ActiveSub,
} from './od.ts'
import { DEFAULT_PLAN_MAP_PATH, loadPlanMap } from './plans.ts'
import { checkPlans, groupDuplicates, resolveRows, summarizePlans, toCsv, type Decisions } from './report.ts'
import { describeChange, planChanges, sortChanges, type PlannedChange } from './changeset.ts'

/**
 * The write phase. Drops and plan migrations against live Open Dental.
 *
 * Dry run by default: it prints and writes the exact change set — one line per patient,
 * `current plan → target → action` — and stops. `--apply` is the only thing that writes,
 * and it will not start without `--expect <n>` matching the number of changes that were
 * signed off, so a change set that has drifted since sign-off fails instead of running.
 *
 * Structure, per patient, in this order every time:
 *
 *   1. re-read the current subs **in SQL**, not from the report and not from the API
 *   2. re-check them against what the plan assumed; anything that moved is skipped, never guessed
 *   3. write — one `PUT` for a drop, a `POST`+`PUT` pair for a migration
 *   4. re-read in SQL and verify the end state is exactly one sub, on the right plan
 *   5. append the whole thing to a per-patient JSONL log, which is also the resume index
 *
 * Verification is SQL because the API cannot do it: `GET /discountplansubs?PatNum=` returns
 * a single object, so it can neither prove which sub is current nor reveal a double-subscribe.
 */

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'out' },
      'plan-map': { type: 'string', default: DEFAULT_PLAN_MAP_PATH },
      decisions: { type: 'string' },
      only: { type: 'string' },
      limit: { type: 'string' },
      apply: { type: 'boolean', default: false },
      expect: { type: 'string' },
      order: { type: 'string', default: 'add-then-term' },
      'term-date': { type: 'string' },
      'include-inactive-charts': { type: 'boolean', default: false },
      'stop-after-failures': { type: 'string', default: '3' },
      log: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const csvPath = positionals.at(0)
  if (values.help || csvPath === undefined) {
    printUsage()
    process.exit(values.help ? 0 : 1)
  }

  // ── Collect source data ───────────────────────────────────────────────────────
  const odDbUrl = process.env.OD_DB_URL
  if (!odDbUrl) throw new Error('OD_DB_URL is not set. The write phase reads and verifies over SQL.')

  const resolvedCsv = resolve(csvPath)
  if (!existsSync(resolvedCsv)) throw new Error(`CSV not found: ${resolvedCsv}`)

  const outDir = resolve(values.out)
  const logPath = resolve(values.log ?? join(outDir, 'apply-log.jsonl'))
  const termDate = values['term-date'] ?? today()
  const order = values.order
  if (order !== 'add-then-term' && order !== 'term-then-add') {
    throw new Error(`--order must be add-then-term or term-then-add — got "${order}".`)
  }

  const rows = readMemberCsv(resolvedCsv)
  const planMap = loadPlanMap(resolve(values['plan-map']))
  const patients = await loadOdPatients(odDbUrl)
  const subs = await loadActiveDiscountSubs(odDbUrl)
  const decisions = values.decisions === undefined ? new Map() : readDecisions(resolve(values.decisions))

  const index = buildOdIndex(patients)
  const resolved = resolveRows(rows.map((row) => matchRow(row, index)), decisions, groupDuplicates(rows))
  const checks = checkPlans(resolved, subs, planMap)

  console.log(`
── Source ───────────────────────────────────────
  CSV rows            ${rows.length}
  OD patients         ${patients.length}
  active subs         ${subs.byPatNum.size}
  plan mapping        ${planMap.entries.length} entries from ${values['plan-map']}${planMap.confirmed ? '' : '  ⚠ UNCONFIRMED'}
  human decisions     ${decisions.size}${values.decisions === undefined ? ' (none supplied)' : ` from ${values.decisions}`}`)

  // ── Negative assertions, before anything is planned ───────────────────────────
  if (!planMap.confirmed) {
    throw new Error(
      `${planMap.source} is still marked "confirmed": false. ` +
        'Nothing is written off a plan mapping nobody has checked against the real export.',
    )
  }

  // ── Compute the change set ────────────────────────────────────────────────────
  const planned = planChanges(resolved, checks, { includeInactiveCharts: values['include-inactive-charts'] })
  const only = values.only?.split(',').map((value) => value.trim()).filter(Boolean)
  const selected = only === undefined ? planned.changes : planned.changes.filter((c) => only.includes(c.action))
  const done = values.fresh ? new Map<number, string>() : readLog(logPath)
  const outstanding = sortChanges(selected).filter((change) => !isDone(done, change))
  const limit = values.limit === undefined ? outstanding.length : Number(values.limit)
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`--limit must be a non-negative integer — got "${values.limit}".`)
  }
  const batch = outstanding.slice(0, limit)

  printPlan(planned, selected, outstanding, batch, summarizePlans(checks), done.size)

  // ── Derived assertions, on the plan rather than on the data ───────────────────
  const patNums = new Set(batch.map((change) => change.patNum))
  if (patNums.size !== batch.length) throw new Error('A patient appears twice in the batch — refusing to write.')

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'changeset.csv'), toCsv(batch.map(toChangeRecord)))
  writeFileSync(join(outDir, 'changeset-held-back.csv'), toCsv(planned.heldBack.map(toHeldBackRecord)))
  console.log(`
  Wrote ${values.out}/changeset.csv (${batch.length} row(s)) and ${values.out}/changeset-held-back.csv
  (${planned.heldBack.length} row(s)). Both name patients — they are PHI, and out/ is gitignored.`)

  if (!values.apply) {
    console.log(`
  DRY RUN — nothing was written to Open Dental.

  To run this exact batch once it is signed off:
    pnpm apply ${csvPath} --apply --expect ${batch.length}${values.only ? ` --only ${values.only}` : ''}${values.limit ? ` --limit ${values.limit}` : ''}
`)
    return
  }

  if (values.expect === undefined) {
    throw new Error('--apply requires --expect <n>, the change count that was signed off. Run the dry run first.')
  }
  if (Number(values.expect) !== batch.length) {
    throw new Error(
      `--expect ${values.expect} but this batch is ${batch.length} change(s). ` +
        'The data moved since sign-off — re-run the dry run and get the new number agreed.',
    )
  }
  if (batch.length === 0) throw new Error('Nothing to do.')

  // ── Persist ───────────────────────────────────────────────────────────────────
  await execute(batch, {
    odDbUrl,
    logPath,
    termDate,
    order,
    stopAfterFailures: Number(values['stop-after-failures']),
  })
}

const today = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Reviewer decisions, read back out of the exported `review.csv`.
 *
 * Without this an apply run would re-derive every match from scratch and quietly overrule
 * the human: a row somebody rejected as "none of these" would match again and be written.
 */
const readDecisions = (path: string): Decisions => {
  const records = parse(readFileSync(path), { bom: true, columns: true, skip_empty_lines: true, trim: true }) as Record<
    string,
    string
  >[]

  const decisions: Decisions = new Map()
  for (const record of records) {
    if ((record['Resolved By'] ?? '') !== 'human') continue
    const rowNumber = Number(record['CSV Row'])
    if (!Number.isInteger(rowNumber)) continue
    const patNum = (record.PatNum ?? '').trim()
    decisions.set(rowNumber, { patNum: patNum === '' ? null : Number(patNum) })
  }
  return decisions
}

type LogRecord = {
  ts: string
  patNum: number
  action: string
  outcome: 'written' | 'skipped' | 'failed'
  note: string
  planned: { from: number | undefined; to: number | undefined }
  before: ActiveSub[]
  after: ActiveSub[]
  calls: OdApiOutcome[]
}

/**
 * The log is the resume index. A patient already written or deliberately skipped is not
 * touched again; a failure is left outstanding so a re-run picks it up, which is the
 * behaviour a mid-run failure needs — no guesswork about where it stopped.
 */
const readLog = (path: string) => {
  const done = new Map<number, string>()
  if (!existsSync(path)) return done

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = JSON.parse(line) as LogRecord
    if (record.outcome === 'failed') continue
    done.set(record.patNum, record.action)
  }
  return done
}

const isDone = (done: Map<number, string>, change: PlannedChange) => done.get(change.patNum) === change.action

const execute = async (
  batch: PlannedChange[],
  options: { odDbUrl: string; logPath: string; termDate: string; order: string; stopAfterFailures: number },
) => {
  const api = new OdApi(loadOdApiConfig())
  const connection = await openOdConnection(options.odDbUrl)
  const counts = { written: 0, skipped: 0, failed: 0 }
  let consecutiveFailures = 0

  console.log(`
── Applying ─────────────────────────────────────
  ${batch.length} patient(s), ordering ${options.order}, term date ${options.termDate}
  Log: ${options.logPath}
`)

  try {
    for (const [position, change] of batch.entries()) {
      const record = await applyOne(api, connection, change, options)
      appendFileSync(options.logPath, `${JSON.stringify(record)}\n`)
      counts[record.outcome] += 1

      console.log(
        `  [${position + 1}/${batch.length}] PatNum ${change.patNum}  ${change.action.padEnd(7)} ` +
          `${describeChange(change).padEnd(34)} ${record.outcome}${record.note ? ` — ${record.note}` : ''}`,
      )

      consecutiveFailures = record.outcome === 'failed' ? consecutiveFailures + 1 : 0
      if (consecutiveFailures >= options.stopAfterFailures) {
        throw new Error(
          `Stopping: ${consecutiveFailures} failures in a row. Everything up to here is in the log; ` +
            'fix the cause and re-run — completed patients are skipped automatically.',
        )
      }
    }
  } finally {
    await connection.end()
    console.log(`
  written ${counts.written} · skipped ${counts.skipped} · failed ${counts.failed}
  Every patient above was re-read in SQL before and after its write. Re-run the same
  command to pick up anything that failed; what succeeded will not be touched again.
`)
  }
}

/**
 * One patient. Re-read, re-check, write, re-read, verify.
 *
 * Every skip here is a case where the database no longer looks like the plan assumed. None
 * of them are resolved by guessing: the patient is left exactly as they are and the reason
 * goes in the log, because a stale plan is a reason to stop, not a reason to improvise.
 */
const applyOne = async (
  api: OdApi,
  connection: Awaited<ReturnType<typeof openOdConnection>>,
  change: PlannedChange,
  options: { termDate: string; order: string },
): Promise<LogRecord> => {
  // Pace first, then read. The read has to be the last thing that happens before the write,
  // or the wait itself is a window for the patient to change under us.
  await api.pace()
  const before = await readActiveSubsForPatient(connection, change.patNum)
  const calls: OdApiOutcome[] = []

  const finish = async (outcome: LogRecord['outcome'], note: string) => ({
    ts: new Date().toISOString(),
    patNum: change.patNum,
    action: change.action,
    outcome,
    note,
    planned: { from: change.currentPlanNum, to: change.targetPlanNum },
    before,
    after: outcome === 'skipped' ? before : await readActiveSubsForPatient(connection, change.patNum),
    calls,
  })

  if (before.length > 1) {
    return finish('skipped', `patient now has ${before.length} active subs — a human picks which one stays`)
  }

  const current = before.at(0)
  if (current !== undefined && change.currentPlanNum !== undefined && current.discountPlanNum !== change.currentPlanNum) {
    return finish('skipped', `now on plan ${current.discountPlanNum}, the plan assumed ${change.currentPlanNum}`)
  }

  if (change.action === 'drop') {
    if (current === undefined) return finish('skipped', 'no active sub left to term')
    calls.push(await api.term(current.discountSubNum, change.patNum, options.termDate))
    if (!calls.at(-1)!.ok) return finish('failed', describeFailure(calls.at(-1)!))

    const after = await readActiveSubsForPatient(connection, change.patNum)
    return after.length === 0
      ? finish('written', `termed ${options.termDate}`)
      : finish('failed', `PUT returned OK but ${after.length} active sub(s) remain`)
  }

  const target = change.targetPlanNum!
  if (current?.discountPlanNum === target) return finish('skipped', `already on plan ${target}`)

  // An `add` was planned for a patient with no subscription. If they have one now, somebody
  // enrolled them between the report and here, and the write this batch was signed off on
  // is not the write that would happen — that is a new report, not a silent replacement.
  if (change.action === 'add' && current !== undefined) {
    return finish('skipped', `picked up plan ${current.discountPlanNum} since the report — re-run the report`)
  }

  // The one genuine ordering decision, and the reason the local seeded OD exists. Add-first
  // means a failed second call leaves an overlap — visible in the read-back below, and
  // fixable — rather than a gap, which would leave a paying member on no plan at all.
  const steps =
    current === undefined
      ? ['add' as const]
      : options.order === 'term-then-add'
        ? ['term' as const, 'add' as const]
        : ['add' as const, 'term' as const]

  for (const step of steps) {
    calls.push(step === 'add' ? await api.add(change.patNum, target) : await api.term(current!.discountSubNum, change.patNum, options.termDate))
    const outcome = calls.at(-1)!
    if (!outcome.ok) {
      return finish('failed', `${step} failed after ${calls.length - 1} successful call(s): ${describeFailure(outcome)}`)
    }
  }

  const after = await readActiveSubsForPatient(connection, change.patNum)
  if (after.length === 1 && after[0]!.discountPlanNum === target) {
    return finish(
      'written',
      current !== undefined
        ? `moved to plan ${target}`
        : change.action === 'migrate'
          ? `no active sub at write time — added plan ${target} only`
          : `added plan ${target}`,
    )
  }
  return finish(
    'failed',
    `end state is ${after.length} active sub(s)${after.length ? ` on plan(s) ${after.map((s) => s.discountPlanNum).join(', ')}` : ''}, expected exactly plan ${target}`,
  )
}

const describeFailure = (outcome: OdApiOutcome) =>
  `${outcome.call.method} ${outcome.call.path} → HTTP ${outcome.status} ${JSON.stringify(outcome.response).slice(0, 200)}`

const toChangeRecord = (change: PlannedChange) => ({
  PatNum: change.patNum,
  'OD Name': change.patientName,
  'Chart Status': change.chartStatus,
  Action: change.action,
  'Current Plan': change.currentPlanNum ?? '',
  'Current Sub': change.currentSubNum ?? '',
  'Target Plan': change.targetPlanNum ?? '',
  Change: describeChange(change),
  'CSV Rows': change.rowNumbers.join(' '),
})

const toHeldBackRecord = (change: ReturnType<typeof planChanges>['heldBack'][number]) => ({
  ...toChangeRecord({ ...change, currentPlanNum: undefined, currentSubNum: undefined, targetPlanNum: undefined }),
  Change: '',
  Reason: change.reason,
})

const printPlan = (
  planned: ReturnType<typeof planChanges>,
  selected: PlannedChange[],
  outstanding: PlannedChange[],
  batch: PlannedChange[],
  planSummary: ReturnType<typeof summarizePlans>,
  alreadyDone: number,
) => {
  const count = (changes: PlannedChange[], action: string) => changes.filter((c) => c.action === action).length

  console.log(`
── Change set ───────────────────────────────────
  drop                ${count(planned.changes, 'drop')}   (cancelled memberships still holding a plan)
  add                 ${count(planned.changes, 'add')}   (matched, no active sub)
  migrate             ${count(planned.changes, 'migrate')}   (on the wrong plan — term + add, two calls)
  ─────────────────────────
  patients            ${planned.changes.length}
  held back           ${planned.heldBack.length}   (listed in changeset-held-back.csv)

  from ${planSummary.should_drop} should-drop, ${planSummary.no_sub} no-sub and ${planSummary.wrong_plan} wrong-plan row(s);
  fewer patients than rows because the export repeats people.

  selected            ${selected.length}
  already in the log  ${alreadyDone}
  outstanding         ${outstanding.length}
  this batch          ${batch.length}
`)

  for (const change of batch.slice(0, 25)) {
    console.log(
      `  PatNum ${String(change.patNum).padEnd(7)} ${change.patientName.padEnd(28).slice(0, 28)} ` +
        `${change.chartStatus.padEnd(10)} ${describeChange(change)}`,
    )
  }
  if (batch.length > 25) console.log(`  … and ${batch.length - 25} more — the full list is in changeset.csv`)
}

const printUsage = () => {
  console.log(`
svdc-membership-sync — apply the discount-plan change set to Open Dental

  pnpm apply <members.csv> [options]

Dry run by default. Prints and writes the change set, one line per patient, and stops.

Options
  --apply                    actually write. Requires --expect
  --expect <n>               the change count that was signed off; a mismatch aborts
  --only drop,add,migrate    restrict to these actions (drops first is the intended order)
  --limit <n>                only the first n patients — this is how the pilot is run
  --decisions <review.csv>   honour the reviewer's decisions from an exported review.csv
  --order <a>                add-then-term (default) or term-then-add
  --term-date <YYYY-MM-DD>   DateTerm to write (default: today)
  --include-inactive-charts  also add/migrate on charts that are not PatStatus = Patient
  --stop-after-failures <n>  abort after n consecutive failures (default 3)
  --log <file>               per-patient JSONL log and resume index (default out/apply-log.jsonl)
  --fresh                    ignore the existing log instead of resuming from it
  --out <dir>                where changeset.csv lands (default out)
  -h, --help                 show this

Reads and verifies over SQL (OD_DB_URL); writes over the REST API (OD_API_URL). Runs
completed in the log are never repeated, so a failed run is re-run with the same command.
`)
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
