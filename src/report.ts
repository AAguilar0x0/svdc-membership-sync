import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'csv-stringify/sync'

import { duplicateKey, type MemberRow } from './csv.ts'
import type { Candidate, MatchResult, MatchStatus } from './match.ts'
import type { ActiveSubs } from './od.ts'
import {
  classifyPlan,
  isActionablePlanVerdict,
  mapCsvPlan,
  mappedPlanNumbers,
  type PlanCheck,
  type PlanMap,
  type PlanVerdict,
} from './plans.ts'

/**
 * Output is a reviewable three-way split, never a silent best guess: `review.csv`
 * holds every row with its verdict, and the three bucket files are the same rows
 * filtered, so a bucket can be handed round on its own. Nothing here writes to OD.
 *
 * A reviewer working in the web UI can override any row (confirm a different
 * candidate, or reject a match); those decisions are applied here so the exported
 * files are what the enrollment step actually consumes.
 */

/** `null` means "none of these" — an explicit human rejection, not an absence of input. */
export type Decision = { patNum: number | null }
export type Decisions = Map<number, Decision>

export type ResolvedRow = {
  result: MatchResult
  status: MatchStatus
  chosen: Candidate | undefined
  resolvedBy: 'auto' | 'human'
  duplicateGroup: string
}

const describeCandidate = (candidate: Candidate | undefined) => {
  if (!candidate) return ''
  const { patient, score } = candidate
  return `${patient.patNum} ${patient.displayName} (${patient.dob || 'no DOB'}, score ${score})`
}

/**
 * Apply reviewer decisions on top of the automatic verdicts. A confirmed candidate
 * promotes the row to `matched`; an explicit rejection demotes it to `not_found`.
 */
export const resolveRows = (
  results: MatchResult[],
  decisions: Decisions,
  duplicateGroups: Map<number, string>,
): ResolvedRow[] =>
  results.map((result) => {
    const duplicateGroup = duplicateGroups.get(result.row.rowNumber) ?? ''
    const decision = decisions.get(result.row.rowNumber)

    if (decision === undefined) {
      return {
        result,
        status: result.status,
        chosen: result.status === 'matched' ? result.candidates.at(0) : undefined,
        resolvedBy: 'auto',
        duplicateGroup,
      }
    }

    if (decision.patNum === null) {
      return { result, status: 'not_found', chosen: undefined, resolvedBy: 'human', duplicateGroup }
    }

    const chosen = result.candidates.find((candidate) => candidate.patient.patNum === decision.patNum)
    return {
      result,
      status: chosen ? 'matched' : result.status,
      chosen,
      resolvedBy: 'human',
      duplicateGroup,
    }
  })

export type PlanChecks = {
  byRowNumber: Map<number, PlanCheck>
  /** Distinct CSV plan strings the mapping table does not cover — the thing to fix, loudly. */
  unknownPlanStrings: string[]
}

/**
 * Compare each matched patient's active subscription against the plan the CSV says they
 * should be on.
 *
 * Two passes, because the second one cannot be done a row at a time: the export repeats
 * people, and two rows for one patient that disagree about the plan are a conflict, not
 * two instructions. Same for two different members matched to a single PatNum. Neither is
 * *resolved* here — at this stage they are pulled out of the actionable count and handed
 * to a human, which is the honest outcome for a spreadsheet that contradicts itself.
 */
export const checkPlans = (resolved: ResolvedRow[], subs: ActiveSubs, planMap: PlanMap): PlanChecks => {
  const byRowNumber = new Map<number, PlanCheck>()
  const unknownPlanStrings = new Set<string>()
  const mappedPlans = mappedPlanNumbers(planMap)

  for (const row of resolved) {
    const csvPlan = mapCsvPlan(planMap, row.result.row)
    const patNum = row.chosen?.patient.patNum

    // Collected for every row, matched or not: an unrecognised string means the mapping
    // table is incomplete, and that is true whether or not this particular row matched.
    if (csvPlan === undefined) {
      const { plan, addOns } = row.result.row.raw
      unknownPlanStrings.add(addOns === '' ? plan : `${plan} + ${addOns}`)
    }

    const check = classifyPlan(
      csvPlan,
      patNum,
      patNum === undefined ? undefined : subs.byPatNum.get(patNum),
      mappedPlans,
    )

    byRowNumber.set(
      row.result.row.rowNumber,
      patNum !== undefined && subs.multipleActive.includes(patNum)
        ? { ...check, verdict: 'conflict', note: 'patient has more than one active subscription' }
        : check,
    )
  }

  for (const [patNum, rows] of groupByPatNum(resolved)) {
    if (rows.length < 2) continue
    const intents = new Set(rows.map((row) => byRowNumber.get(row.result.row.rowNumber)?.csvPlanNum))
    if (intents.size < 2) continue

    for (const row of rows) {
      const check = byRowNumber.get(row.result.row.rowNumber)
      if (check === undefined) continue
      byRowNumber.set(row.result.row.rowNumber, {
        ...check,
        verdict: 'conflict',
        note: `${rows.length} CSV rows disagree about patient ${patNum}`,
      })
    }
  }

  return { byRowNumber, unknownPlanStrings: [...unknownPlanStrings] }
}

const groupByPatNum = (resolved: ResolvedRow[]) => {
  const groups = new Map<number, ResolvedRow[]>()
  for (const row of resolved) {
    const patNum = row.chosen?.patient.patNum
    if (patNum === undefined) continue
    const existing = groups.get(patNum)
    if (existing) existing.push(row)
    else groups.set(patNum, [row])
  }
  return groups
}

export const summarizePlans = (checks: PlanChecks) => {
  const counts: Record<PlanVerdict, number> = {
    correct: 0,
    wrong_plan: 0,
    no_sub: 0,
    unmapped_od_plan: 0,
    unknown_csv_plan: 0,
    conflict: 0,
    ineligible: 0,
  }
  for (const check of checks.byRowNumber.values()) counts[check.verdict] += 1

  return {
    ...counts,
    actionable: [...checks.byRowNumber.values()].filter((check) => isActionablePlanVerdict(check.verdict)).length,
    unknownPlanStrings: checks.unknownPlanStrings,
  }
}

export const toReviewRecord = (row: ResolvedRow, check?: PlanCheck) => {
  const { result, chosen } = row
  const [best, second, third] = result.candidates

  return {
    'CSV Row': result.row.rowNumber,
    Status: row.status,
    'Resolved By': row.resolvedBy,
    PatNum: chosen?.patient.patNum ?? '',
    'OD Name': chosen?.patient.displayName ?? '',
    'OD DOB': chosen?.patient.dob ?? '',
    'OD Status': chosen?.patient.patStatusLabel ?? '',
    'OD Email': chosen?.patient.email ?? '',
    'OD Phones': chosen?.patient.phones.join(' / ') ?? '',
    Score: chosen?.score ?? best?.score ?? '',
    Margin: result.margin,
    Verdict: result.verdict,
    'Patient Name': result.row.raw.patientName,
    DOB: result.row.raw.dob,
    Email: result.row.raw.email,
    Phone: result.row.raw.phone,
    'Plan Start Date': result.row.raw.planStartDate,
    Plan: result.row.raw.plan,
    'Add-ons': result.row.raw.addOns,
    Active: result.row.raw.active,
    'Plan Verdict': check?.verdict ?? '',
    'Plan Note': check?.note ?? '',
    'CSV Plan Num': check?.csvPlanNum ?? '',
    'OD Plan Num': check?.odPlanNum ?? '',
    'OD Plan': check?.odPlanDescription ?? '',
    'OD Plan Effective': check?.odEffectiveDate ?? '',
    'Candidate 1': describeCandidate(best),
    'Candidate 2': describeCandidate(second),
    'Candidate 3': describeCandidate(third),
    'Duplicate Group': row.duplicateGroup,
  }
}

export const toCsv = (records: Record<string, unknown>[]) => stringify(records, { header: true })

export const writeReport = (
  results: MatchResult[],
  outDir: string,
  decisions: Decisions = new Map(),
  subs?: ActiveSubs,
  planMap?: PlanMap,
) => {
  mkdirSync(outDir, { recursive: true })

  const duplicateGroups = groupDuplicates(results.map((result) => result.row))
  const resolved = resolveRows(results, decisions, duplicateGroups)
  const checks = subs && planMap ? checkPlans(resolved, subs, planMap) : undefined
  const records = resolved.map((row) => toReviewRecord(row, checks?.byRowNumber.get(row.result.row.rowNumber)))

  const write = (name: string, rows: Record<string, unknown>[]) =>
    writeFileSync(join(outDir, name), toCsv(rows))

  write('review.csv', records)
  write('matched.csv', records.filter((record) => record.Status === 'matched'))
  write('ambiguous.csv', records.filter((record) => record.Status === 'ambiguous'))
  write('not-found.csv', records.filter((record) => record.Status === 'not_found'))

  return { records, resolved, duplicateGroups, checks }
}

/**
 * The export repeats people (same DOB and phone, name retyped). Rows that collapse
 * to one identity get a shared group label so the reviewer sees "3 rows, 1 patient".
 */
export const groupDuplicates = (rows: MemberRow[]) => {
  const byKey = new Map<string, MemberRow[]>()
  for (const row of rows) {
    const key = duplicateKey(row)
    const existing = byKey.get(key)
    if (existing) existing.push(row)
    else byKey.set(key, [row])
  }

  const labels = new Map<number, string>()
  let groupNumber = 0
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    groupNumber += 1
    const label = `dup-${groupNumber} (${group.length} rows)`
    for (const row of group) labels.set(row.rowNumber, label)
  }
  return labels
}

export const summarize = (resolved: ResolvedRow[], duplicateGroups: Map<number, string>) => {
  const counts = { matched: 0, ambiguous: 0, not_found: 0 }
  for (const row of resolved) counts[row.status] += 1

  // Two different CSV rows landing on one PatNum is worth flagging even when both
  // matched confidently — it is either a duplicate export row or a bad match.
  const patNumUses = new Map<number, number>()
  for (const row of resolved) {
    if (row.status !== 'matched' || row.chosen === undefined) continue
    const { patNum } = row.chosen.patient
    patNumUses.set(patNum, (patNumUses.get(patNum) ?? 0) + 1)
  }

  return {
    total: resolved.length,
    ...counts,
    reviewed: resolved.filter((row) => row.resolvedBy === 'human').length,
    distinctPatients: patNumUses.size,
    duplicateRows: duplicateGroups.size,
    collidingPatNums: [...patNumUses.entries()].filter(([, uses]) => uses > 1),
  }
}
