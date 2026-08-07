# Discount-plan verification — scope

Second half of the reconciliation. Matching answers *which patient is this member?*;
this answers *is that patient on the right discount plan?*

**This document scopes the read-only half only** — the report that says who is right and
who is wrong. No writes to Open Dental, in this phase or in this repo, until that report
has been reviewed against real data. The write phase has open decisions, listed at the
bottom, that should be settled before anything is built.

## Source of truth: `discountplansub`, not `patient.DiscountPlanNum`

`patient.DiscountPlanNum` is dead in this install — 1210 rows in `discountplansub`, and
zero patients with a non-zero `DiscountPlanNum`. Reading that column would report every
member as "no plan on file", which is a wrong answer that looks like a working report.
The column is ignored entirely; nothing in the code should reference it.

`discountplansub`: `DiscountSubNum` (PK), `DiscountPlanNum`, `PatNum`, `DateEffective`,
`DateTerm`, `SubNote`.

Both date columns are `NOT NULL DEFAULT '0001-01-01'` — Open Dental's zero-date sentinel,
the same one `normalize.ts` already strips to `''`. So "no term date" is `DateTerm =
'0001-01-01'`, not `NULL`, and "null effective date" in the write phase means writing that
sentinel rather than a real null. **To confirm with the API before the write phase.**

## The query

It cannot join into the patient `SELECT`. Patients accumulate subscription rows over
time, so the join multiplies patient rows and breaks the matcher's one-row-per-patient
index. It is a separate statement, loaded into a `Map` keyed by `PatNum`:

```sql
SELECT s.PatNum, s.DiscountPlanNum, s.DateEffective, p.Description
FROM discountplansub s
LEFT JOIN discountplan p ON p.DiscountPlanNum = s.DiscountPlanNum
WHERE s.DateTerm = '0001-01-01'
```

The `discountplan` join is one-to-one and only supplies the description, so it cannot
multiply rows. This is the second — and last — statement the tool runs against OD, and it
stays a `SELECT`.

Every patient with a subscription currently has exactly one active sub (1207 active of
1210 rows, only 3 ever terminated), so "current plan" is unambiguous and no tie-break rule
is needed. The loader will still *detect* a second active sub rather than silently keeping
the first — that assumption is true of today's data, not guaranteed of next month's — and
a patient with two lands in the human-review bucket.

## Plan mapping

`Plan` and `Add-ons` **together** pick one plan; `Add-ons` is not a separate axis. The
`3 Month` / `6 Month` prefix does not affect which plan is correct — only Adult vs Perio
and Fluoride do.

| CSV `Plan` | CSV `Add-ons` | `DiscountPlanNum` | Description |
| --- | --- | --- | --- |
| `6 Month- Adult` | (none) | 1 | In Office Plan |
| `6 Month- Adult` | Fluoride | 2 | In Office Plan w/Fluoride |
| `3 Month- Perio` | (none) | 3 | In Office Plan Perio |
| `3 Month- Perio` | Fluoride | 5 | In Office Plan Perio W/ Fluoride |
| — | — | 7 | Employee Benefits — nothing in the CSV maps here |

**These strings come from the sample file, not the real export, and are not confirmed.**
The mapping goes in one table with an explicit lookup, and an unrecognised `Plan` /
`Add-ons` combination is a **hard error on that row** — never a silent fallthrough to a
default plan. The table is the only place plan numbers appear.

Current spread of active subs: plan 1 = 899, plan 2 = 298, plan 3 = 8, plan 5 = 2,
plan 7 = 0. Only ten patients are on a Perio plan in OD. If the export carries a lot of
Perio members, the mismatch bucket will be large, and that is a data question to answer
before anyone changes a hundred plans off a spreadsheet column.

## Outcome buckets

"Right or wrong" is six states, and they have to stay separate:

| Bucket | Meaning | Action later |
| --- | --- | --- |
| `correct` | active sub matches the CSV plan | **none** — effective dates are not touched |
| `wrong_plan` | active sub is a different, mapped plan | drop + add |
| `no_sub` | matched patient with no active sub | add |
| `unmapped_od_plan` | on plan 4, 6, 7 or anything outside the table | human review, raw number shown |
| `unknown_csv_plan` | `Plan` / `Add-ons` we do not recognise | hard error, blocks the run |
| `ineligible` | row was never matched to a PatNum | nothing to act on |

`ineligible` exists so an unmatched row can never be counted as `correct`. A row with no
PatNum is not a patient who is on the right plan; it is a row we know nothing about, and
the tiles have to say so separately or the "correct" number is a lie.

## Conflicts

Two cases, both of which must resolve to **one intent per patient**, never two API calls:

- **Repeated CSV rows for the same person.** The export repeats people; `groupDuplicates`
  already labels them. If two rows in a duplicate group map to *different* plans, that is
  a conflict — the patient is flagged and excluded from any action until a human picks.
- **PatNum collisions.** Two different members matched to one patient; already flagged in
  the summary. Same treatment: excluded, not resolved by last-write-wins.

Both need to be computed per PatNum, after decisions are applied, not per CSV row.

## What it adds to the tool

- `src/plans.ts` — the mapping table, `classify(row, activeSub)` returning a bucket, and
  the conflict pass over resolved rows.
- `src/od.ts` — `loadActiveDiscountSubs()` returning `Map<number, ActiveSub>`, plus
  `loadDiscountPlans()` so a plan number in the table that does not exist in OD fails at
  startup rather than mid-report.
- UI: a **Plan** column pairing *CSV says* / *OD has* with a bucket badge, a bucket filter
  tab, and tiles for correct / wrong / no sub / needs review.
- Export: `OD Plan`, `OD Plan Description`, `OD Effective Date`, `CSV Plan Num`, `Plan
  Verdict` on the existing review record — one file, not a second report.

Roughly a day for the read half, most of it in the UI and the conflict pass rather than
the query.

## The API, from Open Dental's own docs

Confirmed against [DiscountPlanSubs](https://www.opendental.com/site/apidiscountplansubs.html),
so these are no longer open:

- `POST /discountplansubs` — requires `DiscountPlanNum` + `PatNum`; `DateEffective`,
  `DateTerm`, `SubNote` optional and **both default to `0001-01-01`**. So "add with a null
  effective date" is just omitting the field.
- `PUT /discountplansubs/{DiscountSubNum}` can set `DateTerm` — terming is supported, so
  the term-rather-than-delete decision needs no workaround. `DELETE` exists; we will not use it.
- `GET /discountplansubs?PatNum=` returns **a single object, not a list.**

That last one matters and cuts against the add-then-term ordering recommended below: the
API models one subscription per patient, so during an overlap the read-back is ambiguous —
you cannot tell which of the two you are looking at. It does not settle the ordering
question, but it turns it from a preference into something that needs an actual test
against a database we are willing to be wrong on.

## Open questions

1. **Confirm the real `Plan` / `Add-ons` strings** before the mapping is written. Blocking
   for correctness, not for building the surrounding machinery.
2. **Inactive memberships.** The CSV has an `Active` column. A cancelled member who is
   still on a plan in OD is arguably a *drop*, not a `correct`. Currently unhandled —
   which way should it read?
3. **`SubNote`** — is anything written there today that we would be discarding?

## For the write phase — decide before building

- **Drop = term, not delete.** Set `DateTerm`; keep the row. It preserves history and is
  reversible, so we can see exactly what the tool touched. Deleting destroys the audit
  trail on a table that has been terminated three times in its life. Recommending terming
  unless the API forces otherwise.
- **Drop-then-add is not atomic.** If the drop succeeds and the add fails, the patient is
  left on *no plan*, which is worse than the wrong plan they started with. Preference:
  add first, then term the old one, so a failure leaves an overlap (visible, harmless,
  fixable) rather than a gap. Needs confirming that OD tolerates a brief overlap.
- **Re-read before writing.** The patient's current sub must be read immediately before
  the write, not taken from the report — the report is stale by then, and the create call
  has no idempotency key, so a re-run against stale state double-subscribes.
- **Dry-run first, and a per-patient log** of what was read, what was written, and what
  the state was before — this will be the first write this project makes to live Open
  Dental, and it needs owner sign-off before the first run.
