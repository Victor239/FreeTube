import {
  DBHistoryHandlers,
  DBPlaylistHandlers,
  DBProfileHandlers,
  DBSearchHistoryHandlers,
  DBSettingHandlers,
} from '../../../datastores/handlers/index'

// WatchSync keeps a device's user data in sync with a self-hosted central store
// (see ../../../../../1MY_REPOS/Self-Hosted/WatchSync). Each sync is a single
// round trip: we push our local records, the server merges them (union +
// last-write-wins) into its canonical copy, and we apply the merged result back.
//
// Pull is incremental: every server record carries a version (`seq`), and we
// remember the highest one we've applied (`watchSyncLastVersion`). The next sync
// asks `?since=<that version>` and the server returns only what changed, which we
// apply by upserting. The first sync (cursor 0) pulls a full snapshot. We still
// push all of our local records each time — only the download is incremental.
//
// Subscriptions, playlists, watch history and search history are always synced.
// Settings are opt-in (most are device-specific). The subscription cache is
// deliberately never synced — it's a regenerable cache, not user data.

// Settings that must never leave or be overwritten by a sync: the WatchSync
// controls themselves (syncing them would fight other devices / cause loops).
const NON_SYNCED_SETTING_IDS = new Set([
  'bounds',
  'watchSyncEnabled',
  'watchSyncUrl',
  'watchSyncToken',
  'watchSyncIntervalMinutes',
  'watchSyncIncludeSettings',
  'watchSyncLog',
  'watchSyncClientId',
  'watchSyncLastVersion',
])

// Cap on persisted log entries so the setting doesn't grow without bound.
const MAX_LOG_ENTRIES = 30

// Module-scoped timer handle (not in state — timer ids aren't serializable and
// don't belong in the reactive store).
let syncIntervalId = null

const state = {
  /** True while a sync is in flight, so the UI can disable buttons and we don't overlap. */
  watchSyncInProgress: false,
}

const getters = {
  getWatchSyncInProgress: (state) => state.watchSyncInProgress,

  /** Parsed log entries (newest first) from the persisted JSON setting. */
  getWatchSyncLogEntries: (_state, _getters, rootState) => {
    try {
      const parsed = JSON.parse(rootState.settings.watchSyncLog || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  },

  /** The most recent log entry, or null. */
  getWatchSyncLastEntry: (_state, getters) => {
    const entries = getters.getWatchSyncLogEntries
    return entries.length > 0 ? entries[0] : null
  },
}

function normalizeEndpoint(rawUrl) {
  const trimmed = (rawUrl || '').trim().replace(/\/+$/, '')
  if (trimmed === '') { return null }
  return `${trimmed}/api/sync`
}

const actions = {
  /**
   * Gather all local user data, push it to the sync server, and apply the
   * merged result back to the local datastores.
   *
   * @param {{ manual?: boolean }} [options]
   */
  async performWatchSync({ commit, dispatch, rootState, getters }, { manual = false } = {}) {
    if (state.watchSyncInProgress) { return getters.getWatchSyncLastEntry }

    const endpoint = normalizeEndpoint(rootState.settings.watchSyncUrl)
    if (endpoint == null) {
      return dispatch('appendWatchSyncLogEntry', {
        ok: false,
        manual,
        durationMs: 0,
        error: 'No sync URL configured',
      })
    }

    const includeSettings = rootState.settings.watchSyncIncludeSettings === true
    const token = (rootState.settings.watchSyncToken || '').trim()
    const startedAt = Date.now()

    commit('setWatchSyncInProgress', true)

    try {
      // ── Gather ───────────────────────────────────────────────────────────
      const [history, playlists, profiles, searchHistory] = await Promise.all([
        DBHistoryHandlers.find(),
        DBPlaylistHandlers.find(),
        DBProfileHandlers.find(),
        DBSearchHistoryHandlers.find(),
      ])

      const collections = {
        history: (history ?? []).filter((e) => e != null),
        playlists: (playlists ?? []).filter((e) => e != null),
        profiles: (profiles ?? []).filter((e) => e != null),
        searchHistory: (searchHistory ?? []).filter((e) => e != null),
      }

      if (includeSettings) {
        const settings = (await DBSettingHandlers.find()) ?? []
        collections.settings = settings.filter((s) => s != null && !NON_SYNCED_SETTING_IDS.has(s._id))
      }

      // ── Push + pull ──────────────────────────────────────────────────────
      const headers = { 'Content-Type': 'application/json' }
      if (token !== '') { headers.Authorization = `Bearer ${token}` }

      const clientId = (rootState.settings.watchSyncClientId || '').trim()
      const body = { device: getWatchSyncDeviceName(), collections }
      if (clientId !== '') { body.clientId = clientId }

      // Incremental pull: ask only for records changed since our cursor. A cursor
      // of 0 (first sync, or after a reset) omits `since` for a full snapshot.
      const since = Number(rootState.settings.watchSyncLastVersion) || 0
      const incremental = since > 0
      const url = incremental ? `${endpoint}?since=${since}` : endpoint

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        let detail = ''
        try {
          const errBody = await response.json()
          detail = errBody?.error ? `: ${errBody.error}` : ''
        } catch { /* non-JSON error body */ }
        throw new Error(`Server responded ${response.status}${detail}`)
      }

      const data = await response.json()

      // Persist the id the server assigned (or confirmed) for this device, so
      // future syncs are recognised as the same client.
      if (typeof data.clientId === 'string' && data.clientId !== '' && data.clientId !== clientId) {
        dispatch('updateWatchSyncClientId', data.clientId)
      }

      // ── Apply merged result locally ──────────────────────────────────────
      // In incremental mode the response carries only changed records, so we
      // upsert them; a full snapshot still overwrites history/search history.
      await dispatch('applyWatchSyncResult', {
        merged: data.collections,
        includeSettings,
        incremental,
      })

      // Advance the cursor to the server's version so the next sync only pulls
      // newer changes. If the server is somehow behind us (e.g. restored from a
      // backup), reset to 0 so the next sync re-bootstraps with a full snapshot.
      const serverVersion = Number(data.version)
      if (Number.isFinite(serverVersion)) {
        const nextCursor = serverVersion < since ? 0 : serverVersion
        if (nextCursor !== since) { dispatch('updateWatchSyncLastVersion', nextCursor) }
      }

      return dispatch('appendWatchSyncLogEntry', {
        ok: true,
        manual,
        durationMs: Date.now() - startedAt,
        version: data.version,
        collections: data.stats,
      })
    } catch (error) {
      console.error('[WatchSync] sync failed', error)
      return dispatch('appendWatchSyncLogEntry', {
        ok: false,
        manual,
        durationMs: Date.now() - startedAt,
        error: error?.message ?? String(error),
      })
    } finally {
      commit('setWatchSyncInProgress', false)
    }
  },

  /**
   * Write the server's merged collections back into the local datastores and
   * refresh the Vuex caches. Union semantics mean this never removes local data.
   *
   * @param {{ merged: object, includeSettings: boolean, incremental?: boolean }} payload
   *   `incremental` is true when `merged` is a delta (only changed records): we
   *   then upsert history/search history instead of overwriting, so the records
   *   the server didn't send (unchanged ones) survive. A full snapshot overwrites.
   */
  async applyWatchSyncResult({ dispatch }, { merged, includeSettings, incremental = false }) {
    if (merged == null || typeof merged !== 'object') { return }

    // History. Full snapshot → overwrite (a superset of local, so nothing is
    // lost and it's a single bulk write). Delta → upsert each changed record.
    if (Array.isArray(merged.history)) {
      if (incremental) {
        for (const record of merged.history) {
          if (record?.videoId != null) { await dispatch('updateHistory', record) }
        }
      } else {
        const map = new Map()
        for (const record of merged.history) {
          if (record?.videoId != null) { map.set(record.videoId, record) }
        }
        await dispatch('overwriteHistory', map)
      }
    }

    // Search history. Same full-vs-delta split as history.
    if (Array.isArray(merged.searchHistory)) {
      if (incremental) {
        for (const entry of merged.searchHistory) {
          if (entry?._id != null) { await dispatch('updateSearchHistoryEntry', entry) }
        }
      } else {
        await dispatch('overwriteSearchHistory', merged.searchHistory.filter((e) => e?._id != null))
      }
    }

    // Playlists: upsert each merged playlist, then refresh from the DB.
    if (Array.isArray(merged.playlists)) {
      for (const playlist of merged.playlists) {
        if (playlist?._id != null) { await DBPlaylistHandlers.upsert(playlist) }
      }
      await dispatch('grabAllPlaylists')
    }

    // Profiles: upsert each merged profile, then refresh from the DB.
    if (Array.isArray(merged.profiles)) {
      for (const profile of merged.profiles) {
        if (profile?._id != null) { await DBProfileHandlers.upsert(profile) }
      }
      await dispatch('grabAllProfiles')
    }

    // Settings: only when the user opted in, and never the WatchSync controls.
    if (includeSettings && Array.isArray(merged.settings)) {
      for (const setting of merged.settings) {
        if (setting?._id != null && !NON_SYNCED_SETTING_IDS.has(setting._id)) {
          await DBSettingHandlers.upsert(setting._id, setting.value)
        }
      }
      await dispatch('grabUserSettings')
    }
  },

  /** Prepend a log entry (stamped with `at`) and persist the bounded list. */
  appendWatchSyncLogEntry({ dispatch, getters }, entry) {
    const stamped = { at: Date.now(), ...entry }
    const entries = [stamped, ...getters.getWatchSyncLogEntries].slice(0, MAX_LOG_ENTRIES)
    dispatch('updateWatchSyncLog', JSON.stringify(entries))
    return stamped
  },

  clearWatchSyncLog({ dispatch }) {
    dispatch('updateWatchSyncLog', '[]')
  },

  /** (Re)start the periodic sync timer based on the current settings. */
  restartWatchSyncScheduler({ dispatch, rootState }) {
    dispatch('stopWatchSyncScheduler')

    const settings = rootState.settings
    if (!settings.watchSyncEnabled || normalizeEndpoint(settings.watchSyncUrl) == null) {
      return
    }

    const minutes = Number(settings.watchSyncIntervalMinutes)
    // Guard against 0/NaN producing a tight loop; floor at 1 minute.
    const intervalMs = Math.max(1, Number.isFinite(minutes) ? minutes : 15) * 60 * 1000

    syncIntervalId = setInterval(() => {
      dispatch('performWatchSync', { manual: false })
    }, intervalMs)

    // Kick off an immediate sync so enabling it (or launching the app) syncs now
    // rather than after one full interval.
    dispatch('performWatchSync', { manual: false })
  },

  stopWatchSyncScheduler() {
    if (syncIntervalId != null) {
      clearInterval(syncIntervalId)
      syncIntervalId = null
    }
  },
}

const mutations = {
  setWatchSyncInProgress(state, value) {
    state.watchSyncInProgress = value
  },
}

/** A best-effort, stable-ish device label for the server log (display only). */
function getWatchSyncDeviceName() {
  if (typeof process !== 'undefined' && process.platform) {
    return `freetube-${process.platform}`
  }
  return 'freetube-web'
}

export default {
  state,
  getters,
  actions,
  mutations,
}
