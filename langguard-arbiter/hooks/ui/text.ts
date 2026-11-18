// UX spec section 8 rule 2: the one sanitizer for a tool name or an agent label before it draws.
// eslint-disable-next-line no-control-regex -- ESC and BEL are the bytes this sanitizer exists to strip
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])?/g
// eslint-disable-next-line no-control-regex -- the control range is what this sanitizer exists to strip
const STRIPPED = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu
const NOT_PRINTABLE = /[^\x20-\x7e]/gu
const ELLIPSIS = '...'

export function sanitize(value: string, width: number): string {
  const clean = value.replace(ESCAPE_SEQUENCE, '').replace(STRIPPED, '').replace(NOT_PRINTABLE, '?')
  if (clean.length <= width) return clean
  if (width <= ELLIPSIS.length) return ELLIPSIS.slice(0, Math.max(0, width))
  return `${clean.slice(0, width - ELLIPSIS.length)}${ELLIPSIS}`
}
