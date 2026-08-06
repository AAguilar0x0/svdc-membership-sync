import type { MemberRow } from './csv.ts'
import type { OdIndex, OdPatient } from './od.ts'
import { canonicalFirstName, editDistance } from './normalize.ts'

/**
 * Signal weights. DOB, email and phone are identity evidence; the name alone is
 * not, because families share surnames and the CSV names are free-text. A row
 * therefore needs a name signal *and* at least one identity signal to be called
 * a match — everything else lands in the reviewable ambiguous bucket.
 *
 * Disagreement counts too, in both directions. A household shares a DOB-less
 * phone and sometimes a birthday, so "same first name + shared phone" is not
 * identity: a surname that actively disagrees has to pull the score back down,
 * and a second, different email address on file is evidence against, not noise.
 */
const WEIGHTS = {
  dobMatch: 4,
  dobConflict: -5,
  emailMatch: 4,
  emailConflict: -2,
  phoneMatch: 3,
  phoneConflict: -1,
  lastMatch: 2,
  lastNear: 1,
  lastConflict: -2,
  firstMatch: 2,
  firstNear: 1,
} as const

const MATCH_MIN_SCORE = 7
/** How far ahead of the runner-up the winner must be to be called unambiguous. */
const MATCH_MIN_MARGIN = 2
const AMBIGUOUS_MIN_SCORE = 4
/**
 * Floor for *showing* a candidate in the review list. A first-name-only hit scores 1,
 * and sitting next to a real match scoring 15 it is nothing but a misclick waiting to
 * happen. Display only: scoring, the margin and the surname-conflict check all still
 * run against the full candidate list, so no row's bucket changes because of this.
 */
const CANDIDATE_DISPLAY_MIN_SCORE = 4

export type Candidate = {
  patient: OdPatient
  score: number
  nameScore: number
  /** Both sides carry a surname and they disagree — never an automatic match. */
  lastConflict: boolean
  reasons: string[]
}

export type MatchStatus = 'matched' | 'ambiguous' | 'not_found'

export type MatchResult = {
  row: MemberRow
  status: MatchStatus
  /**
   * Top candidates, best first — at most 3, for the review sheet, and only those at or
   * above `CANDIDATE_DISPLAY_MIN_SCORE`. This is the display list, not the list the
   * verdict was computed from; it can be empty while `verdict` still cites a near miss.
   */
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

  const top3 = candidates.filter((candidate) => candidate.score >= CANDIDATE_DISPLAY_MIN_SCORE).slice(0, 3)

  if (!best || best.score < AMBIGUOUS_MIN_SCORE) {
    return { row, status: 'not_found', candidates: top3, margin: 0, verdict: notFoundReason(row, best) }
  }

  // A surname that disagrees outright is disqualifying on its own, however well the
  // identity signals line up. Sharing a first name and a household phone is what a
  // parent and child look like; a marriage-name change looks the same from here, so
  // it goes to review rather than to the not-found pile.
  if (best.lastConflict) {
    return {
      row,
      status: 'ambiguous',
      candidates: top3,
      margin,
      verdict: `last name differs (CSV "${row.name.last}" vs OD "${best.patient.normalizedLast}")${emailNote(row, best.patient)} — needs a human look`,
    }
  }

  if (best.nameScore <= 0) {
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
      const source = patient.phoneSource.get(row.phone)
      reasons.push(source === undefined ? 'phone' : `phone (${source})`)
    } else {
      total += WEIGHTS.phoneConflict
    }
  }

  const name = scoreName(row, patient, reasons)
  total += name.score

  return { patient, score: total, nameScore: name.score, lastConflict: name.lastConflict, reasons }
}

const scoreName = (row: MemberRow, patient: OdPatient, reasons: string[]) => {
  let nameScore = 0

  const last = compareLastName(row, patient)
  if (last === 'match') {
    nameScore += WEIGHTS.lastMatch
    reasons.push('last name')
  } else if (last === 'near') {
    nameScore += WEIGHTS.lastNear
    reasons.push('last name (approx)')
  } else if (last === 'conflict') {
    nameScore += WEIGHTS.lastConflict
    reasons.push('last name differs')
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

  return { score: nameScore, lastConflict: last === 'conflict' }
}

type LastNameVerdict = 'match' | 'near' | 'unknown' | 'conflict'

/**
 * Compared token-wise and against every CSV token, so "Garcia Lopez" still meets
 * "Garcia" and "Last, First" order still lands. `unknown` is reserved for the cases
 * where there is genuinely nothing to compare — the chart has no surname, or the CSV
 * cell held a single word ("Yolanda") that gives us no surname to disagree with.
 * Everything else that fails to line up is a real conflict and is scored as one.
 */
const compareLastName = (row: MemberRow, patient: OdPatient): LastNameVerdict => {
  const patientTokens = patient.normalizedLast.split(' ').filter((token) => token !== '')
  if (patientTokens.length === 0 || row.name.tokens.length === 0) return 'unknown'

  if (patientTokens.some((token) => row.name.tokens.includes(token))) return 'match'
  if (patientTokens.some((token) => row.name.tokens.some((csvToken) => isNear(csvToken, token)))) return 'near'

  return row.name.last === '' ? 'unknown' : 'conflict'
}

/** Only worth saying when both sides carried an address and they disagreed too. */
const emailNote = (row: MemberRow, patient: OdPatient) =>
  row.email !== '' && patient.email !== '' && row.email !== patient.email ? ' and so does the email' : ''

/** One typo apart, and long enough that one edit is not most of the word. */
const isNear = (a: string, b: string) => a !== '' && b !== '' && a.length >= 4 && b.length >= 4 && editDistance(a, b, 1) <= 1
