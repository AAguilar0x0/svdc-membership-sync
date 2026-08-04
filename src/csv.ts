import { readFileSync } from 'node:fs'
import { parse } from 'csv-parse/sync'

import { normalizeDob, normalizeEmail, normalizePhone, splitName, type NameParts } from './normalize.ts'

/**
 * The membership export: `Patient Name, DOB, Email, Phone, Plan Start Date, Plan, Add-ons, Active`.
 * Headers are matched loosely (case/space/punctuation insensitive) with a few aliases,
 * because the file is hand-exported and the exact casing drifts between exports.
 */
const HEADER_ALIASES: Record<keyof MemberColumns, string[]> = {
  patientName: ['patientname', 'name', 'membername', 'fullname'],
  dob: ['dob', 'dateofbirth', 'birthdate', 'birthday'],
  email: ['email', 'emailaddress', 'e-mail'],
  phone: ['phone', 'phonenumber', 'mobile', 'cell', 'cellphone'],
  planStartDate: ['planstartdate', 'startdate', 'effectivedate', 'plandate'],
  plan: ['plan', 'planname', 'membershipplan'],
  addOns: ['addons', 'add-ons', 'addon', 'addonsfluoride'],
  active: ['active', 'isactive', 'status'],
}

type MemberColumns = {
  patientName: string
  dob: string
  email: string
  phone: string
  planStartDate: string
  plan: string
  addOns: string
  active: string
}

export type MemberRow = {
  /** 1-based row number as it appears in the spreadsheet body, for cross-referencing. */
  rowNumber: number
  raw: MemberColumns
  name: NameParts
  dob: string
  email: string
  phone: string
  planStartDate: string
  isActive: boolean
}

const canonicalHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '')

const buildHeaderMap = (headers: string[]) => {
  const seen = new Map<string, string>()
  for (const header of headers) seen.set(canonicalHeader(header), header)

  const resolved = {} as Record<keyof MemberColumns, string | undefined>
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof MemberColumns, string[]][]) {
    resolved[field] = aliases.map((alias) => seen.get(alias)).find((value) => value !== undefined)
  }
  return resolved
}

/** "Yes"/"TRUE"/"1"/"Active" all mean active; blank defaults to active. */
const parseActive = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return true
  return !['no', 'false', '0', 'inactive', 'n', 'cancelled', 'canceled', 'terminated'].includes(normalized)
}

export const readMemberCsv = (path: string) => parseMemberCsv(readFileSync(path))

export const parseMemberCsv = (content: string | Buffer) => {
  const records = parse(content, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[]

  const headers = Object.keys(records.at(0) ?? {})
  const headerMap = buildHeaderMap(headers)

  const missing = (['patientName'] as const).filter((field) => headerMap[field] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `CSV is missing required column(s): ${missing.join(', ')}. Found headers: ${headers.join(', ') || '(none)'}`,
    )
  }

  const read = (record: Record<string, string>, field: keyof MemberColumns) => {
    const header = headerMap[field]
    return header === undefined ? '' : (record[header] ?? '').trim()
  }

  return records
    .map((record, index): MemberRow => {
      const raw: MemberColumns = {
        patientName: read(record, 'patientName'),
        dob: read(record, 'dob'),
        email: read(record, 'email'),
        phone: read(record, 'phone'),
        planStartDate: read(record, 'planStartDate'),
        plan: read(record, 'plan'),
        addOns: read(record, 'addOns'),
        active: read(record, 'active'),
      }

      return {
        rowNumber: index + 1,
        raw,
        name: splitName(raw.patientName),
        dob: normalizeDob(raw.dob),
        email: normalizeEmail(raw.email),
        phone: normalizePhone(raw.phone),
        planStartDate: normalizeDob(raw.planStartDate),
        isActive: parseActive(raw.active),
      }
    })
    .filter((row) => Object.values(row.raw).some((value) => value !== ''))
}

/**
 * The export repeats the same person ("Yolanda aguayo" ×3 with identical DOB and
 * phone). Grouping on the identity signals lets the report say "3 CSV rows, one
 * patient" instead of reporting three independent matches.
 *
 * Email is deliberately NOT part of the key: the same person is often exported
 * once with an address and once without, and keying on it splits the group.
 */
export const duplicateKey = (row: MemberRow) => [row.name.tokens.join(' '), row.dob, row.phone].join('|')
