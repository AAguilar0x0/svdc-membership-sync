import mysql from 'mysql2/promise'
import 'dotenv/config'

/**
 * Put discount plans and subscriptions into the **local** Open Dental container, so the
 * plan check has a real MySQL path to run against instead of only JSON fixtures — and so
 * the write phase, when it is built, has somewhere safe to be wrong.
 *
 * This is the only thing in this repo that writes to a database, and it refuses to run
 * against anything but loopback. The tool's whole claim is that it never writes to Open
 * Dental; a seeding script that could be pointed at the practice's VM by editing one
 * environment variable would quietly make that claim false.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** Descriptions match the real practice's plans so the local output reads like the real thing. */
const PLANS = [
  { num: 1, description: 'In Office Plan' },
  { num: 2, description: 'In Office Plan w/Fluoride' },
  { num: 3, description: 'In Office Plan Perio' },
  { num: 5, description: 'In Office Plan Perio W/ Fluoride' },
  { num: 7, description: 'Employee Benefits' },
] as const

/**
 * Spread across whatever patients the container has, so every bucket the report can
 * produce is reachable locally: correct, wrong plan, no sub, an unmapped plan, and a
 * patient carrying two active subs (which no real patient does — that is the point).
 */
const SUB_PATTERN = [
  { offset: 0, plan: 1, effective: '2025-01-15' },
  { offset: 1, plan: 3, effective: '2025-03-01' },
  { offset: 2, plan: 2, effective: '0001-01-01' },
  { offset: 3, plan: 7, effective: '2024-11-02' },
  { offset: 4, plan: 5, effective: '2025-04-04' },
  { offset: 5, plan: 1, effective: '2025-05-09' },
  { offset: 5, plan: 2, effective: '2025-07-01' },
  { offset: 6, plan: 2, effective: '2025-08-18' },
  // The last two exist for the cancelled half of the export: one member who cancelled and
  // is still holding a plan, and one who cancelled an old membership but is on a live one.
  { offset: 11, plan: 1, effective: '2024-02-01' },
  { offset: 12, plan: 2, effective: '2024-03-01' },
] as const

const main = async () => {
  const url = process.env.OD_DB_URL
  if (!url) throw new Error('OD_DB_URL is not set.')

  const host = new URL(url).hostname
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to seed: OD_DB_URL points at "${host}", which is not loopback. ` +
        'This script writes, and it may only ever write to the local container.',
    )
  }

  const connection = await mysql.createConnection({ uri: url, dateStrings: true, multipleStatements: false })

  try {
    const [patients] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT PatNum FROM patient WHERE PatStatus <> 4 ORDER BY PatNum',
    )
    if (patients.length === 0) {
      throw new Error(
        'No patients in this database. Seed the OD container first ' +
          '(`pnpm setup` in svdc-webapp), and check OD_DB_URL names the right schema.',
      )
    }

    await connection.query('DELETE FROM discountplansub')
    await connection.query('DELETE FROM discountplan')

    for (const plan of PLANS) {
      await connection.query(
        `INSERT INTO discountplan
           (DiscountPlanNum, Description, FeeSchedNum, DefNum, IsHidden, PlanNote,
            ExamFreqLimit, XrayFreqLimit, ProphyFreqLimit, FluorideFreqLimit,
            PerioFreqLimit, LimitedExamFreqLimit, PAFreqLimit, AnnualMax)
         VALUES (?, ?, 0, 0, 0, '', 0, 0, 0, 0, 0, 0, 0, -1)`,
        [plan.num, plan.description],
      )
    }

    let subs = 0
    for (const entry of SUB_PATTERN) {
      const patient = patients.at(entry.offset)
      if (!patient) continue
      await connection.query(
        `INSERT INTO discountplansub (DiscountPlanNum, PatNum, DateEffective, DateTerm, SubNote)
         VALUES (?, ?, ?, '0001-01-01', '')`,
        [entry.plan, patient.PatNum, entry.effective],
      )
      subs += 1
    }

    // One terminated row, so "active only" in the query is doing something observable.
    const terminated = patients.at(7) ?? patients.at(0)
    await connection.query(
      `INSERT INTO discountplansub (DiscountPlanNum, PatNum, DateEffective, DateTerm, SubNote)
       VALUES (1, ?, '2023-01-01', '2024-06-30', 'ended')`,
      [terminated!.PatNum],
    )

    console.log(
      `\nSeeded ${PLANS.length} discount plan(s) and ${subs} active subscription(s) ` +
        `(plus 1 terminated) across ${patients.length} local patient(s) on ${host}.\n` +
        'Local container only — nothing about the practice database was touched.\n',
    )
  } finally {
    await connection.end()
  }
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
