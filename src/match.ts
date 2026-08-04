import type { MemberRow } from './csv.ts'
import type { OdIndex, OdPatient } from './od.ts'
import { canonicalFirstName, editDistance } from './normalize.ts'

/**
 * Signal weights. DOB, email and phone are identity evidence; the name alone is
 * not, because families share surnames and the CSV names are free-text. A row
 * therefore needs a name signal *and* at least one identity signal to be called
 * a match — everything else lands in the reviewable ambiguous bucket.
 */
const WEIGHTS = {
  dobMatch: 4,
  dobConflict: -5,
  emailMatch: 4,
  emailConflict: -1,
  phoneMatch: 3,
  phoneConflict: -1,
  lastMatch: 2,
  lastNear: 1,
  firstMatch: 2,
  firstNear: 1,
} as const

const MATCH_MIN_SCORE = 7
/** How far ahead of the runner-up the winner must be to be called unambiguous. */
const MATCH_MIN_MARGIN = 2
const AMBIGUOUS_MIN_SCORE = 4

export type Candidate = {
  patient: OdPatient
  score: number
  nameScore: number
  reasons: string[]
}

export type MatchStatus = 'matched' | 'ambiguous' | 'not_found'

export type MatchResult = {
  row: MemberRow
  status: MatchStatus
  /** Top candidates, best first — at most 3, for the review sheet. */
  candidates: Candidate[]
  margin: number
  /** Why this landed in its bucket, in one line. */
  verdict: string
}

export const matchRow = (row: MemberRow, index: OdIndex): MatchResult => {
  const candidates = scoreCandidates(row, index)
  const best = candidates.at(0)
  const runnerUp = candidates.at(1)
  const margin = best ? best.score - (runnerUp?.score ?? 0) : 0

  const top3 = candidates.slice(0, 3)

  if (!best || best.score < AMBIGUOUS_MIN_SCORE) {
    return { row, status: 'not_found', candidates: top3, margin: 0, verdict: notFoundReason(row, best) }
  }

  if (best.nameScore === 0) {
    return {
      row,
      status: 'ambiguous',
      candidates: top3,
      margin,
      verdict: 'identity signals agree but the name does not — needs a human look',
    }
  }

  if (best.score >= MATCH_MIN_SCORE && margin >= MATCH_MIN_MARGIN) {
    return { row, status: 'matched', candidates: top3, margin, verdict: best.reasons.join(' + ') }
  }

  if (margin < MATCH_MIN_MARGIN && runnerUp) {
    return {
      row,
      status: 'ambiguous',
      candidates: top3,
      margin,
      verdict: `${candidates.filter((c) => c.score === best.score).length} patients score equally (${best.reasons.join(' + ')})`,
    }
  }

  return {
    row,
    status: 'ambiguous',
    candidates: top3,
    margin,
    verdict: `only weak evidence: ${best.reasons.join(' + ') || 'none'}`,
  }
}

const notFoundReason = (row: MemberRow, best: Candidate | undefined) => {
  if (!best) return 'no patient shares this name, DOB, email or phone'
  if (row.dob === '' && row.email === '' && row.phone === '') {
    return 'CSV row has only a name — nothing to confirm an identity against'
  }
  return `closest patient scored ${best.score} (${best.reasons.join(' + ') || 'no signals'})`
}

const scoreCandidates = (row: MemberRow, index: OdIndex) => {
  const pool = collectPool(row, index)

  return [...pool]
    .map((patient) => score(row, patient))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.patient.patNum - b.patient.patNum)
}

/** Only patients sharing at least one hard signal are worth scoring. */
const collectPool = (row: MemberRow, index: OdIndex) => {
  const pool = new Set<OdPatient>()
  const add = (patients: OdPatient[] | undefined) => {
    for (const patient of patients ?? []) pool.add(patient)
  }

  if (row.dob !== '') add(index.byDob.get(row.dob))
  if (row.email !== '') add(index.byEmail.get(row.email))
  if (row.phone !== '') add(index.byPhone.get(row.phone))
  for (const token of new Set(row.name.tokens)) {
    add(index.byNameToken.get(token))
    add(index.byNameToken.get(canonicalFirstName(token)))
  }

  return pool
}

const score = (row: MemberRow, patient: OdPatient): Candidate => {
  const reasons: string[] = []
  let total = 0

  if (row.dob !== '' && patient.dob !== '') {
    if (row.dob === patient.dob) {
      total += WEIGHTS.dobMatch
      reasons.push('DOB')
    } else {
      total += WEIGHTS.dobConflict
      reasons.push('DOB differs')
    }
  }

  if (row.email !== '' && patient.email !== '') {
    if (row.email === patient.email) {
      total += WEIGHTS.emailMatch
      reasons.push('email')
    } else {
      total += WEIGHTS.emailConflict
    }
  }

  if (row.phone !== '' && patient.phones.length > 0) {
    if (patient.phones.includes(row.phone)) {
      total += WEIGHTS.phoneMatch
      reasons.push('phone')
    } else {
      total += WEIGHTS.phoneConflict
    }
  }

  const nameScore = scoreName(row, patient, reasons)
  total += nameScore

  return { patient, score: total, nameScore, reasons }
}

const scoreName = (row: MemberRow, patient: OdPatient, reasons: string[]) => {
  const csvTokens = new Set(row.name.tokens)
  let nameScore = 0

  // Last name: the CSV's own guess first, then any token, so "First Last" and
  // "Last First" both land.
  if (patient.normalizedLast !== '') {
    if (row.name.last === patient.normalizedLast || csvTokens.has(patient.normalizedLast)) {
      nameScore += WEIGHTS.lastMatch
      reasons.push('last name')
    } else if (isNear(row.name.last, patient.normalizedLast)) {
      nameScore += WEIGHTS.lastNear
      reasons.push('last name (approx)')
    }
  }

  const patientFirstForms = [patient.normalizedFirst, patient.normalizedPreferred].filter((value) => value !== '')
  const csvFirstForms = [row.name.first, ...row.name.tokens].filter((value) => value !== '')

  const exactFirst = patientFirstForms.some((patientForm) =>
    csvFirstForms.some(
      (csvForm) => csvForm === patientForm || canonicalFirstName(csvForm) === canonicalFirstName(patientForm),
    ),
  )

  if (exactFirst) {
    nameScore += WEIGHTS.firstMatch
    reasons.push('first name')
  } else if (patientFirstForms.some((patientForm) => csvFirstForms.some((csvForm) => isNear(csvForm, patientForm)))) {
    nameScore += WEIGHTS.firstNear
    reasons.push('first name (approx)')
  }

  return nameScore
}

/** One typo apart, and long enough that one edit is not most of the word. */
const isNear = (a: string, b: string) => a !== '' && b !== '' && a.length >= 4 && b.length >= 4 && editDistance(a, b, 1) <= 1
