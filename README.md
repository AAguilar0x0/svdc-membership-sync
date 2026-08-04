# svdc-membership-sync

One-time local tool for reconciling a membership-plan export against Open Dental. This
repo implements the first half of that: **matching each member to a patient number**.

It is deliberately *not* part of `svdc-webapp`: no product feature, no scheduler job, no
service layer. The review UI here is a local page served from this repo, run on the
operator's machine for the length of one reconciliation, and thrown away once the
membership vendor writes to Open Dental directly.

Zero build step on purpose — `node:http` and one HTML file, sharing the matching core
with the CLI.

## What it does

Reads the membership CSV (`Patient Name, DOB, Email, Phone, Plan Start Date, Plan,
Add-ons, Active`), reads the Open Dental `patient` table with a **single SELECT**,
and produces a reviewable **three-way split** — matched / ambiguous / not found.

It never writes. Not to Open Dental, not anywhere. Enrolling the matched patients on
the discount plan is a separate step that only runs once this report is approved.

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
| `--active-only` | skip rows whose `Active` column is falsy |
| `--include-deleted` | also consider OD patients with `PatStatus = Deleted` (excluded by default) |
| `--fixture <file>` | match against a JSON patient fixture instead of the DB — offline dry run |

## The review UI

`pnpm web` serves a local page on **127.0.0.1 only** — it handles PHI and must never be
reachable from the network. Set `PORT` to move it.

- **Summary tiles** — matched / ambiguous / not found, distinct PatNums, duplicate rows.
- **A collision banner** when one PatNum is claimed by more than one CSV row.
- **Tabs and search**, including a **Needs review** tab: everything the matcher would not
  call on its own.
- **Expand any row** to see every candidate it considered, with its score and the exact
  signals that fired (`DOB + phone + last name`). For an ambiguous row you pick the right
  patient, or say **None of these**. **Undo my decision** puts it back to the automatic verdict.
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

Every row carries its original CSV columns through, so `matched.csv` is directly
consumable by the enrollment step.

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
| Email matches / conflicts | +4 / −1 |
| Phone matches any of `HmPhone`, `WirelessPhone`, `WkPhone` / conflicts | +3 / −1 |
| Last name exact / one typo | +2 / +1 |
| First name exact (incl. `Preferred` and a nickname table) / one typo | +2 / +1 |

Thresholds: **matched** needs ≥ 7 and a ≥ 2 margin over the runner-up; **ambiguous**
is ≥ 4; below that it is **not found**.

Candidates are blocked on the hard signals — a patient is only scored if it shares a
DOB, email, phone or name token with the row — so a row sharing nothing is genuinely
not found rather than force-fitted to the nearest string.

### Expect a sizeable not-found bucket

The membership roster and the patient list are maintained separately, so they are not
expected to line up. Quantifying that gap is part of the value of this pass — do not
treat it as a bug in the matcher.

## Safety

- One statement runs against OD: `SELECT … FROM patient WHERE PatStatus <> 4`.
  Use a SELECT-only MySQL user if one exists.
- `DATE` columns are read as strings (`dateStrings: true`) so the driver's local-timezone
  conversion cannot shift a birthdate by a day.
- The member export and the report are PHI. `.gitignore` covers `out/`, `data/` and
  `*.xlsx`; keep the real CSV out of the repo.

## Still open before enrollment

- The Open Dental discount-plan identifiers for each plan named in the CSV.
- Read a patient's existing plan subscriptions before adding one, to decide add-vs-update.
  The create call has no idempotency key, so a blind re-run double-subscribes.
- Enrollment would be the first write this project makes to live Open Dental. Confirm
  that explicitly with the practice owner before the first run.
