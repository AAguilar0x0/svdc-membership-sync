import { readFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'

import { canonicalFirstName, normalizeDob, normalizeEmail, normalizeName, normalizePhone } from './normalize.ts'

/**
 * Open Dental `PatStatus` values. Deleted rows are excluded by default; the rest
 * are kept but carried into the report, because a membership member sitting on an
 * Inactive/Archived chart is exactly the kind of thing worth seeing.
 */
export const PAT_STATUS_LABELS: Record<number, string> = {
  0: 'Patient',
  1: 'NonPatient',
  2: 'Inactive',
  3: 'Archived',
  4: 'Deleted',
  5: 'Deceased',
}

/** Which column a number came from. A household shares a landline but rarely a mobile. */
export type PhoneSource = 'home' | 'wireless' | 'work'

export type OdPatient = {
  patNum: number
  fname: string
  lname: string
  preferred: string
  middleI: string
  displayName: string
  patStatus: number
  patStatusLabel: string
  dob: string
  email: string
  phones: string[]
  /**
   * Normalised number → the field it was filed under, so a phone match can say which
   * one it was: "phone (wireless)" is identity evidence in a way that "phone (home)"
   * is not. First field wins when the same number is filed twice, which keeps the
   * weaker (household) reading rather than the flattering one.
   */
  phoneSource: Map<string, PhoneSource>
  /** Normalised forms, precomputed once because every CSV row compares against these. */
  normalizedFirst: string
  normalizedLast: string
  normalizedPreferred: string
  normalizedTokens: string[]
}

/**
 * One read-only SELECT over the whole patient table. A single practice's patient list
 * fits comfortably in memory, so pulling the identity columns once and matching locally
 * beats one round trip per CSV row and keeps the DB touch to a single reviewable statement.
 */
const PATIENT_QUERY = `
  SELECT PatNum, FName, LName, Preferred, MiddleI, Birthdate, Email,
         HmPhone, WkPhone, WirelessPhone, PatStatus
  FROM patient
  WHERE PatStatus <> 4
`

const PATIENT_QUERY_WITH_DELETED = PATIENT_QUERY.replace('WHERE PatStatus <> 4', '')

type PatientRecord = {
  PatNum: number
  FName: string | null
  LName: string | null
  Preferred: string | null
  MiddleI: string | null
  Birthdate: string | Date | null
  Email: string | null
  HmPhone: string | null
  WkPhone: string | null
  WirelessPhone: string | null
  PatStatus: number
}

export const loadOdPatients = async (connectionUrl: string, includeDeleted = false) => {
  const connection = await mysql.createConnection({
    uri: connectionUrl,
    // Keep DATE columns as strings; the driver's local-timezone Date conversion
    // can shift a birthdate by a day.
    dateStrings: true,
  })

  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      includeDeleted ? PATIENT_QUERY_WITH_DELETED : PATIENT_QUERY,
    )
    return (rows as unknown as PatientRecord[]).map(toOdPatient)
  } finally {
    await connection.end()
  }
}

/**
 * Offline substitute for the DB read: a JSON array of rows shaped exactly like the
 * SELECT above. Lets the matcher be exercised against faker data with no VPN and no
 * PHI on the laptop.
 */
export const loadOdPatientsFromFixture = async (path: string) => {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(raw)) throw new Error(`Fixture ${path} must be a JSON array of patient rows.`)
  return (raw as PatientRecord[]).map(toOdPatient)
}

const toOdPatient = (record: PatientRecord): OdPatient => {
  const fname = (record.FName ?? '').trim()
  const lname = (record.LName ?? '').trim()
  const preferred = (record.Preferred ?? '').trim()
  const middleI = (record.MiddleI ?? '').trim()

  const normalizedFirst = normalizeName(fname)
  const normalizedLast = normalizeName(lname)
  const normalizedPreferred = normalizeName(preferred)

  const phoneSource = new Map<string, PhoneSource>()
  for (const [source, raw] of [
    ['home', record.HmPhone],
    ['wireless', record.WirelessPhone],
    ['work', record.WkPhone],
  ] as const) {
    const phone = normalizePhone(raw)
    if (phone !== '' && !phoneSource.has(phone)) phoneSource.set(phone, source)
  }

  return {
    patNum: Number(record.PatNum),
    fname,
    lname,
    preferred,
    middleI,
    displayName: [lname, fname].filter(Boolean).join(', '),
    patStatus: record.PatStatus,
    patStatusLabel: PAT_STATUS_LABELS[record.PatStatus] ?? String(record.PatStatus),
    dob: normalizeDob(record.Birthdate),
    email: normalizeEmail(record.Email),
    phones: [...phoneSource.keys()],
    phoneSource,
    normalizedFirst,
    normalizedLast,
    normalizedPreferred,
    normalizedTokens: [normalizedFirst, normalizedLast, normalizeName(middleI), normalizedPreferred]
      .flatMap((value) => value.split(' '))
      .filter((token) => token !== ''),
  }
}

/**
 * Blocking indexes. A CSV row is only ever scored against patients that share at
 * least one hard signal (DOB / email / phone / a name token), which is both the
 * fast path and the honest one — a row sharing nothing is genuinely not found.
 */
export type OdIndex = {
  patients: OdPatient[]
  byDob: Map<string, OdPatient[]>
  byEmail: Map<string, OdPatient[]>
  byPhone: Map<string, OdPatient[]>
  byNameToken: Map<string, OdPatient[]>
}

export const buildOdIndex = (patients: OdPatient[]): OdIndex => {
  const index: OdIndex = {
    patients,
    byDob: new Map(),
    byEmail: new Map(),
    byPhone: new Map(),
    byNameToken: new Map(),
  }

  for (const patient of patients) {
    if (patient.dob !== '') push(index.byDob, patient.dob, patient)
    if (patient.email !== '') push(index.byEmail, patient.email, patient)
    for (const phone of new Set(patient.phones)) push(index.byPhone, phone, patient)
    for (const token of new Set(patient.normalizedTokens)) {
      push(index.byNameToken, token, patient)
      const canonical = canonicalFirstName(token)
      if (canonical !== token) push(index.byNameToken, canonical, patient)
    }
  }

  return index
}

const push = (map: Map<string, OdPatient[]>, key: string, patient: OdPatient) => {
  const existing = map.get(key)
  if (existing) existing.push(patient)
  else map.set(key, [patient])
}
