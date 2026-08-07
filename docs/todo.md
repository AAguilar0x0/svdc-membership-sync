# TODO

Proof-of-concept scope. The bar is "a report a human can act on", not production
hardening — see *Deliberately not doing* at the bottom for what that rules out.

Design detail for the discount-plan work lives in
[`discount-plan-verification.md`](discount-plan-verification.md).

## Next

- [x] Push the review-hardening and security commits.
- [ ] **Run the real export through the matcher** (read-only, as-is). One pass answers
      three open questions at once: the real distinct `Plan` / `Add-ons` strings, the true
      matched / ambiguous / not-found split, and whether the Perio mismatch is real.
- [ ] Eyeball the Perio count. Ten patients are on a Perio plan in OD; if the export has
      hundreds, that is a data conversation before it is a code change.

> **The plan lives in `discountplansub`, not `patient.DiscountPlanNum`.** The earlier
> advice to read that column is superseded — it is zero for every patient in this install,
> so a report built on it calls the whole practice unenrolled while looking like it worked.

## Active-charts filter — built, needs his call

Asked twice (8/5) and now in: a toggle in the UI and `--active-charts-only` on the CLI,
narrowing candidates to `PatStatus = Patient`. **Off by default**, because it is a real
narrowing rather than a display filter and the point was to compare, not to assume.

Both splits are always reported. On the sample: matched 13 → 12, not found 6 → 7, one
inactive chart excluded.

- [ ] Run it against the real export and show him both splits — the comparison he asked
      for has still never been run on real data.
- [ ] Then decide the default. The tension worth putting to him: the chart-status column
      exists so a row that failed because the chart is archived *says so*. Filtering those
      charts out removes the candidate, so the row goes quiet — right answer, no
      explanation. Default-off keeps the explanation; default-on keeps the noise down.

## We will never see the real export — what that changed

Settled 8/7: no export data will be shared with us, and OD access here is the local Docker
seed only. So the mapping cannot be authored from this side, and pretending otherwise would
ship a tool that hard-errors on every row of the real file.

- [x] Mapping moved out of code into `plans.config.json`, overridable per-run, validated at
      startup, and marked `"confirmed": false` until someone checks it. Correcting it no
      longer needs a commit from us.
- [x] `pnpm discover` — prints the distinct plan strings in an export, the discount plans in
      OD, and the chart counts by `PatStatus`. Counts only, no patient details, so whoever
      has the file can run it and paste the output back safely.
- [x] Local OD seeded with plans and subscriptions (`pnpm seed:local-od-plans`, loopback-only)
      plus `sample/members.demo-od.sample.csv`, so the whole pipeline runs against real MySQL
      instead of JSON fixtures — and the write phase has a safe place to be wrong.
- [ ] **Ask Matthew to run `pnpm discover` against the real export and send back the output.**
      That is now the entire remaining input needed for the plan mapping, and it contains no PHI.

## Parked — write phase (8/7)

This is a proof of concept and a throwaway, so the write-side questions are not being
chased. Both are recorded because they are real, not because they are next:

- **Cancelled memberships** — `Active: No` whose patient still holds a plan. No-op writes
  nothing; drop is one `PUT` setting `DateTerm` on one existing row. Today the report calls
  these `correct`, which is the one thing that is definitely wrong.
- **Drop/add ordering** — per patient it is 1 new `discountplansub` row + `DateTerm` on the
  old one, either order. Term-then-add fails to zero active rows; add-then-term fails to
  two, and `GET` returns a single object so we cannot tell which. Needs a real test.
- [x] Term vs delete on drop — agreed: term, to preserve the audit trail.
- [x] "Null effective date" — answered by the docs: omit the field, it defaults to
      `0001-01-01`.

## Read-only discount-plan report

Built, with the mapping table carrying the unconfirmed sample strings.

- [x] `loadActiveDiscountSubs()` — separate `SELECT` on `discountplansub`, into a
      `Map` keyed by `PatNum`. Never joined into the patient query.
- [x] Plan mapping table + `classifyPlan()` returning one of seven verdicts.
- [x] Plan column in the results table: verdict badge, the OD plan, and why.
- [x] Plan fields on the export record (`Plan Verdict`, `Plan Note`, `CSV Plan Num`,
      `OD Plan Num`, `OD Plan`, `OD Plan Effective`).
- [x] An unrecognised CSV plan string is never resolved to a default — the row is
      `unknown_csv_plan` and the page names the offending strings in a red banner.
- [x] Unmatched rows are `ineligible`, counted separately from `correct`.
- [x] Conflicts held back, not resolved: two CSV rows disagreeing about one patient, and
      patients with more than one active sub, are excluded from the actionable count.

Changed my mind on one line below: plan **tiles** went in after all. They are four
entries in an array the page already builds, and "how many are already right?" is the
question the whole exercise exists to answer. No filter tab, as planned.

Still open here:

- [ ] Swap the sample plan strings for the real ones once confirmed — edit
      `plans.config.json` and flip `"confirmed"` to `true`. No code change, no commit needed.
- [ ] Run it against the real database and eyeball the Perio bucket.

## Deliberately not doing (PoC)

- No test suite. Verification is the fixture run plus a look at the real export.
- No conflict *resolution* pass. Duplicate-group plan disagreements and PatNum collisions
  are excluded from the actionable count and shown as needs-review — a filter, not a feature.
- No filter tab for plan buckets; the column, the tiles and the export are enough.

## Before any write to live OD

Not now — nothing above touches it. But the write half runs against the live practice
database, where a failed drop-then-add leaves real patients on no plan, so this stops
being polish and starts being the point:

- [ ] Re-read the patient's current sub immediately before writing, not from the report.
      No idempotency key on create, so a re-run against stale state double-subscribes.
- [ ] Dry-run mode, and a per-patient log of before / read / written.
- [ ] Owner sign-off. This would be the first write this project makes to live OD.
