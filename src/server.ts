import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

import { parseMemberCsv } from './csv.ts'
import { matchRow, type MatchResult } from './match.ts'
import {
  buildOdIndex,
  loadActiveDiscountSubs,
  loadActiveDiscountSubsFromFixture,
  loadOdPatients,
  loadOdPatientsFromFixture,
  type ActiveSubs,
  type OdIndex,
  type OdPatient,
} from './od.ts'
import {
  checkPlans,
  groupDuplicates,
  resolveRows,
  summarize,
  summarizePlans,
  toCsv,
  toReviewRecord,
  type Decisions,
} from './report.ts'

/**
 * Local review UI. Runs on the operator's machine, binds to loopback only, and never
 * writes to Open Dental — it reads the patient table and serves the three-way split
 * so a human can confirm the ambiguous rows before anyone is enrolled.
 *
 * Deliberately zero-build: node:http plus one HTML file, reusing the same matching
 * core as the CLI.
 */

const PORT = Number(process.env.PORT ?? 5178)
const FIXTURE = process.env.OD_FIXTURE
const SUBS_FIXTURE = process.env.OD_SUBS_FIXTURE
const UI_PATH = fileURLToPath(new URL('./ui.html', import.meta.url))

/**
 * Against the database the plan check always runs. Against a patient fixture it needs a
 * subscription fixture too — without one, every member would be reported as having no plan
 * on file, which is a wrong answer wearing the clothes of a real one. So it goes dark instead.
 */
const PLAN_CHECK_ENABLED = FIXTURE === undefined || SUBS_FIXTURE !== undefined

/** In-memory only — nothing about a run is persisted to disk unless the user exports. */
type Session = {
  fileName: string
  results: MatchResult[]
  duplicateGroups: Map<number, string>
  decisions: Decisions
  odPatientCount: number
  loadedAt: string
}

let session: Session | undefined
let odIndex: OdIndex | undefined
let odSubs: ActiveSubs = { byPatNum: new Map(), multipleActive: [] }
let odError: string | undefined

const loadOd = async (force = false) => {
  if (odIndex && !force) return odIndex

  const patients: OdPatient[] = FIXTURE
    ? await loadOdPatientsFromFixture(resolve(FIXTURE))
    : await loadOdPatients(requireDbUrl())

  if (PLAN_CHECK_ENABLED) {
    odSubs = SUBS_FIXTURE
      ? await loadActiveDiscountSubsFromFixture(resolve(SUBS_FIXTURE))
      : await loadActiveDiscountSubs(requireDbUrl())
  }

  odIndex = buildOdIndex(patients)
  odError = undefined
  return odIndex
}

const requireDbUrl = () => {
  const url = process.env.OD_DB_URL
  if (!url) throw new Error('OD_DB_URL is not set. Copy .env.example to .env, or set OD_FIXTURE for an offline run.')
  return url
}

/**
 * Binding to loopback keeps the network out, but it does not stop DNS rebinding: a page
 * open in the operator's browser can point its own hostname at 127.0.0.1 and then read
 * /api/results and /api/export, which are PHI. Only a loopback `Host` is served.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const isLoopbackHost = (host: string | undefined) =>
  LOOPBACK_HOSTS.has((host ?? '').replace(/:\d+$/, '').toLowerCase())

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // A membership export is a few hundred KB; anything past this is a mistake.
    if (size > 25 * 1024 * 1024) throw new Error('Upload is too large (limit 25 MB).')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** The shape the UI renders. Candidates are always sent, matched or not. */
const toClientRow = (
  row: ReturnType<typeof resolveRows>[number],
  decisions: Decisions,
) => ({
  rowNumber: row.result.row.rowNumber,
  status: row.status,
  autoStatus: row.result.status,
  resolvedBy: row.resolvedBy,
  verdict: row.result.verdict,
  margin: row.result.margin,
  duplicateGroup: row.duplicateGroup,
  decision: decisions.get(row.result.row.rowNumber) ?? null,
  chosenPatNum: row.chosen?.patient.patNum ?? null,
  csv: row.result.row.raw,
  candidates: row.result.candidates.map((candidate) => ({
    patNum: candidate.patient.patNum,
    name: candidate.patient.displayName,
    dob: candidate.patient.dob,
    email: candidate.patient.email,
    phones: candidate.patient.phones,
    patStatus: candidate.patient.patStatusLabel,
    score: candidate.score,
    reasons: candidate.reasons,
  })),
})

const buildPayload = (current: Session) => {
  const resolved = resolveRows(current.results, current.decisions, current.duplicateGroups)
  const checks = checkPlans(resolved, odSubs)

  return {
    fileName: current.fileName,
    loadedAt: current.loadedAt,
    odPatientCount: current.odPatientCount,
    planCheckEnabled: PLAN_CHECK_ENABLED,
    summary: summarize(resolved, current.duplicateGroups),
    planSummary: PLAN_CHECK_ENABLED ? summarizePlans(checks) : null,
    rows: resolved.map((row) => ({
      ...toClientRow(row, current.decisions),
      plan: PLAN_CHECK_ENABLED ? (checks.byRowNumber.get(row.result.row.rowNumber) ?? null) : null,
    })),
  }
}

const handlers: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>> = {
  'GET /': async (_req, res) => {
    const html = await readFile(UI_PATH)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  },

  'GET /api/status': async (_req, res) => {
    json(res, 200, {
      source: FIXTURE ? `fixture: ${FIXTURE}` : 'Open Dental MySQL (read-only)',
      configured: FIXTURE !== undefined || Boolean(process.env.OD_DB_URL),
      odLoaded: odIndex !== undefined,
      odPatientCount: odIndex?.patients.length ?? 0,
      planCheckEnabled: PLAN_CHECK_ENABLED,
      activeSubCount: odSubs.byPatNum.size,
      odError,
      hasSession: session !== undefined,
    })
  },

  'POST /api/od/reload': async (_req, res) => {
    const index = await loadOd(true)
    json(res, 200, { odPatientCount: index.patients.length })
  },

  'POST /api/match': async (req, res) => {
    const index = await loadOd()
    const body = await readBody(req)
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'members.csv'))

    const rows = parseMemberCsv(body)
    if (rows.length === 0) throw new Error('No usable rows in that CSV.')

    session = {
      fileName,
      results: rows.map((row) => matchRow(row, index)),
      duplicateGroups: groupDuplicates(rows),
      decisions: new Map(),
      odPatientCount: index.patients.length,
      loadedAt: new Date().toISOString(),
    }

    json(res, 200, buildPayload(session))
  },

  'GET /api/results': async (_req, res) => {
    if (!session) return json(res, 404, { error: 'No CSV loaded yet.' })
    json(res, 200, buildPayload(session))
  },

  'POST /api/decision': async (req, res) => {
    if (!session) return json(res, 404, { error: 'No CSV loaded yet.' })

    const body = JSON.parse((await readBody(req)).toString('utf8')) as {
      rowNumber?: unknown
      patNum?: unknown
    }
    const rowNumber = Number(body.rowNumber)
    if (!Number.isInteger(rowNumber)) return json(res, 400, { error: 'rowNumber must be an integer.' })

    // `undefined` clears the override and falls back to the automatic verdict;
    // `null` is an explicit "none of these".
    if (body.patNum === undefined) session.decisions.delete(rowNumber)
    else session.decisions.set(rowNumber, { patNum: body.patNum === null ? null : Number(body.patNum) })

    json(res, 200, buildPayload(session))
  },

  'GET /api/export': async (_req, res, url) => {
    if (!session) return json(res, 404, { error: 'No CSV loaded yet.' })

    const bucket = url.searchParams.get('bucket') ?? 'review'
    const resolved = resolveRows(session.results, session.decisions, session.duplicateGroups)
    const checks = checkPlans(resolved, odSubs)
    const records = resolved
      .filter((row) => bucket === 'review' || row.status === bucket)
      .map((row) => toReviewRecord(row, PLAN_CHECK_ENABLED ? checks.byRowNumber.get(row.result.row.rowNumber) : undefined))

    const csv = toCsv(records)
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${bucket === 'not_found' ? 'not-found' : bucket}.csv"`,
    })
    res.end(csv)
  },
}

const server = createServer((req, res) => {
  void (async () => {
    if (!isLoopbackHost(req.headers.host)) {
      return json(res, 403, { error: 'Blocked: this tool only serves requests addressed to localhost.' })
    }

    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    const handler = handlers[`${req.method} ${url.pathname}`]

    if (!handler) return json(res, 404, { error: 'Not found' })

    try {
      await handler(req, res, url)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (url.pathname.startsWith('/api/od') || url.pathname === '/api/match') odError = message
      if (!res.headersSent) json(res, 500, { error: message })
      else res.end()
    }
  })()
})

// Loopback only: this serves PHI and must never be reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  svdc-membership-sync — patient matching review

  http://localhost:${PORT}

  Patient source: ${FIXTURE ? `fixture ${FIXTURE}` : 'Open Dental MySQL (read-only)'}
  Read-only. Nothing is written to Open Dental, and no upload is persisted to disk.
`)
})
