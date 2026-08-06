import type { MemberRow } from './csv.ts'
import type { ActiveSub } from './od.ts'

/**
 * Which discount plan a member *should* be on, against the one they *are* on.
 *
 * Read-only, and deliberately opinionated about not knowing: an unrecognised CSV plan
 * string is reported, never resolved to a default, and a row we could not match to a
 * PatNum is `ineligible` rather than quietly counted as correct. The headline number
 * is the one everybody reads, so nothing is allowed to inflate it.
 */

/**
 * The CSV's `Plan` and `Add-ons` columns *together* pick one plan — `Add-ons` is not a
 * separate axis. The 3-month / 6-month prefix does not affect which plan is correct;
 * only Adult vs Perio and Fluoride do, but the whole string is matched exactly so that a
 * new prefix shows up as unrecognised instead of being silently absorbed.
 *
 * UNCONFIRMED: these strings come from the sample export, not the real one. This table is
 * the only place plan numbers appear; when the real distinct values land, this is the edit.
 */
const CSV_PLAN_MAP = [
  { plan: '6 Month- Adult', addOns: '', discountPlanNum: 1, description: 'In Office Plan' },
  { plan: '6 Month- Adult', addOns: 'Fluoride', discountPlanNum: 2, description: 'In Office Plan w/Fluoride' },
  { plan: '3 Month- Perio', addOns: '', discountPlanNum: 3, description: 'In Office Plan Perio' },
  { plan: '3 Month- Perio', addOns: 'Fluoride', discountPlanNum: 5, description: 'In Office Plan Perio W/ Fluoride' },
] as const

export type CsvPlan = (typeof CSV_PLAN_MAP)[number]

/** Plan 7 (Employee Benefits) is real but nothing in the CSV maps to it, so it is not here. */
const MAPPED_PLAN_NUMBERS = new Set<number>(CSV_PLAN_MAP.map((entry) => entry.discountPlanNum))

/** Case, spacing and punctuation drift between exports; the words do not. */
const planKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

export const mapCsvPlan = (row: MemberRow) =>
  CSV_PLAN_MAP.find(
    (entry) => planKey(entry.plan) === planKey(row.raw.plan) && planKey(entry.addOns) === planKey(row.raw.addOns),
  )

export type PlanVerdict =
  /** Active sub already matches the CSV. No action — we do not touch effective dates. */
  | 'correct'
  /** On a different mapped plan. Change needed. */
  | 'wrong_plan'
  /** Matched patient with no active sub at all. Add needed. */
  | 'no_sub'
  /** On a plan outside our mapping (4, 6, 7…). Human review, raw number shown. */
  | 'unmapped_od_plan'
  /** CSV `Plan` / `Add-ons` we do not recognise. Never resolved to a default. */
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
  csvPlan: CsvPlan | undefined,
  patNum: number | undefined,
  sub: ActiveSub | undefined,
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
      note: `unrecognised plan string — cannot say what this member should be on`,
    }
  }

  if (sub === undefined) {
    return { ...base, verdict: 'no_sub', note: 'no active subscription on file' }
  }

  if (!MAPPED_PLAN_NUMBERS.has(sub.discountPlanNum)) {
    return {
      ...base,
      verdict: 'unmapped_od_plan',
      note: `on plan ${sub.discountPlanNum}, which is outside our mapping`,
    }
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
