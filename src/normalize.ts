/**
 * Normalisation helpers shared by both sides of the match. The membership CSV is
 * free-text ("stella aguirre", missing emails, phones in half a dozen shapes), so
 * every comparison happens on a normalised form, never on the raw string.
 */

const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v', 'md', 'dds'])

/** Common short forms → canonical first name, so "Bob" can meet "Robert". */
const NICKNAMES: Record<string, string> = {
  al: 'albert',
  alex: 'alexander',
  andy: 'andrew',
  bea: 'beatrice',
  ben: 'benjamin',
  beth: 'elizabeth',
  betty: 'elizabeth',
  bill: 'william',
  billy: 'william',
  bob: 'robert',
  bobby: 'robert',
  cathy: 'catherine',
  charlie: 'charles',
  chris: 'christopher',
  chuck: 'charles',
  cindy: 'cynthia',
  dan: 'daniel',
  danny: 'daniel',
  dave: 'david',
  debbie: 'deborah',
  dick: 'richard',
  don: 'donald',
  ed: 'edward',
  eddie: 'edward',
  fran: 'frances',
  frank: 'franklin',
  fred: 'frederick',
  gabe: 'gabriel',
  greg: 'gregory',
  hank: 'henry',
  jack: 'john',
  jake: 'jacob',
  jen: 'jennifer',
  jenny: 'jennifer',
  jerry: 'gerald',
  jim: 'james',
  jimmy: 'james',
  joe: 'joseph',
  joey: 'joseph',
  johnny: 'john',
  jon: 'jonathan',
  kate: 'katherine',
  kathy: 'katherine',
  ken: 'kenneth',
  larry: 'lawrence',
  liz: 'elizabeth',
  lupe: 'guadalupe',
  maggie: 'margaret',
  manny: 'manuel',
  matt: 'matthew',
  meg: 'margaret',
  mike: 'michael',
  nate: 'nathaniel',
  nick: 'nicholas',
  pam: 'pamela',
  pat: 'patricia',
  pete: 'peter',
  peggy: 'margaret',
  phil: 'philip',
  ray: 'raymond',
  rich: 'richard',
  rick: 'richard',
  rob: 'robert',
  ron: 'ronald',
  rosa: 'rosario',
  sal: 'salvador',
  sam: 'samuel',
  sandy: 'sandra',
  steve: 'steven',
  sue: 'susan',
  susie: 'susan',
  tim: 'timothy',
  tina: 'christina',
  tom: 'thomas',
  tony: 'anthony',
  vince: 'vincent',
  will: 'william',
}

const stripAccents = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/** Lowercase, de-accent, drop punctuation, collapse whitespace. */
export const normalizeName = (value: string | null | undefined) =>
  stripAccents(value ?? '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Nicknames collapse to a canonical form so "Bob"/"Robert" compare equal. */
export const canonicalFirstName = (value: string) => NICKNAMES[value] ?? value

export const normalizeEmail = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

/**
 * Last 10 digits, which is what survives "+1 (831) 555-0148" vs "8315550148"
 * vs an extension the CSV kept. Anything shorter is treated as unusable.
 */
export const normalizePhone = (value: string | null | undefined) => {
  const digits = (value ?? '').replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : ''
}

/**
 * Accepts the shapes the export and MySQL actually emit: `M/D/YYYY`, `YYYY-MM-DD`,
 * `M-D-YY`, and a `Date` (mysql2 returns `DATE` columns as `Date` unless told not to).
 * Returns `YYYY-MM-DD`, or `''` when the value is absent or OD's `0001-01-01` null date.
 */
export const normalizeDob = (value: string | Date | null | undefined) => {
  if (value == null) return ''
  if (value instanceof Date) return fromDate(value)

  const raw = value.trim()
  if (raw === '') return ''

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw)
  if (iso) return buildDate(iso[1]!, iso[2]!, iso[3]!)

  const slashed = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(raw)
  if (slashed) return buildDate(expandYear(slashed[3]!), slashed[1]!, slashed[2]!)

  return fromDate(new Date(raw))
}

const fromDate = (value: Date) => {
  if (Number.isNaN(value.getTime())) return ''
  return buildDate(String(value.getFullYear()), pad(value.getMonth() + 1), pad(value.getDate()))
}

const pad = (value: number) => String(value).padStart(2, '0')

const buildDate = (year: string, month: string, day: string) => {
  const iso = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  return iso.startsWith('0001-') ? '' : iso
}

/** Two-digit years in a DOB column are always in the past. */
const expandYear = (year: string) => {
  if (year.length === 4) return year
  const n = Number(year)
  const currentTwoDigit = new Date().getFullYear() % 100
  return String(n <= currentTwoDigit ? 2000 + n : 1900 + n)
}

export type NameParts = {
  first: string
  last: string
  /** Every token, for the cases where first/last order is guessed wrong. */
  tokens: string[]
}

/**
 * The CSV carries one free-text `Patient Name`. Handles "First Last",
 * "First Middle Last", "Last, First", and trailing suffixes.
 */
export const splitName = (value: string | null | undefined): NameParts => {
  const raw = (value ?? '').trim()

  if (raw.includes(',')) {
    const [lastPart = '', firstPart = ''] = raw.split(',', 2)
    const last = normalizeName(lastPart)
    const first = normalizeName(firstPart)
    const lastToken = last.split(' ').at(0) ?? ''
    const firstToken = first.split(' ').at(0) ?? ''
    return { first: firstToken, last: lastToken, tokens: dropSuffixes([...first.split(' '), ...last.split(' ')]) }
  }

  const tokens = dropSuffixes(normalizeName(raw).split(' '))
  return {
    first: tokens.at(0) ?? '',
    last: tokens.length > 1 ? tokens.at(-1)! : '',
    tokens,
  }
}

const dropSuffixes = (tokens: string[]) => tokens.filter((token) => token !== '' && !NAME_SUFFIXES.has(token))

/** Bounded Levenshtein — cheap typo tolerance for names, not a fuzzy search. */
export const editDistance = (a: string, b: string, max = 2) => {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      current.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return max + 1
    previous = current
  }
  return previous[b.length]!
}
