import { session } from 'electron'
import { copyFile, readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

// Reads the user's browser cookies so FreeTube's local (Innertube) API can make
// authenticated requests, allowing it to play videos that require being signed in
// (age-restricted, members-only, region-locked, "sign in to confirm you're not a bot").
//
// Only Firefox is supported for now: Firefox stores its cookies *unencrypted* in a
// SQLite database (`cookies.sqlite`), so no OS keyring decryption is needed (unlike
// Chromium-based browsers). We read it with the built-in `node:sqlite` module, so there
// is no native dependency to build/package.

const COOKIE_HOST_PATTERNS = ['%youtube.com', '%google.com']

// Cookies we set ourselves elsewhere (see `src/main/index.js`) or that are part of the
// anonymous session - never remove these when clearing the imported account cookies.
const PROTECTED_COOKIE_NAMES = new Set(['CONSENT', 'SOCS'])

/**
 * The cookies we injected into the default session, kept so we can remove exactly those
 * (and nothing else) when the user turns the feature off.
 * @type {Array<{ url: string, name: string }>}
 */
let injectedCookies = []

/**
 * @returns {string}
 */
function getFirefoxDir() {
  return join(homedir(), '.mozilla', 'firefox')
}

/**
 * Parses Firefox's `profiles.ini` and returns the available profiles.
 * @returns {Promise<Array<{ name: string, path: string, default: boolean }>>}
 */
export async function listFirefoxProfiles() {
  const firefoxDir = getFirefoxDir()
  const iniPath = join(firefoxDir, 'profiles.ini')

  let content
  try {
    content = await readFile(iniPath, 'utf-8')
  } catch {
    return []
  }

  const profiles = []
  let current = null
  // The `[Install*]` sections record the default profile as a relative path.
  let installDefaultPath = null

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()

    if (line.startsWith('[')) {
      if (current?.name) {
        profiles.push(current)
      }
      current = line.toLowerCase().startsWith('[profile')
        ? { name: '', path: '', isRelative: true, default: false }
        : null
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()

    if (!current) {
      // inside an `[Install*]` (or `[General]`) section
      if (key === 'Default' && value.includes('/')) {
        installDefaultPath = value
      }
      continue
    }

    switch (key) {
      case 'Name':
        current.name = value
        break
      case 'Path':
        current.path = value
        break
      case 'IsRelative':
        current.isRelative = value === '1'
        break
      case 'Default':
        current.default = value === '1'
        break
    }
  }
  if (current?.name) {
    profiles.push(current)
  }

  return profiles.map(profile => ({
    name: profile.name,
    path: profile.isRelative ? join(firefoxDir, profile.path) : profile.path,
    default: profile.default || (installDefaultPath !== null && profile.path === installDefaultPath)
  }))
}

/**
 * Resolves the profile directory to read cookies from. Falls back to the default
 * profile (or the first one) when no name is given or the named one isn't found.
 * @param {string|undefined} profileName
 * @returns {Promise<{ name: string, path: string }|null>}
 */
async function resolveFirefoxProfile(profileName) {
  const profiles = await listFirefoxProfiles()

  if (profiles.length === 0) {
    return null
  }

  let profile
  if (profileName) {
    profile = profiles.find(candidate => candidate.name === profileName)
  }

  return profile ?? profiles.find(candidate => candidate.default) ?? profiles[0]
}

/**
 * Reads the YouTube/Google cookies from a Firefox profile's `cookies.sqlite`.
 *
 * The database is copied to a temporary location first, because Firefox keeps it locked
 * (WAL mode) while running. This mirrors what yt-dlp's `--cookies-from-browser` does.
 * @param {string|undefined} profileName
 * @returns {Promise<{
 *   profileName: string|null,
 *   cookieString: string,
 *   cookies: Array<{ host: string, name: string, value: string, path: string, expiry: number, isSecure: boolean, isHttpOnly: boolean, sameSite: number }>
 * }>}
 */
async function readFirefoxCookies(profileName) {
  const profile = await resolveFirefoxProfile(profileName)

  if (!profile) {
    return { profileName: null, cookieString: '', cookies: [] }
  }

  const cookiesPath = join(profile.path, 'cookies.sqlite')
  if (!existsSync(cookiesPath)) {
    return { profileName: profile.name, cookieString: '', cookies: [] }
  }

  const tempPath = join(tmpdir(), `freetube-firefox-cookies-${process.pid}-${Date.now()}.sqlite`)
  let database

  try {
    await copyFile(cookiesPath, tempPath)

    // Use `process.getBuiltinModule` so the bundler never tries to resolve/transform it.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    database = new DatabaseSync(tempPath, { readOnly: true })

    const statement = database.prepare(
      `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
       FROM moz_cookies
       WHERE host LIKE ? OR host LIKE ?`
    )
    const rows = statement.all(...COOKIE_HOST_PATTERNS)

    // Build the cookie header string, deduplicating by name (prefer youtube.com over google.com).
    const byName = new Map()
    for (const row of rows) {
      const existing = byName.get(row.name)
      const isYouTube = row.host.endsWith('youtube.com')
      if (!existing || (isYouTube && !existing.host.endsWith('youtube.com'))) {
        byName.set(row.name, row)
      }
    }
    const cookieString = Array.from(byName.values())
      .map(row => `${row.name}=${row.value}`)
      .join('; ')

    return { profileName: profile.name, cookieString, cookies: rows }
  } finally {
    if (database) {
      try {
        database.close()
      } catch {}
    }
    try {
      await unlink(tempPath)
    } catch {}
  }
}

/**
 * Maps a Firefox cookie row to Electron's `cookies.set` details and writes it into the
 * default session's cookie jar, so requests made by FreeTube automatically carry it
 * (the renderer's `fetch` can't set a `Cookie` header itself).
 * @param {{ host: string, name: string, value: string, path: string, expiry: number, isSecure: boolean, isHttpOnly: boolean, sameSite: number }} cookie
 */
async function injectCookie(cookie) {
  const hostWithoutDot = cookie.host.replace(/^\./, '')
  const path = cookie.path || '/'
  const url = `https://${hostWithoutDot}${path}`

  const secure = !!cookie.isSecure ||
    cookie.name.startsWith('__Secure-') ||
    cookie.name.startsWith('__Host-')

  // Firefox sameSite: 0 = None, 1 = Lax, 2 = Strict.
  let sameSite = cookie.sameSite === 1 ? 'lax' : cookie.sameSite === 2 ? 'strict' : 'no_restriction'
  // Electron rejects `no_restriction` unless the cookie is also secure.
  if (sameSite === 'no_restriction' && !secure) {
    sameSite = 'lax'
  }

  /** @type {Electron.CookiesSetDetails} */
  const details = {
    url,
    name: cookie.name,
    value: cookie.value,
    path,
    secure,
    httpOnly: !!cookie.isHttpOnly,
    sameSite
  }

  // `__Host-` cookies must be host-only with path `/`; everything else keeps its domain.
  if (cookie.host.startsWith('.') && !cookie.name.startsWith('__Host-')) {
    details.domain = cookie.host
  }

  // Firefox stores the expiry as unix seconds; 0 means a session cookie (no expiry set).
  if (cookie.expiry && cookie.expiry > 0) {
    details.expirationDate = cookie.expiry
  }

  await session.defaultSession.cookies.set(details)
  injectedCookies.push({ url, name: cookie.name })
}

/**
 * Reads the cookies from the given browser/profile, injects them into the default
 * session so authenticated requests work, and returns a summary plus the cookie string
 * (needed by youtube.js to compute its `Authorization: SAPISIDHASH` header).
 * @param {{ browser?: string, profile?: string }} options
 * @returns {Promise<{ profileName: string|null, cookieString: string, count: number, hasAuth: boolean }>}
 */
export async function importBrowserCookies({ browser = 'firefox', profile } = {}) {
  if (browser !== 'firefox') {
    throw new Error(`Unsupported browser for cookie import: ${browser}`)
  }

  // Remove any cookies we previously injected before importing a fresh set.
  await clearBrowserCookies()

  const { profileName, cookieString, cookies } = await readFirefoxCookies(profile)

  for (const cookie of cookies) {
    try {
      await injectCookie(cookie)
    } catch (error) {
      console.error('Failed to inject cookie', cookie.name, error)
    }
  }

  const hasAuth = cookies.some(cookie => cookie.name === 'SAPISID' || cookie.name === '__Secure-3PAPISID')

  return { profileName, cookieString, count: cookies.length, hasAuth }
}

/**
 * Removes the cookies we previously injected into the default session (leaving the
 * cookies FreeTube manages itself, e.g. CONSENT/SOCS, untouched).
 * @returns {Promise<void>}
 */
export async function clearBrowserCookies() {
  const toRemove = injectedCookies
  injectedCookies = []

  for (const { url, name } of toRemove) {
    if (PROTECTED_COOKIE_NAMES.has(name)) {
      continue
    }
    try {
      await session.defaultSession.cookies.remove(url, name)
    } catch (error) {
      console.error('Failed to remove cookie', name, error)
    }
  }
}
