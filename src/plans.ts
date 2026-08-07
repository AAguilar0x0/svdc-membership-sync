import { readFileSync } from 'node:fs'

import type { MemberRow } from './csv.ts'
import type { ActiveSub } from './od.ts'

/**
 * Which discount plan a member *should* be on, against the one they *are* on.
 *
 * Read-only, and deliberately opinionated about not knowing: an unrecognised CSV plan
 * string is reported, never resolved to a default, and a row we could not match to a
 * PatNum is `ineligible` rather than quietly counted as correct. The headline number
 * is the one everybody reads, so nothing is allowed to inflate it.
 *
 * The mapping itself is **configuration, not code** (`plans.config.json`). We do not have
 * the real export and are not going to get it, so the strings in this repo can only ever
 * be a guess — putting them in a source file would mean every correction needs a commit
 * from someone who cannot see the data. `pnpm discover` produces the values to put there.
 */

export type PlanMapping = {
  /** The CSV's `Plan` cell, verbatim. */
  plan: string
  /** The CSV's `Add-ons` cell, verbatim. Empty string means "no add-on". */
  addOns: string
  discountPlanNum: number
  description: string
}

export type PlanMap = {
  entries: PlanMapping[]
  /** Where it was loaded from, so the report can say which file to correct. */
  source: string
  /** False until someone has checked the strings against a real export. Surfaced in the UI. */
  confirmed: boolean
}

export const DEFAULT_PLAN_MAP_PATH = 'plans.config.json'

/**
 * Fails loudly and specifically. A mapping that is silently empty or half-parsed would
 * report every member as unrecognised, which reads like a data problem rather than a
 * config one and would send someone hunting in the wrong place.
 */
export const loadPlanMap = (path: string): PlanMap => {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read the plan mapping at ${path}: ${reason}`)
  }

  if (typeof raw !== 'object' || raw === null) throw new Error(`${path} must be a JSON object.`)

  const { plans, confirmed } = raw as { plans?: unknown; confirmed?: unknown }
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error(`${path} must have a non-empty "plans" array.`)
  }

  const entries = plans.map((entry, index) => parseEntry(entry, index, path))

  const seen = new Set<string>()
  for (const entry of entries) {
    const key = mappingKey(entry.plan, entry.addOns)
    if (seen.has(key)) {
      throw new Error(`${path} maps "${entry.plan}" + "${entry.addOns}" more than once — one of them would be ignored.`)
    }
    seen.add(key)
  }

  return { entries, source: path, confirmed: confirmed === true }
}

const parseEntry = (entry: unknown, index: number, path: string): PlanMapping => {
  const where = `${path} plans[${index}]`
  if (typeof entry !== 'object' || entry === null) throw new Error(`${where} must be an object.`)

  const { plan, addOns, discountPlanNum, description } = entry as Record<string, unknown>
  if (typeof plan !== 'string' || plan.trim() === '') throw new Error(`${where}.plan must be a non-empty string.`)
  if (addOns !== undefined && typeof addOns !== 'string') throw new Error(`${where}.addOns must be a string.`)
  if (typeof discountPlanNum !== 'number' || !Number.isInteger(discountPlanNum) || discountPlanNum <= 0) {
    throw new Error(`${where}.discountPlanNum must be a positive integer — it is OD's DiscountPlanNum.`)
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new Error(`${where}.description must be a string.`)
  }

  return { plan, addOns: addOns ?? '', discountPlanNum, description: description ?? '' }
}

/** Case, spacing and punctuation drift between exports; the words do not. */
const planKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

const mappingKey = (plan: string, addOns: string) => `${planKey(plan)}|${planKey(addOns)}`

/**
 * The CSV's `Plan` and `Add-ons` columns *together* pick one plan — `Add-ons` is not a
 * separate axis. Matched as a pair and exactly, so a plan string nobody has seen before
 * surfaces as unrecognised instead of being absorbed by a near-enough rule.
 */
export const mapCsvPlan = (map: PlanMap, row: MemberRow) =>
  map.entries.find((entry) => mappingKey(entry.plan, entry.addOns) === mappingKey(row.raw.plan, row.raw.addOns))

export const mappedPlanNumbers = (map: PlanMap) => new Set<number>(map.entries.map((entry) => entry.discountPlanNum))

export type PlanVerdict =
  /** Active sub already matches the CSV. No action — we do not touch effective dates. */
  | 'correct'
  /** On a different mapped plan. Change needed. */
  | 'wrong_plan'
  /** Matched patient with no active sub at all. Add needed. */
  | 'no_sub'
  /** On a plan outside the mapping (Employee Benefits, or anything not configured). */
  | 'unmapped_od_plan'
  /** CSV `Plan` / `Add-ons` the mapping does not cover. Never resolved to a default. */
  | 'unknown_csv_plan'
  /** Two CSV rows disagree about one patient, or the patient has two active subs. */
  | 'conflict'
  /** No PatNum to act on. Explicitly not 'correct'. */
  | 'ineligible'

export type PlanCheck = {
  verdict: PlanVerdict
  csvPlanNum: number | undefined
  csvPlanDescription: string
  odPlanNum: number | undefined
  odPlanDescription: string
  odEffectiveDate: string
  /** Why, when the verdict alone does not say it. */
  note: string
}

export const classifyPlan = (
  csvPlan: PlanMapping | undefined,
  patNum: number | undefined,
  sub: ActiveSub | undefined,
  mappedPlans: Set<number>,
): PlanCheck => {
  const base = {
    csvPlanNum: csvPlan?.discountPlanNum,
    csvPlanDescription: csvPlan?.description ?? '',
    odPlanNum: sub?.discountPlanNum,
    odPlanDescription: sub?.description ?? '',
    odEffectiveDate: sub?.dateEffective ?? '',
  }

  // Order matters. A row with no PatNum is not a patient on the right plan; it is a row we
  // know nothing about, and it has to leave the actionable counts before anything else runs.
  if (patNum === undefined) {
    return { ...base, verdict: 'ineligible', note: 'row was not matched to a patient' }
  }

  if (csvPlan === undefined) {
    return {
      ...base,
      verdict: 'unknown_csv_plan',
      note: 'plan string is not in the mapping — cannot say what this member should be on',
    }
  }

  if (sub === undefined) {
    return { ...base, verdict: 'no_sub', note: 'no active subscription on file' }
  }

  if (!mappedPlans.has(sub.discountPlanNum)) {
    return { ...base, verdict: 'unmapped_od_plan', note: `on plan ${sub.discountPlanNum}, which is not in the mapping` }
  }

  return sub.discountPlanNum === csvPlan.discountPlanNum
    ? { ...base, verdict: 'correct', note: '' }
    : { ...base, verdict: 'wrong_plan', note: `on plan ${sub.discountPlanNum}, should be ${csvPlan.discountPlanNum}` }
}

export const PLAN_VERDICT_LABELS: Record<PlanVerdict, string> = {
  correct: 'Correct',
  wrong_plan: 'Wrong plan',
  no_sub: 'No sub',
  unmapped_od_plan: 'Unmapped plan',
  unknown_csv_plan: 'Unknown CSV plan',
  conflict: 'Conflict',
  ineligible: 'Not matched',
}

/** Only these two are a clean instruction to the write phase. Everything else needs a human. */
export const isActionablePlanVerdict = (verdict: PlanVerdict) => verdict === 'wrong_plan' || verdict === 'no_sub'
