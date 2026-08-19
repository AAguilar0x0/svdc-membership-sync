import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import mysql from 'mysql2/promise'
import 'dotenv/config'

/**
 * A stand-in for the two Open Dental endpoints the write phase calls, backed by the
 * **local** seeded container.
 *
 * It exists because the local Open Dental here is a MariaDB container with no REST service
 * in front of it, so without this the write path could only ever be run for the first time
 * against the live practice database. With it, the whole apply run — re-read, write,
 * verify, log, resume — is exercised end to end over real HTTP against real MySQL.
 *
 * **What a local pass does and does not prove.** It proves our sequencing, our SQL
 * verification and our logging are right. It does not prove Open Dental tolerates two
 * active subscriptions during an add-then-term, because that is this server's behaviour,
 * not OD's. Set `FAKE_OD_REJECT_OVERLAP=1` to make it refuse the overlapping POST and
 * exercise the other branch; which one the real API does is a question only the real API
 * answers, and the answer is one pilot patient away.
 *
 * Loopback only, and refuses to run against anything but a loopback database — this
 * writes, and the project's claim is that nothing but the local container is ever written.
 */

const PORT = Number(process.env.FAKE_OD_PORT ?? 5179)
const REJECT_OVERLAP = process.env.FAKE_OD_REJECT_OVERLAP === '1'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const ZERO_DATE = '0001-01-01'

const url = process.env.OD_DB_URL
if (!url) throw new Error('OD_DB_URL is not set.')

const dbHost = new URL(url).hostname
if (!LOOPBACK_HOSTS.has(dbHost)) {
  throw new Error(
    `Refusing to start: OD_DB_URL points at "${dbHost}", which is not loopback. ` +
      'This server writes, and it may only ever write to the local container.',
  )
}

const pool = mysql.createPool({ uri: url, dateStrings: true, connectionLimit: 4 })

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
}

const subById = async (discountSubNum: number) => {
  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM discountplansub WHERE DiscountSubNum = ?', [
    discountSubNum,
  ])
  return rows.at(0)
}

const server = createServer((req, res) => {
  void (async () => {
    const requestUrl = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    const path = requestUrl.pathname.replace(/\/$/, '')

    try {
      // The real API rejects an unauthenticated call; so does this, so a missing key is
      // caught locally rather than on the first live request.
      if (!req.headers.authorization) return json(res, 401, { error: 'Missing Authorization header.' })

      if (req.method === 'POST' && path === '/discountplansubs') {
        const body = await readBody(req)
        const patNum = Number(body.PatNum)
        const discountPlanNum = Number(body.DiscountPlanNum)
        if (!patNum || !discountPlanNum) {
          return json(res, 400, { error: 'DiscountPlanNum and PatNum are required.' })
        }

        if (REJECT_OVERLAP) {
          const [active] = await pool.query<mysql.RowDataPacket[]>(
            'SELECT DiscountSubNum FROM discountplansub WHERE PatNum = ? AND DateTerm = ?',
            [patNum, ZERO_DATE],
          )
          if (active.length > 0) {
            return json(res, 400, { error: 'Patient already has an active discount plan subscription.' })
          }
        }

        // DateEffective omitted on purpose: it defaults to the zero-date sentinel.
        const [result] = await pool.query<mysql.ResultSetHeader>(
          `INSERT INTO discountplansub (DiscountPlanNum, PatNum, DateEffective, DateTerm, SubNote)
           VALUES (?, ?, ?, ?, ?)`,
          [
            discountPlanNum,
            patNum,
            typeof body.DateEffective === 'string' ? body.DateEffective : ZERO_DATE,
            typeof body.DateTerm === 'string' ? body.DateTerm : ZERO_DATE,
            typeof body.SubNote === 'string' ? body.SubNote : '',
          ],
        )
        return json(res, 201, await subById(result.insertId))
      }

      const putMatch = req.method === 'PUT' && /^\/discountplansubs\/(\d+)$/.exec(path)
      if (putMatch) {
        const discountSubNum = Number(putMatch[1])
        const body = await readBody(req)
        const existing = await subById(discountSubNum)
        if (!existing) return json(res, 404, { error: `DiscountSubNum ${discountSubNum} does not exist.` })

        // PatNum is required in the body as well as the URL, and it has to be the row's own.
        if (Number(body.PatNum) !== Number(existing.PatNum)) {
          return json(res, 400, { error: 'PatNum is required and must match the subscription.' })
        }
        // The real PUT takes DateEffective, DateTerm and SubNote — and nothing else. It
        // cannot change DiscountPlanNum, which is the whole reason a plan change is two calls.
        if (body.DiscountPlanNum !== undefined) {
          return json(res, 400, { error: 'DiscountPlanNum cannot be changed with PUT.' })
        }

        await pool.query(
          'UPDATE discountplansub SET DateEffective = ?, DateTerm = ?, SubNote = ? WHERE DiscountSubNum = ?',
          [
            typeof body.DateEffective === 'string' ? body.DateEffective : existing.DateEffective,
            typeof body.DateTerm === 'string' ? body.DateTerm : existing.DateTerm,
            typeof body.SubNote === 'string' ? body.SubNote : existing.SubNote,
            discountSubNum,
          ],
        )
        return json(res, 200, await subById(discountSubNum))
      }

      // Mirrored faithfully, including the part that makes it useless to us: one object,
      // so it can neither prove which sub is current nor show a double-subscribe.
      if (req.method === 'GET' && path === '/discountplansubs') {
        const patNum = Number(requestUrl.searchParams.get('PatNum'))
        const [rows] = await pool.query<mysql.RowDataPacket[]>(
          'SELECT * FROM discountplansub WHERE PatNum = ? ORDER BY DiscountSubNum',
          [patNum],
        )
        return json(res, 200, rows.at(0) ?? null)
      }

      json(res, 404, { error: `No route for ${req.method} ${path}.` })
    } catch (error: unknown) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  fake Open Dental API — local container only

  http://127.0.0.1:${PORT}     database ${dbHost}
  overlapping POST: ${REJECT_OVERLAP ? 'REJECTED (FAKE_OD_REJECT_OVERLAP=1)' : 'allowed'}

  Point the write phase at it with OD_API_URL=http://127.0.0.1:${PORT}.
  It writes to the local seeded container and nothing else.
`)
})
