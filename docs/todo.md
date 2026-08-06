# TODO

Proof-of-concept scope. The bar is "a report a human can act on", not production
hardening — see *Deliberately not doing* at the bottom for what that rules out.

Design detail for the discount-plan work lives in
[`discount-plan-verification.md`](discount-plan-verification.md).

## Next

- [ ] Push the three commits on `main` to `origin`.
- [ ] **Run the real export through the matcher** (read-only, as-is). One pass answers
      three open questions at once: the real distinct `Plan` / `Add-ons` strings, the true
      matched / ambiguous / not-found split, and whether the Perio mismatch is real.
- [ ] Eyeball the Perio count. Ten patients are on a Perio plan in OD; if the export has
      hundreds, that is a data conversation before it is a code change.

> **The plan lives in `discountplansub`, not `patient.DiscountPlanNum`.** The earlier
> advice to read that column is superseded — it is zero for every patient in this install,
> so a report built on it calls the whole practice unenrolled while looking like it worked.

## Blocked on Matthew

- [ ] Confirm the real `Plan` / `Add-ons` strings before the mapping table is hardcoded.
      Everything else in the read half can be built without them.
- [ ] **Cancelled memberships** — a row with `Active: No` whose patient is still on a plan
      in OD. Drop, or no-op? The buckets have nowhere to put it today.
- [ ] **Drop/add ordering** for the write phase. Preference is add-then-term, so a partial
      failure leaves a harmless overlap rather than a patient on no plan at all. Needs
      someone who knows the OD API to confirm a brief overlap is tolerated.
- [x] Term vs delete on drop — agreed: term, to preserve the audit trail.

## Read-only discount-plan report

Buildable now with the mapping table stubbed.

- [ ] `loadActiveDiscountSubs()` — separate `SELECT` on `discountplansub`, into a
      `Map` keyed by `PatNum`. Never joined into the patient query.
- [ ] Plan mapping table + `classify(row, activeSub)` returning a bucket.
- [ ] Plan column in the results table: *CSV says* / *OD has* / verdict badge.
- [ ] Plan fields on the export record (`OD Plan`, `OD Effective Date`, `Plan Verdict`).

Two things to keep even at PoC grade — each about a line, and each the difference
between a report that is rough and a report that is quietly wrong:

- [ ] An unrecognised CSV plan string is a **hard error**. A silent fallthrough to plan 1
      reports "correct" for people nobody checked, and looks exactly like a working run.
- [ ] Unmatched rows counted **separately** from `correct`. That is the headline number
      everyone will read.

## Deliberately not doing (PoC)

- No test suite. Verification is the fixture run plus a look at the real export.
- No conflict *resolution* pass. Duplicate-group plan disagreements and PatNum collisions
  are excluded from the actionable count and shown as needs-review — a filter, not a feature.
- No dedicated tiles or filter tab for plan buckets; the column and the export are enough.

## Before any write to live OD

Not now — nothing above touches it. But the write half runs against the live practice
database, where a failed drop-then-add leaves real patients on no plan, so this stops
being polish and starts being the point:

- [ ] Re-read the patient's current sub immediately before writing, not from the report.
      No idempotency key on create, so a re-run against stale state double-subscribes.
- [ ] Dry-run mode, and a per-patient log of before / read / written.
- [ ] Owner sign-off. This would be the first write this project makes to live OD.
