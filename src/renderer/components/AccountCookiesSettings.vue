<template>
  <FtSettingsSection
    :title="$t('Settings.Account Cookies Settings.Account Cookies Settings')"
  >
    <p class="sectionDescription">
      {{ $t('Settings.Account Cookies Settings.Description') }}
    </p>
    <FtFlexBox>
      <FtSelect
        :placeholder="$t('Settings.Account Cookies Settings.Browser')"
        :value="accountCookiesBrowser"
        :select-names="browserNames"
        :select-values="browserValues"
        :icon="['fas', 'globe']"
        @change="updateAccountCookiesBrowser"
      />
      <FtSelect
        :placeholder="$t('Settings.Account Cookies Settings.Profile')"
        :value="accountCookiesProfile"
        :select-names="profileNames"
        :select-values="profileValues"
        :icon="['fas', 'user-lock']"
        @change="updateAccountCookiesProfile"
      />
    </FtFlexBox>
    <FtFlexBox>
      <FtButton
        :label="$t('Settings.Account Cookies Settings.Refresh Cookies')"
        :icon="['fas', 'rotate']"
        @click="refreshCookies"
      />
    </FtFlexBox>
  </FtSettingsSection>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import FtSettingsSection from './FtSettingsSection/FtSettingsSection.vue'
import FtSelect from './FtSelect/FtSelect.vue'
import FtButton from './FtButton/FtButton.vue'
import FtFlexBox from './ft-flex-box/ft-flex-box.vue'

import store from '../store/index'
import { refreshAccountCookies } from '../helpers/api/local'
import { showToast } from '../helpers/utils'

const { t } = useI18n()

// Only Firefox is supported for now. Chromium-based browsers encrypt their cookie store
// with the OS keyring, which would need extra decryption work.
const browserNames = ['Firefox']
const browserValues = ['firefox']

/** @type {import('vue').ComputedRef<string>} */
const accountCookiesBrowser = computed(() => store.getters.getAccountCookiesBrowser)

/** @type {import('vue').ComputedRef<string>} */
const accountCookiesProfile = computed(() => store.getters.getAccountCookiesProfile)

const profiles = ref([])

const profileNames = computed(() => [
  t('Settings.Account Cookies Settings.Default Profile'),
  ...profiles.value.map(profile => profile.name)
])

const profileValues = computed(() => ['', ...profiles.value.map(profile => profile.name)])

onMounted(async () => {
  if (process.env.IS_ELECTRON) {
    profiles.value = await window.ftElectron.listFirefoxProfiles()
  }
})

/**
 * @param {string} value
 */
function updateAccountCookiesBrowser(value) {
  store.dispatch('updateAccountCookiesBrowser', value)
}

/**
 * @param {string} value
 */
function updateAccountCookiesProfile(value) {
  store.dispatch('updateAccountCookiesProfile', value)
}

async function refreshCookies() {
  try {
    const result = await refreshAccountCookies({
      browser: accountCookiesBrowser.value,
      profile: accountCookiesProfile.value
    })

    if (!result || result.count === 0) {
      showToast(t('Settings.Account Cookies Settings.No Cookies Found'))
      return
    }

    if (result.hasAuth) {
      showToast(t('Settings.Account Cookies Settings.Cookies Imported', { count: result.count }))
    } else {
      showToast(t('Settings.Account Cookies Settings.Not Signed In'))
    }
  } catch (error) {
    console.error(error)
    showToast(t('Settings.Account Cookies Settings.Import Failed'))
  }
}
</script>

<style scoped>
.sectionDescription {
  margin-block: 0 10px;
}
</style>
