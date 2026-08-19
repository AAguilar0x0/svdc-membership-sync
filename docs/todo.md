# TODO

Proof-of-concept scope. The bar is "a report a human can act on", and now "a change set a
human can sign off" — see *Deliberately not doing* at the bottom for what that still rules out.

Design detail for the discount-plan work lives in
[`discount-plan-verification.md`](discount-plan-verification.md).

## Next — the run

Everything below this line is built and tested against the local seeded Open Dental.
Nothing has been written to the practice database.

- [ ] **Matthew signs off on the dry run.** `pnpm apply <members.csv>` prints the change
      set, one line per patient (`current plan → target → action`), and writes
      `out/changeset.csv`. He signs off on that file and the `--expect` number on it.
- [ ] **Drops first.** `--only drop --apply --expect <n>`. One `PUT` each, no ordering
      risk, and it is the half of the export nobody has to think about.
- [ ] **Pilot ten migrations.** `--only migrate --limit 10 --apply --expect 10`, then read
      those ten patients in SQL. This is also what answers whether the real API tolerates
      the overlapping `POST`; if it refuses, re-run with `--order term-then-add`.
- [ ] **Then the rest** — roughly 186 people moving from plan 1/2 to 3/5.

## Done — the real export, 8/19

- [x] Ran it. 1550 rows, 7 combinations, 6 mapped; the 7th is 3 rows with a blank `Plan`
      cell, deliberately left unmapped because a member with no plan cannot be checked.
- [x] Real plan strings in `plans.config.json`, `"confirmed": true`. The export says
      **`Fluoride Varnish`**, not `Fluoride` — that one string was sending every fluoride
      row to `unknown_csv_plan`. Child plans exist and all go to plan 2.
- [x] The Perio gap is a **migration, not a data error**: the practice created the Perio
      plans recently and never moved anyone over. 216 active rows want Perio, OD has 30.
- [x] Half the export is cancelled — 786 of 1550 — and every one of them whose patient
      still held the plan was reporting as `correct`. Now `should_drop` / `cancelled`.
- [x] 132 active subs sit on charts that are not active patients, nine of them deceased.
      Drops go ahead on any chart; adds and migrations onto a non-`Patient` chart are held
      back into `changeset-held-back.csv`.

## Done — the write phase, 8/19

- [x] `DiscountSubNum` on the subs read and on `ActiveSub`. Nothing can be dropped without it.
- [x] `classifyPlan` takes the CSV `Active` column. Cancelled members are **dropped, never
      migrated** — the branch never even looks at the plan string.
- [x] A cancelled row for a patient who *also* has an active row does not drop. The export
      repeats people; terming a re-enrolled member off the plan they are paying for would be
      the worst thing this tool could do.
- [x] `pnpm apply` — dry run by default, `--apply` + `--expect <n>` to write, per-patient
      JSONL log that doubles as the resume index, `--only` and `--limit` for batching,
      `--decisions review.csv` so a reviewer's "none of these" is not silently overruled.
- [x] Every write is bracketed by a SQL re-read: before (is this still true?) and after
      (is the end state exactly one sub, on the right plan?). The API cannot do this —
      `GET /discountplansubs?PatNum=` returns one object.
- [x] Both orderings tested end to end against the local container through
      `scripts/fake-od-api.ts`, including the refused-overlap branch, which failed as a
      clean no-op and then succeeded with `--order term-then-add`.
- [x] Term rather than delete, and `DateEffective` omitted on the `POST` so it defaults to
      `0001-01-01`.

## Active-charts filter — still his call

Built long ago: a toggle in the UI and `--active-charts-only` on the CLI, narrowing
candidates to `PatStatus = Patient`, **off by default**, both splits always reported.

- [ ] Decide the default. The tension: the chart-status column exists so a row that failed
      because the chart is archived *says so*. Filtering those charts out removes the
      candidate, so the row goes quiet — right answer, no explanation. Note this is a
      separate question from the write phase's chart guard, which is already decided and
      does not depend on it.

## Deliberately not doing (PoC)

- No test suite. Verification is the fixture run, the local seeded run, and the dry run.
- No conflict *resolution* pass. Rows that disagree about one patient are excluded from the
  change set and listed, not resolved.
- No rollback command. A drop is a `DateTerm` on a row that is still there, and an add is a
  row with a `DiscountSubNum` in the log, so undoing either is a hand-written `UPDATE` on a
  named row rather than a feature.
