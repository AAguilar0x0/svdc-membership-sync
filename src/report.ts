import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'csv-stringify/sync'

import { duplicateKey, type MemberRow } from './csv.ts'
import type { Candidate, MatchResult, MatchStatus } from './match.ts'

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

export const toReviewRecord = (row: ResolvedRow) => {
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
    'Candidate 1': describeCandidate(best),
    'Candidate 2': describeCandidate(second),
    'Candidate 3': describeCandidate(third),
    'Duplicate Group': row.duplicateGroup,
  }
}

export const toCsv = (records: Record<string, unknown>[]) => stringify(records, { header: true })

export const writeReport = (results: MatchResult[], outDir: string, decisions: Decisions = new Map()) => {
  mkdirSync(outDir, { recursive: true })

  const duplicateGroups = groupDuplicates(results.map((result) => result.row))
  const resolved = resolveRows(results, decisions, duplicateGroups)
  const records = resolved.map(toReviewRecord)

  const write = (name: string, rows: Record<string, unknown>[]) =>
    writeFileSync(join(outDir, name), toCsv(rows))

  write('review.csv', records)
  write('matched.csv', records.filter((record) => record.Status === 'matched'))
  write('ambiguous.csv', records.filter((record) => record.Status === 'ambiguous'))
  write('not-found.csv', records.filter((record) => record.Status === 'not_found'))

  return { records, resolved, duplicateGroups }
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
