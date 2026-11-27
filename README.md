# Community Playlist

A headless browser controller that listens for Twitch Custom Power-up song requests and plays them before the upcoming tracks in the broadcaster's existing Spotify playlist.

Spotify itself handles all audio playback. This project does not capture, process, mix, encode, or transmit audio. It has no visible interface and no OBS or broadcast controls.

## Implemented

- Twitch public-client Device Code authorization, token validation, one-time refresh-token rotation, and reconnect handling.
- Automatic discovery of the broadcaster's Custom Power-ups; selects the only enabled, in-stock text-input Power-up or requires an explicit ID if several are available.
- Twitch EventSub WebSocket subscriptions for Custom Power-up redemptions and chat messages, including keepalive, session migration, reconnect, and duplicate-delivery handling.
- Spotify Authorization Code with PKCE, token refresh, device selection, playlist inspection, Spotify track URL/URI parsing, and text search.
- Persistent application-owned FIFO request queue, retryable redemption intake, request-ID idempotency, serialized playback changes, and conservative browser-reload recovery.
- Broadcaster/moderator-only \`!skip\`, advancing directly to the next viewer request without calling Spotify's playlist skip endpoint.
- Playback safeguards for manual queue entries, repeat mode, shuffle-aware playlist restoration, changed devices, manual playback changes, duplicate playlist tracks, and unexpected playlist edits. Playable podcast episodes can remain in the playlist continuation; unavailable/local entries are skipped only when Spotify's upcoming queue confirms the next playable item.
- Automated tests for OAuth-related helpers, Twitch redemption/chat authorization, retry and duplicate-delivery handling, EventSub reconnect/migration/keepalive lifecycle, request ordering, skip behaviour, storage recovery, Spotify parsing, and playlist restore-position resolution.

## Requirements

- A Twitch broadcaster account eligible for Custom Power-ups (Twitch documents that the API is available to Partners and Affiliates).
- At least one enabled, in-stock Twitch Custom Power-up that requires viewer text input.
- A Spotify Premium account.
- A Spotify playlist the authenticated user can read (the configured account should own or collaborate on private playlists).
- A static HTTPS host and a browser tab that remains open while requests are being handled.
- Node.js 22 or newer for development. No runtime or development dependencies are required.

## Recommended setup

Use the hosted signup flow to connect Twitch and Spotify once and generate a private OBS Browser Source URL. You do not need to edit browser configuration or authorize from the browser console. Follow the [hosted authorization and OBS setup guide](docs/authorization-and-obs-setup.md).

## Legacy manual setup

1. Register a Twitch application as a **public client**. The controller uses Device Code authorization and requests only \`bits:read\` and \`user:read:chat\`. Authorize with the broadcaster's Twitch account.
2. Register a Spotify app. Add the exact URL serving \`index.html\` to its redirect URI allowlist.
3. Copy \`config.example.js\` to \`config.local.js\`. Set the Twitch and Spotify client IDs, exact Spotify redirect URI, and Spotify playlist URI. Leave \`broadcasterId\` blank to use the Twitch-authorized account. Leave \`powerUpId\` blank only when exactly one enabled text-input Power-up exists; otherwise set its ID.
4. Host the files from a static HTTPS origin. Do not open the page as a \`file://\` URL. Keep \`config.local.js\` on the same origin as the application and do not commit it.
5. Open the page in the browser tab that will remain active. Open the browser developer console and run \`communityPlaylist.start()\`. Spotify authorization redirects the current tab to Spotify and returns to the configured page. Twitch Device Code authorization then prints a one-time verification URL and code to the console; enter the code at that URL.
6. Open Spotify on the intended Connect device and start the configured playlist. Turn repeat off; shuffle may remain on. Requests are accepted only while the configured playlist is playing on the selected device.

Example local configuration:

\`\`\`js
export default {
  twitchClientId: 'your-twitch-public-client-id',
  spotifyClientId: 'your-spotify-client-id',
  spotifyRedirectUri: 'https://example.com/community-playlist/',
  playlistUri: 'spotify:playlist:yourPlaylistId',
  broadcasterId: '',
  powerUpId: '',
  spotifyDeviceId: '',
  pollIntervalMs: 2000,
  maxPendingRequests: 100
};
\`\`\`

The redirect URI must exactly match the URL serving \`index.html\`, including path and trailing slash. The Spotify account must be able to read the configured playlist items.

## Legacy manual runtime

The page is intentionally blank. Diagnostics are written to the browser console. Once started, these console commands are available:

\`\`\`js
communityPlaylist.status()
communityPlaylist.stop()
communityPlaylist.resume()
\`\`\`

The controller must remain open and the browser must continue executing the tab. Browser shutdown, tab discard, device sleep, or suspended execution can delay request handling. Queue state, processed redemption IDs, and retryable redemption intake records are stored in \`localStorage\`; Twitch/Spotify access and refresh tokens plus the Spotify PKCE verifier are stored in \`sessionStorage\`. A redemption is saved before Spotify lookup, transient failures are retried with bounded exponential backoff, and interrupted processing is recovered after reload. Request IDs are checked against active and pending playback entries to prevent duplicate insertion. Closing the tab clears those session tokens and requires authorization again.

\`stop()\` closes EventSub and stops playback polling. It deliberately does not pause Spotify or alter the current track. \`resume()\` is available after a manual playback change has put the queue into handoff mode; it requires the configured playlist to be playing again.

## Playback behaviour and safeguards

The controller does not append viewer requests to Spotify's queue. Requests are held in a separate FIFO queue and played as individual Spotify track URIs. Before the first request, it records the active device and playlist context, resolves the next playlist offset by comparing the playlist's items with Spotify's upcoming queue, and verifies the expected track after every playback command.

It refuses to interrupt unless:

- The configured playlist is actively playing on the selected device.
- Repeat is off. Shuffle may be on when Spotify's upcoming queue identifies one unambiguous next playlist item; ambiguous duplicate positions and non-playlist queue entries are rejected.
- When the current URI appears in the playlist, it constrains position matching. If Spotify reports a relinked/alternate current URI, the upcoming queue must independently identify one unambiguous playlist continuation.
- The upcoming queue matches the playlist continuation.
- The Spotify upcoming queue can be matched unambiguously to the playlist's playable entries. Unavailable/local entries retain their playlist positions as placeholders; unsupported queue entries, duplicate-position ambiguity, or a queue that does not match are rejected.

After the viewer FIFO is exhausted, it restores the playlist at the saved next offset. If Spotify has already returned to that exact next item, it leaves playback alone. A moderator skip starts the next viewer request directly; it does not call Spotify's skip-next endpoint, which could skip a playlist track.

If the device changes or unrelated manual playback is detected, the controller stops taking over, preserves unplayed requests, and enters handoff mode. It never pauses or rewrites the user's playlist.

**Important limitation:** Spotify does not expose the active playlist offset directly, and API success responses do not prove the intended item is playing. This controller infers the position using the playlist items and upcoming queue, verifies the actual track after commands, and restores by playlist context plus offset. The live Spotify interruption/request/skip/restoration E2E sequence has passed on the configured Premium account and Connect device. Browser throttling or loss of the active tab can still delay polling enough to affect transition timing and remains a separate validation item.

Spotify's platform terms prohibit broadcasting Spotify content and synchronizing sound recordings with visual media. This app remains headless and has no audio or visual rendering path; it must not be used to pipe Spotify audio into a broadcast or to synchronize Spotify recordings with an overlay.

## Live-account E2E test environment

The local E2E runner uses the same Twitch/Spotify OAuth implementations and the real Spotify Web API/Connect device. It serves the application only on `127.0.0.1`; the generated browser config contains public client IDs and test settings only. **Do not put Twitch or Spotify client secrets, access tokens, refresh tokens, or authorization codes in `.env.e2e`.** The runner ignores secret/token environment variables rather than forwarding them.

1. Copy `.env.e2e.example` to `.env.e2e`.
2. Set `TWITCH_CLIENT_ID`, `SPOTIFY_CLIENT_ID`, `E2E_TRACK_X`, and `E2E_TRACK_Y`. Use two different Spotify track URIs or URLs for X and Y. `SPOTIFY_PLAYLIST_URI` is optional: set it to select a fixed playlist, or leave it blank to use the currently loaded Spotify playlist. Optional broadcaster, Power-up, and Connect device IDs can also be set.
3. Add the exact redirect URI `http://127.0.0.1:4173/` to the Spotify app's redirect URI allowlist. Do not substitute `localhost`; Spotify's loopback redirect requires an explicit IP literal. The runner defaults to port 4173. If you change `PORT`, change `SPOTIFY_REDIRECT_URI` to the exact matching `http://127.0.0.1:PORT/` value.
4. Use a disposable browser profile. Start the test server with `npm run e2e:serve`, then open `http://127.0.0.1:4173/`.
5. Open the browser developer console and run `communityPlaylist.start()`. Complete Spotify PKCE authorization and the Twitch Device Code flow. These flows happen directly between the browser and their providers; the local server does not receive or persist OAuth tokens.
6. Make a Spotify Connect device available. The test loads the configured playlist if it is not the active context, or uses the current playlist context when `SPOTIFY_PLAYLIST_URI` is blank. It starts the playlist if paused, temporarily turns shuffle and repeat off, and restores their previous values after the test. It does not change playlist contents. Choose X and Y so neither is the current nor next playlist item.
7. Run `await communityPlaylist.e2e.preflight()`, then `await communityPlaylist.e2e.runPlaybackSequence()`.
8. Run `await communityPlaylist.e2e.verifyProviderTokenRefresh()` to force both providers through their real refresh-token flow, and `await communityPlaylist.e2e.verifyEventSubReconnect()` to deliberately disconnect EventSub and verify the replacement session has both subscriptions.

The Spotify Web API does not provide an endpoint to clear manually queued Spotify items. The harness clears only its isolated application request queue and leaves the Spotify playlist and manual Spotify queue untouched; preflight refuses to run when the upcoming queue cannot be matched safely to the playlist continuation.

The automated live sequence uses synthetic Twitch notification objects passed through the application's EventSub notification handler, so it does not spend Bits. It performs real Spotify track resolution and playback commands, checks that X then Y play, verifies that an unauthorized `!skip` is ignored, checks broadcaster `!skip`, confirms the playlist resumes at the exact saved next track, and verifies that the playlist items were not modified. This exercises the Spotify Connect device and coordinator, but it does not prove Twitch delivered a real notification. The refresh helper deliberately expires each OAuth session and verifies that Twitch refresh-token rotation and Spotify PKCE refresh both restore API access without printing credentials. The reconnect helper closes the active Twitch WebSocket, waits for a new session, and confirms that both expected subscriptions are enabled on it.

To validate actual Twitch EventSub delivery and chat moderation, run `await communityPlaylist.e2e.runRealChatSkipTest()`. The helper prepares synthetic X/Y requests through real Spotify playback, then prompts for `!skip` from an ordinary viewer followed by the broadcaster or a moderator. It checks that the viewer command has no effect, the authorized command advances X to Y, and the playlist is restored without mutation. To validate a genuine Custom Power-up redemption separately, run `await communityPlaylist.e2e.waitForRealRedemption()` and then redeem the configured Power-up on the broadcaster's channel. This is a real redemption and may spend Bits.

E2E mode uses separate `sessionStorage` token keys and a separate `localStorage` request queue. It is enabled only on the local `http://127.0.0.1` origin. The local server binds only to loopback, serves only the application JavaScript and HTML plus generated `config.local.js`, disables caching, and does not log request URLs. The `.env.e2e` file is ignored by Git. Do not share browser HAR files, profile directories, or console dumps containing OAuth codes or tokens.

If a test is interrupted after a Spotify command, the harness enters the coordinator's safe handoff mode and preserves remaining requests rather than blindly issuing another play or restore command. Inspect `communityPlaylist.status()` before using `communityPlaylist.resume()`.

## Live E2E through GitHub Actions

The live-account suite runs in a real headless Chromium browser on a GitHub-hosted runner. OAuth is initiated and completed by CI; only the provider approval itself requires you to interact with Twitch and Spotify. No provider access or refresh tokens are stored in repository secrets.

### One-time configuration

Register this exact Spotify redirect URI in the Spotify developer dashboard:

`http://127.0.0.1:4173/`

Add all non-secret configuration as repository **Actions variables**. This includes the Spotify track URIs: they identify public catalogue tracks and are passed into the browser test config, so storing them as secrets provides no protection. `SPOTIFY_CLIENT_ID` must also be a variable, not a secret, because GitHub masks secrets in the Spotify authorization link. Remove duplicate configuration entries from Actions Secrets:

- `TWITCH_CLIENT_ID`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_PLAYLIST_URI`
- `E2E_TRACK_X` and `E2E_TRACK_Y` (different Spotify track IDs, URIs, or URLs)
- Optional variables: `TWITCH_BROADCASTER_ID`, `TWITCH_POWER_UP_ID`, `SPOTIFY_DEVICE_ID`

For migration compatibility, the workflow also reads the legacy `TWITCH_CLIENT_ID` secret when the same Actions variable is absent; move it to Variables and remove the duplicate Secret when convenient. The long-term repository **Actions secret** needed by this workflow is `SPOTIFY_PKCE_HANDOFF_KEY`, a 32-byte random encryption key. It encrypts both the temporary PKCE verifier and the persistent OAuth refresh-token vault; it is not itself an OAuth credential. In PowerShell, generate it with:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
$rng.Dispose()
```

Do not add `TWITCH_ACCESS_TOKEN`, `SPOTIFY_ACCESS_TOKEN`, client secrets, or refresh tokens. CI obtains short-lived access tokens by refreshing the saved provider credentials. The refresh tokens are stored only in an AES-256-GCM encrypted Actions artifact; plaintext access tokens exist only in the ephemeral runner and browser session.

### Run the workflow

**First-time setup or reauthorization**

1. Select stage `authorize_spotify`. CI creates a PKCE verifier and displays a Spotify authorization link in the run summary. Open it and approve the requested scopes.
2. Spotify redirects to `http://127.0.0.1:4173/`. The page may fail to load; this is expected. **Copy the complete URL from the browser address bar, including the query string with both `code` and `state`.** It must look like `http://127.0.0.1:4173/?code=...&state=...`; keep `127.0.0.1`, port `4173`, and the trailing slash exactly as shown (do not substitute `localhost`), and do not copy only `http://127.0.0.1:4173/`.
3. Start the workflow again, select stage `run_live_test`, enter the numeric run ID from that exact `authorize_spotify` run in `spotify_auth_run_id`, and paste the complete redirect URL into `spotify_callback_url`. Treat the URL as a one-time credential: do not post it in issues, chats, or screenshots. Do this promptly because Spotify authorization codes are short-lived.
4. CI exchanges the Spotify code using the encrypted PKCE verifier. It then starts Twitch Device Code authorization. Open the Twitch activation URL shown in the Actions log/summary, enter the one-time code, and approve access using the broadcaster account.
5. CI saves both refresh tokens in an encrypted Actions artifact before running the playback tests. The next step is ready to use.

**Normal runs after setup**

1. Open **Actions → Live Twitch and Spotify E2E → Run workflow** and leave stage set to `run_live_test` (the default).
2. Leave `spotify_auth_run_id` and `spotify_callback_url` blank. CI downloads the latest unexpired encrypted OAuth vault, refreshes both access tokens, saves any rotated refresh tokens, and proceeds without opening either provider approval flow.
3. Before the playback sequence starts, make the target Spotify Connect device available. The harness loads/starts the configured playlist if needed; with `SPOTIFY_PLAYLIST_URI` blank, it uses the active Spotify playlist context. It saves shuffle/repeat, disables both for the test, and restores their original values afterwards. Playlist contents are never modified.

The provider approval steps are needed again only when a refresh token is revoked or invalid, required scopes change, or the encrypted artifact expires/is removed. To reauthorize, repeat the first-time steps. The Twitch Device Code flow starts automatically only when the saved Twitch credential cannot be reused.

The Spotify PKCE verifier is encrypted with AES-256-GCM in a one-day artifact. The persistent OAuth vault is separately encrypted with AES-256-GCM and stored in an Actions artifact using the repository's configured artifact-retention period. Both use the `SPOTIFY_PKCE_HANDOFF_KEY` secret, which never leaves Actions Secrets. The callback URL and provider tokens are masked in workflow logs. The vault contains refresh tokens, scopes, and the Twitch account ID only; short-lived access tokens are not uploaded as artifacts or saved as Actions secrets. The encrypted artifact is readable by repository collaborators, but its contents cannot be used without the encryption key.

The default test performs live preflight, the synthetic-redemption X → Y playback sequence, unauthorized skip rejection, broadcaster skip, playlist restoration, playlist non-mutation checks, and Twitch EventSub reconnect verification. Synthetic redemption notifications do not spend Bits. Selecting `run_real_chat_test` additionally waits for a real ordinary viewer `!skip` and then a broadcaster/moderator `!skip` in Twitch chat. It does not perform a real Custom Power-up redemption.

This is a live integration test, not a hermetic test: it changes playback on the configured Spotify Connect device. If a test fails after playback takeover, inspect Spotify and restore the playlist manually before retrying. Only one live run controls the device at a time.

## Releases and deployment

Tagged releases are verified and packaged automatically by GitHub Actions. The release ZIP contains the static application and setup documentation; no build or server-side runtime is required. See [release, deployment, and rollback instructions](docs/releasing.md).

## Hosted authorization and OBS setup

The hosted signup flow removes per-user configuration files and browser-console setup. The Node.js authorization service stores Twitch and Spotify refresh credentials encrypted on its persistent Docker volume, then generates a private OBS Browser Source URL. The URL carries the refresh credentials in its fragment; the static overlay consumes them and then runs independently of the Docker service.

See [hosted authorization and OBS setup](docs/authorization-and-obs-setup.md) for the user flow, service deployment, OAuth redirect configuration, and URL security warning. The completion page deliberately hides the URL and exposes it only through COPY. Never share the generated URL publicly.

## Development

There are no dependencies to install. Run:

\`\`\`sh
npm run check
npm test
npm run verify
\`\`\`

See [the roadmap issue](https://github.com/mintymelinda/community_playlist/issues/1) and [technical validation notes](docs/technical-validation.md) for the remaining real-account/device verification.


Playback confirmation: after Spotify accepts a play command, the coordinator polls current playback state for up to 20 seconds before declaring the request unconfirmed. It requires both the exact requested track URI and the target Connect device; stale player-state reads do not immediately fail playback.
