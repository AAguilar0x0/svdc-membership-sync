# Discount-plan verification — scope

Second half of the reconciliation. Matching answers *which patient is this member?*;
this answers *is that patient on the right discount plan?*

The read-only half — the report that says who is right and who is wrong — is built and has
now been run against the real export. The write half is built too, as of 8/19: dry run by
default, and behind an explicit `--apply` plus a signed-off change count. Nothing has been
written to the practice database. See *The write phase* at the bottom for how it runs.

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
SELECT s.DiscountSubNum, s.PatNum, s.DiscountPlanNum, s.DateEffective, p.Description
FROM discountplansub s
LEFT JOIN discountplan p ON p.DiscountPlanNum = s.DiscountPlanNum
WHERE s.DateTerm = '0001-01-01'
```

`DiscountSubNum` is the PK and the only handle the API has on a row: nothing can be
dropped without it, so it is read here and carried on `ActiveSub` and into the report.

The `discountplan` join is one-to-one and only supplies the description, so it cannot
multiply rows. This is the second — and last — statement the tool runs against OD, and it
stays a `SELECT`.

Every patient with a subscription currently has exactly one active sub (1207 active of
1210 rows, only 3 ever terminated), so "current plan" is unambiguous and no tie-break rule
is needed. The loader will still *detect* a second active sub rather than silently keeping
the first — that assumption is true of today's data, not guaranteed of next month's — and
a patient with two lands in the human-review bucket.

## Plan mapping — confirmed 8/19

`Plan` and `Add-ons` **together** pick one plan; `Add-ons` is not a separate axis. The
`3 Month` / `6 Month` prefix does not affect which plan is correct — only Adult vs Perio
vs Child, and Fluoride, do.

The real export says **`Fluoride Varnish`**, not `Fluoride`, which is why every fluoride
row fell to `unknown_csv_plan` on the first real run. Both spellings are mapped so an
older file still resolves. It also carries **child plans**, which nothing had told us about.

| CSV `Plan` | CSV `Add-ons` | `DiscountPlanNum` | Description |
| --- | --- | --- | --- |
| `6 Month- Adult` | (none) | 1 | In Office Plan |
| `6 Month- Adult` | Fluoride Varnish | 2 | In Office Plan w/Fluoride |
| `3 Month- Perio` | (none) | 3 | In Office Plan Perio |
| `3 Month- Perio` | Fluoride Varnish | 5 | In Office Plan Perio W/ Fluoride |
| `6 Month- Child` | (none or Fluoride Varnish) | 2 | In Office Plan w/Fluoride |
| — | — | 7 | Employee Benefits — nothing in the CSV maps here |

**Every child row goes to plan 2.** OD has no child-specific plan and children are on the
w/Fluoride plan; the add-on column does not change that.

`plans.config.json` is now `"confirmed": true`, and `pnpm apply` refuses to write while it
is not — nothing is written off a mapping nobody has checked against the real file.

## What the real export actually contains (8/19)

1550 rows, 7 distinct `Plan` + `Add-ons` combinations, 6 mapped:

| Rows | Active | Combination |
| --- | --- | --- |
| 751 | 375 | `6 Month- Adult` |
| 388 | 151 | `3 Month- Perio` |
| 252 | 158 | `6 Month- Adult` + Fluoride Varnish |
| 117 | 65 | `3 Month- Perio` + Fluoride Varnish |
| 28 | 6 | `6 Month- Child` |
| 11 | 7 | `6 Month- Child` + Fluoride Varnish |
| 3 | 2 | (blank `Plan` cell) |

The blank-plan rows are **deliberately unmapped**. A member with no plan cannot be checked,
so they report as `unknown_csv_plan` and stay out of every actionable count.

OD active subs: plan 1 = 883, plan 2 = 291, plan 3 = 20, plan 5 = 10 — 1204 subs across
1204 patients, so the one-active-sub-per-patient assumption still holds on real data.

### The Perio gap is a migration, not a data error

216 active CSV rows want a Perio plan; OD has 30 patients on one. The practice created the
Perio plans recently and never moved the patients over, so roughly **186 people need moving
from plan 1/2 to 3/5**. That is the job this tool exists to do — it is not a mismatch to
explain away, and it is why the earlier "eyeball the Perio bucket before changing a hundred
plans off a spreadsheet column" note is now closed rather than blocking.

### Half the export is cancelled

Only 764 of 1550 rows are Active. The other 786 are cancelled memberships, and until 8/19
every one of them whose patient still held the plan reported as `correct` — the one verdict
in the report that was definitely wrong. See *Cancelled memberships* below.

### 132 active subs sit on charts that are not active patients

102 archived, 18 inactive, 9 deceased, 3 non-patient — all on plans 1 and 2, none on Perio.
Nine deceased patients are on a live discount plan. So the write phase **drops** on a chart
whatever its status (taking a plan off a deceased patient is the fix), and **holds back**
adds and migrations onto anything that is not `PatStatus = Patient`, listing them in
`changeset-held-back.csv` rather than enrolling them. `--include-inactive-charts` overrides
that once a human has looked.

## Cancelled memberships

`classifyPlan` now takes the CSV `Active` column, and a cancelled row is classified before
the plan string is even looked at:

| CSV `Active` | Patient holds | Verdict | Action |
| --- | --- | --- | --- |
| No | a mapped plan | `should_drop` | term it |
| No | nothing | `cancelled` | none |
| No | an unmapped plan (7 = Employee Benefits) | `unmapped_od_plan` | human |

**A cancelled member is dropped, never migrated.** They are taken off whatever they hold —
we do not move a cancelled Perio member onto plan 3 and then term it — which is why the
branch never consults the CSV plan, and why a blank plan string does not block a drop.

One guard that is not in the brief and matters at this size: **a cancelled row for a patient
who also has an active row is not a drop.** The export repeats people, so a member who
cancelled last year and re-enrolled this year has both. Terming them off the plan they are
currently paying for would be the worst thing this tool could do, so the active row governs
and the cancelled one becomes `cancelled` with a note naming the patient. For the same
reason, only active rows carry an intent in the conflict pass — a cancelled row naming a
different plan is not a second opinion.
## Outcome buckets

"Right or wrong" is eight states, and they have to stay separate:

| Bucket | Meaning | Action later |
| --- | --- | --- |
| `correct` | active sub matches the CSV plan | **none** — effective dates are not touched |
| `wrong_plan` | active sub is a different, mapped plan | term + add |
| `no_sub` | matched patient with no active sub | add |
| `unmapped_od_plan` | on plan 4, 6, 7 or anything outside the table | human review, raw number shown |
| `unknown_csv_plan` | `Plan` / `Add-ons` we do not recognise | hard error, blocks the run |
| `should_drop` | membership cancelled, patient still holds a mapped plan | term |
| `cancelled` | membership cancelled, nothing on the patient to take off | **none** |
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

Both need to be computed per PatNum, after decisions are applied, not per CSV row. Only
**active** rows carry an intent: a cancelled row naming a different plan is not a second
opinion about what this patient should be on, and treating it as one would hold back the
migration the live row is asking for.

## Where it lives

Read half:

- `src/plans.ts` — the mapping loader, `classifyPlan()` returning one of eight verdicts,
  and `planActionFor()`, which names the write a verdict asks for so the planner, the dry
  run and the log all use the same word.
- `src/od.ts` — `loadActiveDiscountSubs()` into a `Map` keyed by `PatNum`, plus
  `readActiveSubsForPatient()`, the per-patient re-read the write phase brackets each
  write with.
- `src/report.ts` — the conflict pass and the cancelled-row supersede pass, both per
  PatNum after decisions are applied.
- UI: a **Plan** column pairing *CSV says* / *OD has* with a verdict badge, tiles, and
  **Wrong plan** / **To drop** tabs — the two buckets a reviewer signs off on.
- Export: `Plan Verdict`, `Plan Note`, `CSV Plan Num`, `OD Plan Num`, `OD Plan`,
  `OD Plan Effective` and `OD Sub Num` on the review record — one file, not a second report.

Write half:

- `src/changeset.ts` — pure planning: verdicts in, one intent per patient out. No I/O.
- `src/od-api.ts` — the two write calls, and deliberately no read call.
- `src/apply.ts` — the CLI: collect, assert, plan, assert, then write patient by patient.
- `scripts/fake-od-api.ts` — the loopback stub the ordering was tested against.

## The API

We are on OD v25, so all of this is available. Confirmed against
[DiscountPlanSubs](https://www.opendental.com/site/apidiscountplansubs.html):

- `POST /discountplansubs` — requires `DiscountPlanNum` + `PatNum`. `DateEffective` is
  **omitted on purpose**: it defaults to `0001-01-01`, which is the value we want.
- `PUT /discountplansubs/{DiscountSubNum}` — takes `DateEffective`, `DateTerm` and
  `SubNote`, and **nothing else**. It cannot change the plan, which is why a plan change is
  term-then-add rather than one call. `PatNum` is required in the body as well as the URL.
- `DELETE` exists. We do not use it — terming keeps the audit trail.

So the two calls are:

```
drop:  PUT  /discountplansubs/{DiscountSubNum}   { PatNum, DateTerm: "<today>" }
add:   POST /discountplansubs                    { DiscountPlanNum, PatNum }
```

### Verification is SQL, not the API

`GET /discountplansubs?PatNum=` returns **a single object**, and the docs' own example
returns a *terminated* sub. It can therefore neither prove which subscription is current
nor reveal a double-subscribe — the two things a write phase has to know. We already have a
precise read on `discountplansub`, so every write is bracketed by it:

1. re-read the patient's active subs in SQL, immediately before writing — the write
   rate-limit is waited out *before* this read, not after it, or the wait itself is a
   window for the patient to change under us (which is how a real run double-subscribed
   somebody during testing, before the pacing was moved)
2. re-check them against what the change set assumed — anything that moved is skipped
3. write
4. re-read in SQL and confirm the end state is exactly one sub, on the intended plan

That also settles the drop/add ordering question, which was previously stuck on the API
being unable to show which state we were in. Whichever order we pick, we can see the truth
afterwards. `src/od-api.ts` has no getter on it at all, for this reason.

## The write phase

`pnpm apply <members.csv>` — dry run by default. `src/changeset.ts` turns the report's
verdicts into **one intent per patient** (the export repeats people, so two rows asking for
the same thing are one write and two rows asking for different things are not a write at
all), and `src/apply.ts` executes it.

Guards, in the order they fire:

- `plans.config.json` must be `"confirmed": true`
- `--apply` requires `--expect <n>` matching the change count that was signed off; if the
  data moved since the dry run, the run aborts instead of writing a different batch
- no patient may appear twice in a batch
- adds and migrations onto a chart that is not `PatStatus = Patient` are held back
- `--term-date`, `--only`, `--limit`, `--stop-after-failures` and the rate-limit and
  timeout environment variables are all validated before anything runs. A misspelt number
  used to be silent and one-directional: `Number('5s')` is `NaN`, every comparison against
  it is false, and the guard it configures simply stops existing
- `--decisions` must describe the CSV in front of it, checked row by row against the
  patient names
- three consecutive failures stop the run, transport failures included

Every patient appends a JSONL record — before, calls, after, outcome — to
`out/apply-log.jsonl`, which is also the resume index: a patient with a completed write is
never written twice, while failures and skips stay outstanding for the re-run — a skip means
the database stopped matching the plan, which is a thing a human resolves and the next run
should then pick up. `--decisions <review.csv>` carries the reviewer's decisions from the UI, so a row
somebody rejected as "none of these" is not silently re-matched and written.

### The ordering, tested

`scripts/fake-od-api.ts` implements the two endpoints against the **local seeded container**,
because the local Open Dental here is MariaDB with no REST service in front of it and the
write path should not run for the first time against the practice. Both orders were run
end to end on 8/19 and verified in SQL:

- **add-then-term** (default) — a failure leaves an overlap: visible in the read-back,
  harmless, fixable. A gap would leave a paying member on no plan.
- **term-then-add** (`--order term-then-add`) — the fallback if OD rejects the overlapping
  `POST`. With the stub set to refuse it (`FAKE_OD_REJECT_OVERLAP=1`), add-then-term failed
  on the first call and left the patient exactly as they were — a clean no-op — and the
  same command with `--order term-then-add` then completed.

What the local pass proves: our sequencing, verification, logging and resume are right.
What it does not prove: that the real API tolerates the overlap — that is the stub's
behaviour, not OD's. The first pilot patient answers it, and both branches already work.

### Running it

1. **Drops first.** One `PUT` each, no ordering risk: `--only drop`.
2. **Pilot the migration.** `--only migrate --limit 10`, then read those ten in SQL.
3. **Then the batch.** Same command without `--limit`.
4. Re-run after any failure — completed patients are skipped automatically.

**Matthew signs off before the first live write**, on the dry run's change set and its
`--expect` number.

## Settled

- **Real plan strings** — confirmed 8/19, mapping updated, `"confirmed": true`.
- **Cancelled memberships** — `should_drop` / `cancelled`, above. Drop, never migrate.
- **Drop = term, not delete** — keeps the audit trail.
- **Ordering** — add-then-term by default, term-then-add available, both tested.
- **`SubNote`** — neither call writes it, so nothing on an existing row is discarded.
