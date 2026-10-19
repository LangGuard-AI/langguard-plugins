import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FRESH_MS = 10_000
const FUTURE_MS = 2_000
const LATE_MS = 20_000
const RECHECK_MS = 1_500
const RECHECK_EVERY_MS = 100
const KEEP_MS = 24 * 60 * 60 * 1000
const READ_MAX = 4096
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/

const CAUSES = 'Common causes are Claude Code older than 2.1.287, a load error, or a crash. Update or restart Claude Code, or run /reload-plugins.'
const COOP = `LangGuard is not running in this session. MCP tool calls are not checked. ${CAUSES}`
const STRICT = `LangGuard is not running in this session, so strict mode blocks this prompt. ${CAUSES}`

// As the mod reads the Mode option: only the exact value cooperative is cooperative, and a missing or empty value is the default, cooperative. Any other value is strict.
function modeOf(value) {
  if (value === undefined || value === '') return 'cooperative'
  return value === 'cooperative' ? 'cooperative' : 'strict'
}

function sessionIdOf() {
  try {
    const id = JSON.parse(readFileSync(0, 'utf8'))?.session_id
    return typeof id === 'string' && ID_SHAPE.test(id) ? id : null
  } catch {
    return null
  }
}

const ROOT = join(process.env.HOME || process.env.USERPROFILE || homedir(), '.config', 'arbiter', 'claude-mod')

// The mod writes the mode that it enforces, so a strict mode that a server command set stays strict when the mod fails to load later.
function storedMode() {
  try {
    return modeOf(readFileSync(join(ROOT, 'mode'), 'utf8').slice(0, READ_MAX).trim())
  } catch {
    return 'cooperative'
  }
}

// The age comes from the clock that wrote the marker (`at`). The mtime is a fallback, because a file server can set it from another clock.
function markerOf(id) {
  try {
    const file = join(ROOT, 'alive', `${id}.json`)
    const modified = Date.now() - statSync(file).mtimeMs
    try {
      const body = JSON.parse(readFileSync(file, 'utf8').slice(0, READ_MAX))
      const at = typeof body?.at === 'number' && Number.isFinite(body.at) ? Date.now() - body.at : modified
      return { age: at, ended: body?.ended === true }
    } catch {
      return { age: modified, ended: false }
    }
  } catch {
    return null
  }
}

const isFresh = (marker) => marker !== null && !marker.ended && marker.age >= -FUTURE_MS && marker.age < FRESH_MS
const isLate = (marker) => marker !== null && !marker.ended && marker.age >= FRESH_MS && marker.age < LATE_MS

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A worker that was respawned writes its marker again a few milliseconds after the settings hook ran, so a marker that is a little too old gets a bounded second look.
async function isAlive(id) {
  let marker = markerOf(id)
  if (isFresh(marker)) return true
  for (let waited = 0; isLate(marker) && waited < RECHECK_MS; waited += RECHECK_EVERY_MS) {
    await sleep(RECHECK_EVERY_MS)
    marker = markerOf(id)
    if (isFresh(marker)) return true
  }
  return false
}

function claimWarning(id) {
  try {
    mkdirSync(join(ROOT, 'warned'), { recursive: true })
    writeFileSync(join(ROOT, 'warned', id), '', { flag: 'wx' })
    return true
  } catch (err) {
    return err?.code !== 'EEXIST'
  }
}

function prune() {
  for (const dir of ['alive', 'warned']) {
    try {
      for (const name of readdirSync(join(ROOT, dir))) {
        try {
          const file = join(ROOT, dir, name)
          if (Date.now() - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file)
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }
}

const id = sessionIdOf()
const mode = modeOf(process.env.CLAUDE_PLUGIN_OPTION_ENFORCEMENT_MODE) === 'strict' || storedMode() === 'strict' ? 'strict' : 'cooperative'
if (id === null || !(await isAlive(id))) {
  if (mode === 'strict') process.stdout.write(JSON.stringify({ decision: 'block', reason: STRICT }))
  else if (id === null || claimWarning(id)) process.stdout.write(JSON.stringify({ systemMessage: COOP }))
}
prune()
