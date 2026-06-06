# My Changes

This document describes the commits on the `fork` branch that sit on top of
upstream FreeTube `development`, in the order they were committed (oldest
first).

## Table of Contents

1. [Trigger auto-fetch when switching profiles](#trigger-auto-fetch-when-switching-profiles)
2. [Add setting for Profile Select Dropdown Columns](#add-setting-for-profile-select-dropdown-columns)
3. [Add mousewheel playback rate over More Settings button and fix interval](#add-mousewheel-playback-rate-over-more-settings-button-and-fix-interval)
4. [Add playlist membership indicators to thumbnails and watch page](#add-playlist-membership-indicators-to-thumbnails-and-watch-page)
5. [Swap watch page layout button - next recommendations and video metadata](#swap-watch-page-layout-button---next-recommendations-and-video-metadata)
6. [Auto-load comments when video player is ready](#auto-load-comments-when-video-player-is-ready)
7. [feat: add WatchSync client to sync user data across devices](#feat-add-watchsync-client-to-sync-user-data-across-devices)
8. [Add MY-CHANGES.md documenting fork commits](#add-my-changesmd-documenting-fork-commits)
9. [feat: authenticated local playback via imported Firefox cookies](#feat-authenticated-local-playback-via-imported-firefox-cookies)

---

## Trigger auto-fetch when switching profiles

Makes the Subscriptions feeds refresh automatically when the active profile
changes, instead of waiting for a manual reload. The four subscription tab
components (`SubscriptionsLive`, `SubscriptionsPosts`, `SubscriptionsShorts`,
`SubscriptionsVideos`) and the `utils` Vuex store module are updated so that
switching profiles kicks off a fresh fetch for the newly selected profile's
channels.

## Add setting for Profile Select Dropdown Columns

Adds a user-configurable setting controlling how many columns the profile
selector dropdown (`FtProfileSelector`) lays its profiles out in. A new
control is added to the Profile Settings view, the value is persisted through
the `settings` store module, and the dropdown CSS uses it to render the grid.
New `en-US` / `en-GB` locale strings are added for the setting label.

## Add mousewheel playback rate over More Settings button and fix interval

Two related tweaks to the Shaka video player's playback-rate handling:

- Scrolling the mousewheel while hovering over the overflow menu ("More
  Settings") button now adjusts the playback rate, without needing to hold
  Ctrl/Cmd.
- Fixes the existing mousewheel playback-rate handler to step by the
  configured `videoPlaybackRateInterval` instead of a hardcoded `0.05`
  increment, so it matches the keyboard-shortcut behaviour.

## Add playlist membership indicators to thumbnails and watch page

Surfaces playlist membership directly on video thumbnails and the watch page:

- Shows a green bookmark icon on a thumbnail when the video belongs to any
  user playlist other than the quick-bookmark ("Favorites") playlist. Clicking
  it removes the video from that playlist.
- Changes the quick-bookmark button icons from bookmark/check to an
  outline/solid heart.
- Ports the same heart icon and named-playlist bookmark indicator to the watch
  page action buttons.

Touches `ft-list-video` (thumbnail list item), `WatchVideoInfo`, the
`_ft-list-item` styles, registers the needed icons in `main.js`, and adds
locale strings.

## Swap watch page layout button - next recommendations and video metadata

Adds an alternative watch-page layout, gated behind a new opt-in toggle:

- Video info (title, channel, subscribe) moves to its own grid area below the
  video. Chapters, Description, and Comments move into the right sidebar
  column, and the "Up Next" recommendations move below the video info.
- The layout is controlled by a new "Swap positions of next recommendations
  and video metadata sections" toggle in Player settings (off by default, so
  the original layout is preserved).
- A button in the watch page action buttons row toggles the same setting for
  quick access.

Changes span Player settings, `WatchVideoInfo`, the `Watch` view (JS, SCSS,
template), the `settings` store module, and `en-US` locale strings.

## Auto-load comments when video player is ready

Loads the comment section automatically once the player is ready, instead of
requiring the user to click "Click to View Comments". `CommentSection` now
watches the `videoPlayerReady` prop and calls `getCommentData()` when it
becomes true.

## feat: add WatchSync client to sync user data across devices

Adds **WatchSync**, a feature that keeps multiple FreeTube installs in sync by
pushing user data to a self-hosted central store and pulling back the merged
result. Subscriptions, playlists, watch history, and search history are
synced; app settings are opt-in. The matching server and its web app live in a
separate WatchSync repo.

### What gets synced and how merges work

- A new `watchSync` Vuex module gathers all local datastore records
  (subscriptions/profiles, playlists, history, and search history), POSTs them
  to the server, and applies the merged response back.
- Merges use **union semantics**, so a sync never deletes local data:
  - History and search history are overwritten with the (superset) merged set
    on a full snapshot.
  - Playlists and profiles are **upserted** and then re-grabbed so the UI
    reflects the merged state.
- App settings are only included when the include-settings toggle is on.

### Device identity

- New WatchSync settings are persisted via `settings.js`: enabled, url, token,
  interval, include-settings, log, and a server-assigned `clientId`.
- On each sync the client sends its stored `clientId` and persists the id the
  server assigns/echoes, so the server recognises this specific device across
  syncs.

### Auto-sync scheduler

- A scheduler started on app mount drives the periodic auto-sync. It's a no-op
  unless WatchSync is enabled.
- On launch it kicks an immediate sync so opening the app picks up changes made
  on other devices, then repeats on the configured interval.
- The module keeps a bounded log of past syncs for display in the UI.

### Incremental pull with a version cursor

The **download** is incremental, so a device no longer fetches the entire store
on every sync. The server stamps every record with a version (`seq`) and
accepts a `?since=N` cursor, returning only records changed since N.

- A persisted `watchSyncLastVersion` cursor tracks the highest store version
  this device has applied (`0` = full snapshot). It's **device-local**, so it's
  added to `NON_SYNCED_SETTING_IDS` and never synced as a setting itself.
- `performWatchSync` sends `?since=<cursor>` when the cursor is greater than 0,
  and after applying the response advances the cursor to the server's version.
- If the server is behind the cursor (e.g. it was restored from a backup), the
  cursor resets to 0 so the next sync re-bootstraps with a full snapshot.
- The cursor also resets to 0 when the server URL changes, since versions are
  not comparable across servers.
- `applyWatchSyncResult` gains an `incremental` flag: a delta is applied by
  **upserting** history/search history (so unchanged local records aren't
  wiped), while a full snapshot keeps the fast bulk overwrite. Playlists,
  profiles, and settings were already upserted in both paths.
- Pushes are unchanged — the client still sends all local records each sync.
  Only the **download** is incremental.

### UI

- A new WatchSync view and `/watchsync` route: sync URL/token inputs, a
  sync-frequency number box (default 15 min), auto-sync and include-settings
  toggles, Save and manual "Sync now" buttons, this device's assigned sync ID,
  a last-sync summary, and a per-sync log.
- A new sidebar button between Settings and About, `en-US` strings, and the
  FontAwesome icons it needs (rotate, circle-check, circle-question).

## Add MY-CHANGES.md documenting fork commits

Adds this `MY-CHANGES.md` document itself. It records every commit on the
`fork` branch that sits on top of upstream FreeTube `development`, with a table
of contents and one section per commit explaining what that commit does. The
file is meant to be a human-readable overview of the fork's divergence from
upstream, kept in sync as commits are added, squashed, or amended.

## feat: authenticated local playback via imported Firefox cookies

Lets FreeTube's **built-in** player play videos that normally require being
signed in — age-restricted, members-only, region-locked, and "sign in to
confirm you're not a bot" — by making the local (Innertube/youtube.js)
extraction optionally authenticated with the user's real YouTube cookies,
imported automatically from a Firefox profile. This mirrors what
`yt-dlp --cookies-from-browser firefox:<profile>` does for the external mpv
player, but keeps playback inside FreeTube. It is opt-in, Firefox-only, and
scoped to video playback so all other requests stay anonymous.

### How it works

- **Reading the cookies (main process):** a new `src/main/browserCookies.js`
  parses Firefox's `profiles.ini`, copies the chosen profile's
  `cookies.sqlite` to a temp file (Firefox keeps it locked while running), and
  reads the YouTube/Google cookies with the built-in `node:sqlite` module —
  Firefox stores cookies unencrypted, so there is **no native dependency** and
  no OS-keyring decryption (unlike Chromium browsers).
- **Getting the cookies sent:** Electron's renderer `fetch` silently drops a
  manually-set `Cookie` header, so the imported cookies are injected into the
  default session's cookie jar (reusing the same `session.defaultSession.cookies.set`
  approach FreeTube already uses for CONSENT/SOCS); Electron then attaches them
  automatically. The cookie string is also passed to `Innertube.create({ cookie })`
  so youtube.js can derive the `Authorization: SAPISIDHASH` header.
- **Wiring:** `createInnertube` gains a `cookie` option; `getLocalVideoInfo`
  takes the cookie and uses it for both the player request and the
  `WEB_EMBEDDED` age-gate fallback. The `Watch` view resolves the cookie (when
  enabled) and passes it down; the cookie string is cached in renderer memory
  for the session and **never written to the settings database**. The existing
  poToken flow is untouched.
- **IPC:** three new channels — `LIST_FIREFOX_PROFILES`, `GET_BROWSER_COOKIES`
  (reads + injects, returns a summary), and `CLEAR_BROWSER_COOKIES` (removes
  exactly the injected cookies, leaving FreeTube's own intact).

### UI

- An **Enable cookies** toggle (a cookie-bite icon) sits in the watch-page
  action buttons row, just left of the "Swap watch page sections" button, in
  `WatchVideoInfo`. It turns red (`primary` theme) when authenticated playback
  is on and grey when off, toasts the result, and imports/clears the cookies on
  toggle. (Electron only.)
- A new **Account Cookies** settings section (`AccountCookiesSettings.vue`,
  registered in `Settings.vue`) selects the browser (Firefox) and profile
  (defaults to the default profile) and has a "Refresh cookies" button.

### Uploading the cookie for Android via WatchSync

The FreeTubeAndroid fork has no local browser to import cookies from, so when
account cookies are enabled here, every WatchSync push appends a `settings`
record `{ _id: 'accountCookieString', value: <cookie string> }` — sent even
when settings sync is off, and imported fresh from the browser each sync. The
id is in `NON_SYNCED_SETTING_IDS`, so no device's *persisted* copy is ever
gathered or applied through the generic settings round trip; only the desktop's
fresh in-memory value flows (this stops a stale copy on another device from
winning the server's last-push-wins settings merge). The Android fork picks the
record out of the sync response, persists it, and injects it into its WebView
cookie jar at playback time — see the matching commit in FreeTubeAndroid.

### Notes / risks

- Authenticating a third-party client with real account cookies carries a
  non-zero account-ban risk (the same risk the mpv/yt-dlp setup already has)
  and ties those playback requests to the Google identity.
- Cookies expire/rotate, so they're re-imported once per app session and via
  the manual refresh button.

Adds settings keys `useAccountCookies`, `accountCookiesBrowser`, and
`accountCookiesProfile`, plus `en-US` locale strings. Touches
`src/main/browserCookies.js` (new), `src/constants.js`, `src/main/index.js`,
`src/preload/interface.js`, `src/renderer/helpers/api/local.js`,
`src/renderer/views/Watch/Watch.js`, `src/renderer/store/modules/settings.js`,
`src/renderer/store/modules/watch-sync.js` (the WatchSync upload),
`src/renderer/components/AccountCookiesSettings.vue` (new),
`src/renderer/views/Settings/Settings.vue`,
`src/renderer/components/WatchVideoInfo/WatchVideoInfo.{vue,css}`, and the
`faCookieBite` icon registration in `src/renderer/main.js`.
