import { isActionablePlanVerdict, planActionFor, type PlanAction } from './plans.ts'
import type { PlanChecks, ResolvedRow } from './report.ts'

/**
 * The change set: one intent per patient, computed before anything is written.
 *
 * Pure planning. It takes the read-only report's verdicts and turns them into the exact
 * calls the write phase would make, so the whole plan can be printed, signed off and
 * diffed before a single request leaves the machine. Nothing here talks to OD.
 *
 * The unit is the **patient**, not the CSV row. The export repeats people, and two rows
 * that resolve to the same instruction are one write, not two — while two rows that
 * resolve to different instructions are not a write at all, they are a question.
 */

export type PlannedChange = {
  patNum: number
  action: Exclude<PlanAction, 'none'>
  patientName: string
  chartStatus: string
  /** What the report saw. Re-read at write time and re-checked against these. */
  currentPlanNum: number | undefined
  currentSubNum: number | undefined
  targetPlanNum: number | undefined
  rowNumbers: number[]
}

/**
 * An actionable verdict the planner still refused to turn into a write, and why.
 *
 * It carries the whole change, not a summary of it: this file is what a human picks up to
 * decide the cases the tool would not, and "Junior Smith, add, held back" without the plan
 * he would have been put on is not a decision anybody can make.
 */
export type HeldBackChange = PlannedChange & { reason: string }

export const planChanges = (
  resolved: ResolvedRow[],
  checks: PlanChecks,
  { includeInactiveCharts = false } = {},
) => {
  const byPatNum = new Map<number, PlannedChange[]>()

  for (const row of resolved) {
    const patient = row.chosen?.patient
    if (patient === undefined) continue

    const check = checks.byRowNumber.get(row.result.row.rowNumber)
    if (check === undefined || !isActionablePlanVerdict(check.verdict)) continue

    const action = planActionFor(check.verdict)
    if (action === 'none') continue

    const change: PlannedChange = {
      patNum: patient.patNum,
      action,
      patientName: patient.displayName,
      chartStatus: patient.patStatusLabel,
      currentPlanNum: check.odPlanNum,
      currentSubNum: check.odSubNum,
      // A drop has no target. The cancelled row still names a plan, and carrying it here
      // would let a `current → target` line read like a migration nobody asked for.
      targetPlanNum: action === 'drop' ? undefined : check.csvPlanNum,
      rowNumbers: [row.result.row.rowNumber],
    }

    const existing = byPatNum.get(patient.patNum)
    if (existing) existing.push(change)
    else byPatNum.set(patient.patNum, [change])
  }

  const changes: PlannedChange[] = []
  const heldBack: HeldBackChange[] = []

  for (const [patNum, group] of byPatNum) {
    const merged = mergeRows(group)

    // Two rows for one patient asking for two different writes. The conflict pass already
    // catches rows that disagree about the *plan*; this catches anything it did not, and it
    // is the last place a patient can pick up two API calls instead of one.
    if (merged.length > 1) {
      for (const change of merged) {
        heldBack.push({ ...change, reason: `${merged.length} different actions planned for patient ${patNum}` })
      }
      continue
    }

    const change = merged[0]!

    // Taking a plan *off* a chart that is no longer a patient is a fix — nine deceased
    // patients are sitting on live discount plans. Putting one *on* is not: an archived,
    // inactive or deceased chart is not somebody to enroll off the back of a spreadsheet.
    if (change.action !== 'drop' && change.chartStatus !== 'Patient' && !includeInactiveCharts) {
      heldBack.push({ ...change, reason: `chart is ${change.chartStatus}, not an active patient` })
      continue
    }

    if (change.action !== 'add' && change.currentSubNum === undefined) {
      heldBack.push({ ...change, reason: 'no DiscountSubNum on the current sub — nothing to term' })
      continue
    }

    if (change.action !== 'drop' && change.targetPlanNum === undefined) {
      heldBack.push({ ...change, reason: 'no target plan number' })
      continue
    }

    changes.push(change)
  }

  return { changes, heldBack }
}

/** Rows that ask for the same thing collapse into one change carrying both row numbers. */
const mergeRows = (group: PlannedChange[]) => {
  const byIntent = new Map<string, PlannedChange>()
  for (const change of group) {
    const key = `${change.action}|${change.targetPlanNum ?? ''}|${change.currentSubNum ?? ''}`
    const existing = byIntent.get(key)
    if (existing) existing.rowNumbers.push(...change.rowNumbers)
    else byIntent.set(key, change)
  }
  return [...byIntent.values()]
}

export const describeChange = (change: PlannedChange) => {
  const from = change.currentPlanNum === undefined ? 'no plan' : `plan ${change.currentPlanNum}`
  const to = change.targetPlanNum === undefined ? 'no plan' : `plan ${change.targetPlanNum}`
  return `${from} → ${to}  (${change.action})`
}

/** Drops run as their own batch first: one `PUT` each, no ordering risk to get wrong. */
export const CHANGE_ORDER: Exclude<PlanAction, 'none'>[] = ['drop', 'add', 'migrate']

export const sortChanges = (changes: PlannedChange[]) =>
  [...changes].sort(
    (a, b) => CHANGE_ORDER.indexOf(a.action) - CHANGE_ORDER.indexOf(b.action) || a.patNum - b.patNum,
  )
