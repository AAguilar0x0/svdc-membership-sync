/**
 * The Open Dental REST API, narrowed to the two calls the plan reconciliation makes.
 *
 * This is the only part of the project that writes anything to Open Dental. It writes
 * `discountplansub` rows and nothing else, and it never issues a `DELETE`: dropping a
 * plan is terming it, which keeps the audit trail on a table that has been terminated
 * three times in its life.
 *
 * **It does not read.** `GET /discountplansubs?PatNum=` returns a single object, so it
 * cannot show a patient's true current sub or reveal a double-subscribe — the two things
 * a write phase has to know. Reads and verification go through SQL (`readActiveSubsForPatient`),
 * which is why this file has no getter on it.
 */

export type OdApiConfig = {
  baseUrl: string
  authorization: string
  /** Minimum gap between writes. OD Cloud rate-limits; the local API does not care. */
  rateLimitMs: number
  /** Per-request ceiling. Without one a hung OD stalls the whole batch indefinitely. */
  timeoutMs: number
}

/**
 * `ODFHIR {DeveloperKey}/{CustomerKey}` is the documented scheme. A pre-built
 * `OD_API_TOKEN` is accepted as-is so an operator holding one header string does not
 * have to take it apart.
 */
export const loadOdApiConfig = (): OdApiConfig => {
  const baseUrl = process.env.OD_API_URL?.trim()
  if (!baseUrl) {
    throw new Error('OD_API_URL is not set. It is only needed for --apply; see .env.example.')
  }
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`OD_API_URL must be an http(s) URL — got "${baseUrl}".`)

  const token = process.env.OD_API_TOKEN?.trim()
  const developerKey = process.env.OD_DEVELOPER_KEY?.trim()
  const customerKey = process.env.OD_CUSTOMER_KEY?.trim()

  const authorization = token
    ? token.startsWith('ODFHIR ')
      ? token
      : `ODFHIR ${token}`
    : developerKey && customerKey
      ? `ODFHIR ${developerKey}/${customerKey}`
      : ''

  if (authorization === '') {
    throw new Error('Set OD_DEVELOPER_KEY and OD_CUSTOMER_KEY (or OD_API_TOKEN) to authenticate against the OD API.')
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    authorization,
    rateLimitMs: positiveNumber(process.env.OD_WRITE_RATE_LIMIT_MS, 1000, 'OD_WRITE_RATE_LIMIT_MS'),
    timeoutMs: positiveNumber(process.env.OD_API_TIMEOUT_MS, 30_000, 'OD_API_TIMEOUT_MS'),
  }
}

/**
 * A misspelt number here used to be silent and one-directional: `Number('5s')` is `NaN`,
 * every comparison against it is false, and the rate limit simply stops existing. Fail
 * instead — an unpaced batch against OD Cloud is not something to discover from the logs.
 */
const positiveNumber = (raw: string | undefined, fallback: number, name: string) => {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number — got "${raw}".`)
  return value
}

export type OdApiCall = {
  method: 'POST' | 'PUT'
  path: string
  body: Record<string, unknown>
}

/** What went over the wire, for the per-patient log. The key never appears in it. */
export type OdApiOutcome = {
  call: OdApiCall
  status: number
  ok: boolean
  response: unknown
}

export class OdApi {
  private readonly config: OdApiConfig
  private lastWriteAt = 0

  constructor(config: OdApiConfig) {
    this.config = config
  }

  /**
   * Term an existing subscription. `PatNum` is required in the body as well as the URL.
   *
   * This cannot change the plan: `PUT` accepts `DateEffective`, `DateTerm` and `SubNote`
   * and nothing else, which is the whole reason a plan change is two calls.
   */
  term(discountSubNum: number, patNum: number, dateTerm: string) {
    return this.send({
      method: 'PUT',
      path: `/discountplansubs/${discountSubNum}`,
      body: { PatNum: patNum, DateTerm: dateTerm },
    })
  }

  /**
   * Add a subscription. `DateEffective` is deliberately omitted: it defaults to
   * `0001-01-01`, OD's zero-date sentinel, which is the value we want.
   */
  add(patNum: number, discountPlanNum: number) {
    return this.send({
      method: 'POST',
      path: '/discountplansubs',
      body: { DiscountPlanNum: discountPlanNum, PatNum: patNum },
    })
  }

  /**
   * Wait out the rate limit *without* consuming it.
   *
   * Called by the executor before it re-reads a patient, so the gap between writes is
   * spent before the read rather than after it. Pacing after the read would leave the
   * read stale by a whole interval — long enough for someone to enroll the patient in
   * between, which is how you double-subscribe while believing you checked.
   */
  async pace() {
    const wait = this.lastWriteAt + this.config.rateLimitMs - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  private async send(call: OdApiCall): Promise<OdApiOutcome> {
    await this.pace()

    let response: Response
    try {
      response = await fetch(`${this.config.baseUrl}${call.path}`, {
        method: call.method,
        headers: { Authorization: this.config.authorization, 'content-type': 'application/json' },
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error: unknown) {
      // A dropped connection is one patient's failure, not the run's. Thrown from here it
      // would escape the executor and kill the batch *without* writing that patient's log
      // record — the one thing a resumable run cannot afford to lose. Reported as an
      // outcome instead, so it is logged, counted, and subject to the stop-after-failures
      // rule like any other failure.
      this.lastWriteAt = Date.now()
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      return { call, status: 0, ok: false, response: `request did not complete — ${reason}` }
    }

    this.lastWriteAt = Date.now()

    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      // Leave it as the raw string; a non-JSON body is itself the diagnostic.
    }

    return { call, status: response.status, ok: response.ok, response: parsed }
  }
}
