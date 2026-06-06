<template>
  <div>
    <FtSettingsSection
      :title="$t('WatchSync.WatchSync')"
    >
      <p class="introText">
        {{ $t('WatchSync.Description') }}
      </p>

      <p
        v-if="clientId !== ''"
        class="clientIdLine"
      >
        {{ $t('WatchSync.This device id') }} <code>{{ clientId }}</code>
      </p>

      <div class="formGrid">
        <FtInput
          class="syncField"
          :placeholder="'https://watchsync.device.synthfleshop.casa'"
          :show-action-button="false"
          :show-label="true"
          :label="$t('WatchSync.Sync URL')"
          :value="urlInput"
          @input="value => urlInput = value"
        />

        <FtInput
          class="syncField"
          input-type="password"
          :placeholder="$t('WatchSync.Sync token placeholder')"
          :show-action-button="false"
          :show-label="true"
          :label="$t('WatchSync.Sync token')"
          :value="tokenInput"
          @input="value => tokenInput = value"
        />

        <FtInput
          class="syncField intervalField"
          input-type="number"
          :placeholder="'15'"
          :show-action-button="false"
          :show-label="true"
          :label="$t('WatchSync.Sync frequency')"
          :value="intervalInput"
          @input="value => intervalInput = value"
        />
      </div>

      <div class="toggleRow">
        <FtToggleSwitch
          :label="$t('WatchSync.Sync automatically')"
          :compact="true"
          :default-value="autoSyncEnabled"
          @change="handleToggleEnabled"
        />
        <FtToggleSwitch
          :label="$t('WatchSync.Also sync settings')"
          :compact="true"
          :tooltip="$t('WatchSync.Also sync settings tooltip')"
          :default-value="includeSettings"
          @change="handleToggleIncludeSettings"
        />
      </div>

      <FtFlexBox class="actionRow">
        <FtButton
          :label="$t('WatchSync.Save')"
          @click="handleSave"
        />
        <FtButton
          :label="syncInProgress ? $t('WatchSync.Syncing') : $t('WatchSync.Sync now')"
          :background-color="'var(--primary-color)'"
          :text-color="'var(--text-with-main-color)'"
          @click="handleSyncNow"
        />
      </FtFlexBox>
    </FtSettingsSection>

    <FtSettingsSection
      :title="$t('WatchSync.Sync log')"
    >
      <div class="lastSyncSummary">
        <FontAwesomeIcon
          :icon="statusIcon"
          class="statusIcon"
          :class="statusIconClass"
        />
        <span>{{ lastSyncSummary }}</span>
      </div>

      <ul
        v-if="logEntries.length > 0"
        class="logList"
      >
        <li
          v-for="(entry, index) in logEntries"
          :key="entry.at + '-' + index"
          class="logEntry"
          :class="{ failed: !entry.ok }"
        >
          <div class="logHeader">
            <FontAwesomeIcon
              :icon="entry.ok ? ['fas', 'circle-check'] : ['fas', 'circle-exclamation']"
              class="logIcon"
            />
            <span class="logTime">{{ formatTime(entry.at) }}</span>
            <span class="logBadge">{{ entry.manual ? $t('WatchSync.Manual') : $t('WatchSync.Automatic') }}</span>
            <span
              v-if="entry.ok && typeof entry.durationMs === 'number'"
              class="logDuration"
            >{{ formatDuration(entry.durationMs) }}</span>
          </div>

          <div
            v-if="entry.ok"
            class="logDetail"
          >
            {{ describeEntry(entry) }}
          </div>
          <div
            v-else
            class="logDetail logError"
          >
            {{ $t('WatchSync.Error detail', { error: entry.error }) }}
          </div>
        </li>
      </ul>
      <p
        v-else
        class="introText"
      >
        {{ $t('WatchSync.No syncs yet') }}
      </p>

      <FtFlexBox
        v-if="logEntries.length > 0"
        class="actionRow"
      >
        <FtButton
          :label="$t('WatchSync.Clear log')"
          :background-color="'var(--destructive-color)'"
          :text-color="'var(--destructive-text-color)'"
          @click="handleClearLog"
        />
      </FtFlexBox>
    </FtSettingsSection>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, ref } from 'vue'

import FtSettingsSection from '../../components/FtSettingsSection/FtSettingsSection.vue'
import FtInput from '../../components/FtInput/FtInput.vue'
import FtButton from '../../components/FtButton/FtButton.vue'
import FtToggleSwitch from '../../components/FtToggleSwitch/FtToggleSwitch.vue'
import FtFlexBox from '../../components/ft-flex-box/ft-flex-box.vue'

import store from '../../store/index'
import { useI18n } from 'vue-i18n'
import { showToast } from '../../helpers/utils'

const { t } = useI18n()

// Human-readable labels for each synced collection, used in the log summary.
const COLLECTION_LABELS = {
  history: () => t('WatchSync.Collections.History'),
  playlists: () => t('WatchSync.Collections.Playlists'),
  profiles: () => t('WatchSync.Collections.Subscriptions'),
  searchHistory: () => t('WatchSync.Collections.Search history'),
  settings: () => t('WatchSync.Collections.Settings'),
}

// Local editable copies of the persisted settings, seeded from the store.
const urlInput = ref(store.getters.getWatchSyncUrl)
const tokenInput = ref(store.getters.getWatchSyncToken)
const intervalInput = ref(String(store.getters.getWatchSyncIntervalMinutes))

const clientId = computed(() => store.getters.getWatchSyncClientId)
const autoSyncEnabled = computed(() => store.getters.getWatchSyncEnabled)
const includeSettings = computed(() => store.getters.getWatchSyncIncludeSettings)
const syncInProgress = computed(() => store.getters.getWatchSyncInProgress)
const logEntries = computed(() => store.getters.getWatchSyncLogEntries)
const lastEntry = computed(() => store.getters.getWatchSyncLastEntry)

const statusIcon = computed(() => {
  if (lastEntry.value == null) { return ['fas', 'circle-question'] }
  return lastEntry.value.ok ? ['fas', 'circle-check'] : ['fas', 'circle-exclamation']
})

const statusIconClass = computed(() => {
  if (lastEntry.value == null) { return 'statusNeutral' }
  return lastEntry.value.ok ? 'statusOk' : 'statusError'
})

const lastSyncSummary = computed(() => {
  const entry = lastEntry.value
  if (entry == null) { return t('WatchSync.Never synced') }
  if (!entry.ok) {
    return t('WatchSync.Last sync failed', { time: formatTime(entry.at) })
  }
  return t('WatchSync.Last synced', { time: formatTime(entry.at) })
})

function formatTime(timestamp) {
  if (typeof timestamp !== 'number') { return '' }
  return new Date(timestamp).toLocaleString()
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`
}

/** Turn a successful entry's per-collection stats into a one-line summary. */
function describeEntry(entry) {
  const stats = entry.collections
  if (stats == null || typeof stats !== 'object') {
    return t('WatchSync.Up to date')
  }

  const parts = []
  for (const [name, stat] of Object.entries(stats)) {
    if (stat == null) { continue }
    const changed = (stat.added ?? 0) + (stat.updated ?? 0)
    const label = COLLECTION_LABELS[name] != null ? COLLECTION_LABELS[name]() : name
    if (changed > 0) {
      parts.push(t('WatchSync.Collection change', {
        collection: label,
        added: stat.added ?? 0,
        updated: stat.updated ?? 0,
      }))
    }
  }

  if (parts.length === 0) {
    return t('WatchSync.Up to date')
  }
  return parts.join(' · ')
}

function persistFieldsFromInputs() {
  const url = urlInput.value.trim()
  const token = tokenInput.value.trim()
  let interval = Number.parseInt(intervalInput.value, 10)
  if (!Number.isFinite(interval) || interval < 1) {
    interval = 15
  }
  intervalInput.value = String(interval)

  // Pointing at a different server makes the incremental-sync cursor meaningless
  // (versions aren't comparable across servers), so reset it for a full resync.
  if (url !== store.getters.getWatchSyncUrl) {
    store.dispatch('updateWatchSyncLastVersion', 0)
  }

  store.dispatch('updateWatchSyncUrl', url)
  store.dispatch('updateWatchSyncToken', token)
  store.dispatch('updateWatchSyncIntervalMinutes', interval)
}

function handleSave() {
  persistFieldsFromInputs()
  // Reflect new interval / URL in the running scheduler.
  store.dispatch('restartWatchSyncScheduler')
  showToast(t('WatchSync.Settings saved'))
}

async function handleToggleEnabled(value) {
  await store.dispatch('updateWatchSyncEnabled', value)
  store.dispatch('restartWatchSyncScheduler')
}

function handleToggleIncludeSettings(value) {
  store.dispatch('updateWatchSyncIncludeSettings', value)
}

async function handleSyncNow() {
  if (syncInProgress.value) { return }

  // Make sure the latest field edits are saved before a manual sync.
  persistFieldsFromInputs()

  if (urlInput.value.trim() === '') {
    showToast(t('WatchSync.Enter a URL first'))
    return
  }

  const result = await store.dispatch('performWatchSync', { manual: true })
  if (result?.ok) {
    showToast(t('WatchSync.Sync complete'))
  } else {
    showToast(t('WatchSync.Sync failed', { error: result?.error ?? '' }))
  }
}

function handleClearLog() {
  store.dispatch('clearWatchSyncLog')
}
</script>

<style scoped src="./WatchSync.css" />
