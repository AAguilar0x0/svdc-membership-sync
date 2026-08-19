# svdc-membership-sync

One-time local tool for reconciling a membership-plan export against Open Dental:
**match each member to a patient number**, **check the discount plan they are on**, and
**write the difference back** — drops first, then the plan migrations.

It is deliberately *not* part of `svdc-webapp`: no product feature, no scheduler job, no
service layer. The review UI here is a local page served from this repo, run on the
operator's machine for the length of one reconciliation, and thrown away once the
membership vendor writes to Open Dental directly.

Zero build step on purpose — `node:http` and one HTML file, sharing the matching core
with the CLI.

## What it does

Reads the membership CSV (`Patient Name, DOB, Email, Phone, Plan Start Date, Plan,
Add-ons, Active`), reads the Open Dental `patient` table with a **single SELECT**,
and produces a reviewable **three-way split** — matched / ambiguous / not found. For every
matched member it then says whether they are on the right discount plan, and whether they
should be on one at all: half the real export is cancelled memberships.

Matching and reporting never write. The write phase is a separate command
([below](#the-write-phase)), dry-run by default, and it will not run without a change count
that was signed off on the dry run it came from.

## Usage

```sh
pnpm install
cp .env.example .env      # fill in OD_DB_URL
pnpm web                  # → http://localhost:5178
```

Drop the CSV on the page. It matches, shows the three-way split, and lets you work
through the rows that need a human. There's a CLI too, if you'd rather have the files
straight out:

```sh
pnpm match ./members.csv
pnpm match ./members.csv --out reports --active-only
```

| CLI flag | Effect |
| --- | --- |
| `--out <dir>` | where the report lands (default `out/`) |
| `--active-only` | skip rows whose `Active` column is falsy (CSV side) |
| `--active-charts-only` | only consider OD patients with `PatStatus = Patient` (OD side) |
| `--include-deleted` | also consider OD patients with `PatStatus = Deleted` (excluded by default) |
| `--fixture <file>` | match against a JSON patient fixture instead of the DB — offline dry run |
| `--subs-fixture <file>` | `discountplansub` fixture, so the plan check runs offline too |

```sh
pnpm discover ./members.csv          # what plan strings are in the file (counts only)
pnpm apply ./members.csv             # the change set, dry run — writes nothing
```

## The review UI

`pnpm web` serves a local page on **127.0.0.1 only** — it handles PHI and must never be
reachable from the network. Set `PORT` to move it.

- **Summary tiles** — matched / ambiguous / not found, distinct PatNums, duplicate rows.
- **A collision banner** when one PatNum is claimed by more than one CSV row.
- **Tabs and search**, including a **Needs review** tab (everything the matcher would not
  call on its own) and two plan tabs — **Wrong plan** and **To drop** — which are the rows
  the write phase would actually touch, and the ones a reviewer signs off on.
- **Expand any row** to see the candidates it considered, with their score and the exact
  signals that fired (`DOB + phone (wireless) + last name`). For an ambiguous row you pick
  the right patient, or say **None of these**. **Undo my decision** puts it back to the
  automatic verdict. Candidates scoring below 4 are not listed — a first-name-only hit
  scores 1, and next to a real match it is only a misclick. The floor is display-only: the
  score, the margin and the surname check all still run against every candidate, so no
  row's bucket depends on it.
- **Active charts only** — a toggle that narrows the candidate set to `PatStatus = Patient`
  and re-matches in place. Off by default. Once both have been seen the page shows the two
  splits side by side (`matched 13 → 12, not found 6 → 7`), which is the point: restricting
  the candidates can only move rows *out* of matched, and the question is how many. Rows
  that stop matching are members sitting on an inactive or archived chart — a real finding
  either way, but one the chart-status column can no longer explain once the candidate is
  filtered out. The CLI prints the same comparison on every run.
- **Chart status** — the OD `PatStatus` of the matched patient. When nothing matched it
  falls back to the top candidate's, dimmed, so "this row failed because the chart is
  archived" is visible without opening anything. Anything other than `Patient` is flagged.
- **Export review / Export matched** download CSVs that reflect your decisions, with a
  `Resolved By` column recording `auto` vs `human`.

Decisions live in the server's memory for the life of the process. Nothing about a run is
written to disk unless you export, and nothing is ever written to Open Dental.

### Sample data

There are two sample CSVs, and **each one only matches against its own patient source**.
Running one against the other source is a valid question with a boring answer: everything
comes back not found, because none of those people are in that database.

| CSV | Patient source | Result |
| --- | --- | --- |
| `sample/members.sample.csv` | `sample/od-patients.sample.json` (fixture) | 13 matched · 1 ambiguous · 6 not found |
| `sample/members.local-od.sample.csv` | the local Docker Open Dental seed | 6 matched · 3 ambiguous · 6 not found |

```sh
# against the fixture — no database, no VPN, no PHI
OD_FIXTURE=sample/od-patients.sample.json pnpm web
pnpm match sample/members.sample.csv --fixture sample/od-patients.sample.json

# against the local seeded Open Dental in OD_DB_URL
pnpm web
pnpm match sample/members.local-od.sample.csv
```

The header of the page always names the source it read (`6 OD patients · Open Dental
MySQL (read-only)` vs `12 OD patients · fixture: …`) — check it first if a run comes back
entirely not found.

The local-OD sample is built from the six seeded patients, who carry **no email and no
phone** — so DOB, last name and first name are the only three signals that can ever fire
there, no matter what the CSV supplies. Its rows are shaped to exercise the combinations
that remain:

| Row | Verdict |
| --- | --- |
| Hana Gooding | `DOB + last name + first name` — the clean case |
| ivan brushwel | `DOB + last name (approx) + first name` — one typo in the surname |
| Otho Perryman | `DOB + last name + first name (approx)` — one typo in the given name |
| Marcus Gooding | ambiguous: `DOB + last name` — shares a sibling's DOB, different person |
| Pia Ashford | ambiguous: `DOB + first name` — looks like a surname change |
| Ivan Brushwell | ambiguous: `last name + first name` — no DOB, so nothing confirms it |

Email- and phone-driven matching can only be seen against the fixture, where the patients
have contact details. To exercise it against the local database instead, the seeded
patients would need emails and phone numbers added to them first.

The sample pair is 20 rows against 12 patients, and lands as **13 matched · 1 ambiguous
· 6 not found** — enough of each bucket to exercise the review flow.

It covers the cases a real export actually contains: the same person repeated with a
retyped name, a nickname (`Bob` → `Robert` via `Preferred`), two family members sharing
a DOB and a phone, a `Last, First` name, a missing DOB, an apostrophe surname, an
inactive chart, a genuinely ambiguous father/son pair, and six members with no patient
record at all — one each with a full contact set, a phone but no email, an email but no
phone, name and DOB only, and an inactive membership.

## Output

Four files in `--out` (the same four are available from the UI's export buttons):

- `review.csv` — every row with its verdict and top-3 candidates. **This is the file
  to review.**
- `matched.csv` / `ambiguous.csv` / `not-found.csv` — the same rows, split, so a
  bucket can be handed round on its own.

Every row carries its original CSV columns through, plus the plan verdict, the plan OD has
and its `OD Sub Num` — the `discountplansub` PK, without which nothing can be dropped.

`pnpm apply` writes two more: `changeset.csv`, the per-patient plan of what would be
written, and `changeset-held-back.csv`, the actionable rows it refused to turn into a write
and why. Both name patients, so they are PHI; `out/` is gitignored.

The summary also flags **duplicate CSV rows** (grouped on name + DOB + phone; email is
left out of the key because the same person is often exported once with an address and
once without) and **PatNum collisions** — one patient matched by two different rows, which is either
a repeated export row or a bad match.

## How matching works

`DOB`, `email` and `phone` are identity evidence. The name is not — families share
surnames and the export names are free-text. So a row is only called **matched** when
it has a name signal **and** at least one identity signal, with a clear margin over
the runner-up. Everything short of that is **ambiguous**, which is a bucket for a human,
not a failure.

| Signal | Weight |
| --- | --- |
| DOB matches / conflicts | +4 / −5 |
| Email matches / conflicts | +4 / −2 |
| Phone matches any of `HmPhone`, `WirelessPhone`, `WkPhone` / conflicts | +3 / −1 |
| Last name actively disagrees | −2, and never an automatic match |
| Last name exact / one typo | +2 / +1 |
| First name exact (incl. `Preferred` and a nickname table) / one typo | +2 / +1 |

Thresholds: **matched** needs ≥ 7 and a ≥ 2 margin over the runner-up; **ambiguous**
is ≥ 4; below that it is **not found**.

A phone match names the field it hit — `phone (wireless)` rather than `phone`. The weight
is the same either way, but a household shares a landline and rarely shares a mobile, so
which one fired is the difference between weak and strong evidence when a human reads it.

Candidates are blocked on the hard signals — a patient is only scored if it shares a
DOB, email, phone or name token with the row — so a row sharing nothing is genuinely
not found rather than force-fitted to the nearest string.

## The discount-plan check

For every member matched to a PatNum, the report also says whether they are **already on
the right discount plan**. Read-only — `correct` means *no action*, and effective dates on
people who are already right are never touched. Design notes and the write-phase questions
are in [`docs/discount-plan-verification.md`](docs/discount-plan-verification.md).

The current plan comes from **`discountplansub`**, not `patient.DiscountPlanNum` — that
column is zero for every patient in this install, so a report built on it would call the
whole practice unenrolled while looking like a clean run. It is a second `SELECT`, loaded
into a map keyed by PatNum; joining it into the patient query would multiply patient rows
and break the matcher.

### The plan mapping is configuration, not code

The CSV's `Plan` and `Add-ons` columns *together* pick one plan — `Add-ons` is not a
separate axis, and the 3-month / 6-month prefix does not affect which plan is correct.
That mapping lives in **`plans.config.json`**, not in a source file:

```json
{ "plan": "6 Month- Adult", "addOns": "Fluoride", "discountPlanNum": 2, "description": "In Office Plan w/Fluoride" }
```

Whoever holds the real export is not necessarily whoever can push a commit, so correcting
the mapping must not require one. Point at a different file with `--plan-map <file>` (CLI)
or `PLAN_MAP_FILE` (web). A malformed or ambiguous mapping fails at startup with the
offending entry named, rather than quietly checking nothing.

**The values shipped here were checked against the real export on 8/19** and the file
carries `"confirmed": true`; until it does, the CLI and the page say so on every run and
`pnpm apply` refuses to write at all. Two things the sample had wrong and the real file
settled: the add-on column says **`Fluoride Varnish`**, not `Fluoride` (both spellings are
mapped now), and there are **child plans**, which all go to plan 2 — OD has no
child-specific plan and children are on the w/Fluoride plan. An unrecognised combination is
never resolved to a default: the row is
reported as `unknown_csv_plan` and the page names the offending strings, because a silent
fallthrough would report "correct" for members nobody has actually checked.

### Finding out what to put in it

`pnpm discover` prints the distinct plan strings in an export and the discount plans in
Open Dental — **counts only, with no name, DOB, contact detail or PatNum in the output**,
so the result can be pasted into a chat or a ticket by whoever has the file:

```sh
pnpm discover ./members.csv        # both halves
pnpm discover ./members.csv --skip-od
pnpm discover                      # Open Dental only
```

It also breaks the chart population down by `PatStatus`, which is what the active-charts
toggle needs to be decided on something other than a guess.

| Verdict | Meaning |
| --- | --- |
| `correct` | already right — **no action** |
| `wrong_plan` | on a different mapped plan |
| `no_sub` | matched patient with no active subscription |
| `unmapped_od_plan` | on a plan outside the table (4, 6, 7…) — human review, raw number shown |
| `should_drop` | membership cancelled, patient still holds a mapped plan — **term it** |
| `cancelled` | membership cancelled, nothing on the patient to take off — no action |
| `unknown_csv_plan` | CSV plan string we do not recognise |
| `conflict` | two CSV rows disagree about one patient, or the patient has two active subs |
| `ineligible` | never matched — no PatNum to act on, and **not** counted as correct |

Only `wrong_plan`, `no_sub` and `should_drop` are counted as **actionable**. Conflicts are held back
rather than resolved: the export repeats people, and two rows for one patient that
disagree about the plan are a question for a human, not two API calls.

### Running it locally against real MySQL

The local Open Dental container ships with `discountplan` and `discountplansub` empty, so
seed them once — this is the only thing in the repo that writes to a database, and it
**refuses to run against anything but loopback**:

```sh
pnpm seed:local-od-plans
pnpm match sample/members.demo-od.sample.csv
```

That sample is built around the container's demo patients and reaches every verdict:
correct, wrong plan, no sub, unmapped plan, conflict (a patient with two active subs),
unknown CSV plan, one member who is not in the database at all, a cancelled member still
holding a plan (`should_drop`), a cancelled member with nothing to take off, and a
cancelled row for someone who has since re-enrolled — which is *not* a drop. Note the container
holds two schemas — the patients are in **`demo`**, not `opendental`, so `OD_DB_URL` needs
`…:3307/demo`.

Against the database the check always runs. Against a patient fixture it needs
`--subs-fixture` / `OD_SUBS_FIXTURE` too — without one it goes dark rather than reporting
every member as unenrolled:

```sh
pnpm match sample/members.sample.csv \
  --fixture sample/od-patients.sample.json \
  --subs-fixture sample/od-discount-subs.sample.json

# the buckets that the main sample does not reach — an unknown plan string,
# and two rows for one patient asking for different plans
pnpm match sample/members.plan-edge.sample.csv \
  --fixture sample/od-patients.sample.json \
  --subs-fixture sample/od-discount-subs.sample.json
```

### Expect a sizeable not-found bucket

The membership roster and the patient list are maintained separately, so they are not
expected to line up. Quantifying that gap is part of the value of this pass — do not
treat it as a bug in the matcher.

## Safety

- **Everything except `pnpm apply --apply` is read-only.** Matching, the plan check, the
  review UI, `pnpm discover` and the dry run run `SELECT` and nothing else, over
  `OD_DB_URL`. Use a SELECT-only MySQL user for them if one exists.
- The write phase writes over the **REST API**, never over SQL, and only ever
  `discountplansub` rows: `PUT` to set a `DateTerm`, `POST` to add a subscription. No
  `DELETE`, and nothing else in the database is touched. Its own reads and its
  before/after verification still go through the read-only SQL path.
- `DATE` columns are read as strings (`dateStrings: true`) so the driver's local-timezone
  conversion cannot shift a birthdate by a day.
- The member export and the report are PHI. `.gitignore` covers `out/`, `data/` and
  `*.xlsx`; keep the real CSV out of the repo.
- The server answers only requests whose `Host` is loopback. Binding to `127.0.0.1` keeps
  the network out but not DNS rebinding — without the check, a page open in the operator's
  browser could point its own hostname at `127.0.0.1` and read `/api/results`.
- Every value rendered into the results table is escaped, including the ones that come
  from the CSV rather than from OD.

## The write phase

`pnpm apply <members.csv>` — **dry run by default**. It rebuilds the report, turns it into
one intent per patient, prints the change set (`current plan → target → action`) and writes
`out/changeset.csv` for sign-off. That is the whole run unless `--apply` is passed.

```sh
pnpm apply ./members.csv                                     # dry run — writes nothing
pnpm apply ./members.csv --only drop    --apply --expect 412  # drops first
pnpm apply ./members.csv --only migrate --limit 10 --apply --expect 10   # pilot ten
pnpm apply ./members.csv --only migrate --apply --expect 176  # then the rest
```

| Flag | Effect |
| --- | --- |
| `--apply` | actually write. Refused without `--expect` |
| `--expect <n>` | the change count that was signed off; a mismatch aborts the run |
| `--only drop,add,migrate` | restrict to these actions |
| `--limit <n>` | only the first n patients — this is how the pilot runs |
| `--decisions <review.csv>` | honour the reviewer's decisions from an exported `review.csv` |
| `--order <a>` | `add-then-term` (default) or `term-then-add` |
| `--term-date <date>` | the `DateTerm` to write (default: today) |
| `--include-inactive-charts` | also add/migrate on charts that are not `PatStatus = Patient` |
| `--log <file>` / `--fresh` | the per-patient JSONL log and resume index |

**One intent per patient, not per row.** The export repeats people: two rows asking for the
same thing are one write, and two rows asking for different things are not a write at all.

**Cancelled members are dropped, never migrated.** A cancelled Perio member is not moved
onto plan 3 and then termed — whatever they hold is termed, and nothing else. A cancelled
row for someone who has since re-enrolled is not a drop either: the active row governs.

**Every write is bracketed by a SQL re-read.** Before, to check the patient still looks like
the plan assumed — anything that moved is skipped, never guessed. After, to confirm the end
state is exactly one active sub on the intended plan. This is SQL and not the API because
`GET /discountplansubs?PatNum=` returns a single object, so it can neither prove which sub
is current nor reveal a double-subscribe.

**A failed run is re-run with the same command.** Every patient appends a record — before,
calls, after, outcome — to `out/apply-log.jsonl`, which is also the resume index. Only a
completed **write** counts as done: failures stay outstanding, and so do skips, because a
skip is the tool declining to write ("they now have two active subs") and that is exactly
the case a human goes and fixes. Three consecutive failures stop the run, including
connection failures — a dropped connection is one patient's failure, logged and counted,
not an exception that ends the batch without recording where it got to.

**The run names what it is writing to** before the first call, and says whether that is
loopback or a real Open Dental. `--decisions` refuses a `review.csv` that does not describe
the CSV in front of it: decisions are keyed by row number, and against last month's export
every one of them would land on whoever occupies that row today.

### Trying it against the local container first

The local Open Dental here is MariaDB with no REST service in front of it, so
`scripts/fake-od-api.ts` implements the two endpoints against the seeded container. It is
loopback-only and refuses to start against a non-loopback database.

```sh
pnpm seed:local-od-plans
pnpm fake-od-api                                   # 127.0.0.1:5179
OD_API_URL=http://127.0.0.1:5179 OD_API_TOKEN=local/dev   pnpm apply sample/members.demo-od.sample.csv --apply --expect 1 --only drop
```

`FAKE_OD_REJECT_OVERLAP=1` makes it refuse a `POST` for a patient who already holds an
active sub, which is the branch `add-then-term` has to survive. It does: the first call
fails, the patient is left exactly as they were, and `--order term-then-add` completes.

A local pass proves our sequencing, verification, logging and resume are right. It does not
prove the real API tolerates the overlap — that is the stub's behaviour, not OD's, and the
first pilot patient answers it.

## Still open

- The **active-charts-only** default is still Matthew's call. It is a matching question and
  separate from the write phase's chart guard, which is decided: drops go ahead on any
  chart, adds and migrations onto a chart that is not `PatStatus = Patient` are held back
  into `changeset-held-back.csv`.
- **Owner sign-off on the first live write.** The dry run's change set and its `--expect`
  number are the thing to sign off.
